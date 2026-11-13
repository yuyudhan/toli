// Heavy-build slots: at most `capacity.buildSlots` heavy commands (cargo build, test, clippy, ...) run at once on this
// machine, each with `capacity.cargoJobs` compile jobs, so together they use about every core; the rest wait their
// turn, first come first served. A slot is a flock(2) on state/build-slots/<n>.lock that `bin/toli build-slot` holds
// while its command runs, so a holder that dies, however it dies, frees its slot; the lock files themselves stay (one
// per slot number ever used), only their flock says a slot is busy. A waiter holds a numbered ticket in
// state/build-slots/queue/ (also a flock, so a waiter that dies leaves the line with it), and only the oldest live
// ticket may take a free slot. Jawans reach it through the cargo shim in bin/shims, first on their PATH
// (src/jawans/env.ts), and through toli's rustc wrapper (bin/shims/toli-rustc-wrapper, their `RUSTC_WRAPPER`), which
// catches a cargo that bypassed the shim: its first rustc call waits until a detached holder holds a slot for that
// cargo until it exits (src/fleet/cargo-slot.ts). A gate's runner (src/forge/gate.ts) and `bin/toli push` with a
// pre-push hook (src/forge/forge.ts) hold one for their whole run, so a project's push check gets one slot's share even
// when it calls cargo directly. On Linux with a user manager each build (and each such push check) runs in its own
// systemd scope capped at `capacity.buildMemoryMax` (src/jawans/scope.ts), so an OOM kill takes the build, not the
// session that started it. A project's dev containers that rebuild on save are paused while any slot is held
// (src/fleet/stack-pause.ts).
import { closeSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { join, sep } from "node:path";
import { Args } from "../core/args.ts";
import { hasMachine, loadMachine, type Machine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { ToliError, warn } from "../core/util.ts";
import { slotShareEnv } from "../jawans/env.ts";
import { type Argv, inBuildScope } from "../jawans/scope.ts";
import { loadProjects } from "../projects/projects.ts";
import { checkBuildPlace } from "./build-place.ts";
import { busyBuildSlots, slotWaiters, takeInTurn } from "./build-queue.ts";
import { flock, LOCK_UN } from "./cargo-lock.ts";
import { holdForCargo, slotForCargo } from "./cargo-slot.ts";
import { capacityFor } from "./resources.ts";
import { pauseDevStacks, resumeDevStacks } from "./stack-pause.ts";

export const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
/** The share of the RAM every build slot's default memory cap adds up to; the rest stays for the lead's session. */
const BUILD_MEMORY_SHARE = 0.75;
const MB = 1024 * 1024;

/**
 * Unpause the dev stacks a build paused (src/fleet/stack-pause.ts) once no command holds a slot and none waits for
 * one: called after a holder freed its slot, and by the minute tick for a stack a killed holder left paused.
 */
export function resumeDevStacksWhenIdle(slots: number): void {
    const lock = flock();
    if (lock === null) return;
    resumeDevStacks(() => busyBuildSlots(slots) === 0 && !slotWaiters(lock));
}

/**
 * `capacity.buildMemoryMax`: the MB each heavy build's scope may use (0: no cap). Default: `BUILD_MEMORY_SHARE` of
 * `totalMB` split evenly over the `buildSlots`, so every slot busy at its cap still leaves the lead room.
 */
export function buildMemoryMaxMB(machine: Machine, buildSlots: number, totalMB: number): number {
    const raw = machine.capacity?.buildMemoryMax;
    if (raw === undefined) return Math.floor((totalMB * BUILD_MEMORY_SHARE) / buildSlots);
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
        throw new ToliError("config/machine.json capacity.buildMemoryMax must be a non-negative integer (MB)");
    }
    return raw;
}

/** Where a build runs: its slot's number (0 without a slot) and its scope's memory cap in MB (0: none). */
export type BuildScope = { slot: number; memoryMaxMB: number };

/** What a command run in a slot gets: the variables to add to its environment, and its scope (null: none). */
export type HeldSlot = { env: Record<string, string>; scope: BuildScope | null };

/**
 * Spawn `argv` with this process's stdio plus `env`, passing termination signals on: its exit code (a child ended by
 * a signal resolves to 128 + its number, as a shell reports it) and whether a signal was passed on meanwhile.
 */
async function spawnForwarding(
    argv: string[],
    env: Record<string, string>,
): Promise<{ code: number; signalled: boolean }> {
    const child = Bun.spawn(argv, {
        env: { ...process.env, ...env },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    });
    let signalled = false;
    const handlers = FORWARDED_SIGNALS.map(
        (signal) =>
            [
                signal,
                () => {
                    signalled = true;
                    child.kill(signal);
                },
            ] as const,
    );
    for (const [signal, handler] of handlers) process.on(signal, handler);
    try {
        return { code: await child.exited, signalled };
    } finally {
        for (const [signal, handler] of handlers) process.off(signal, handler);
    }
}

/**
 * A command to start in a held slot's scope: the argv and extra environment to spawn, and `scopeFailed`, to ask once
 * it exited whether systemd-run never made the scope (so the command never ran).
 */
export type ScopeLaunch = { argv: Argv; env: Record<string, string>; scopeFailed: () => boolean };

/**
 * Start `argv` in its own systemd scope for `scope` where the host has one (src/jawans/scope.ts `inBuildScope`), else
 * unchanged. Inside the scope `/bin/sh` creates this process's `state/build-slots/scope-<pid>.started` marker and execs
 * the command; `scopeFailed` reads and removes it.
 */
export function launchInScope(scope: BuildScope | null, argv: Argv): ScopeLaunch {
    const unscoped: ScopeLaunch = { argv, env: {}, scopeFailed: () => false };
    if (scope === null) return unscoped;
    mkdirSync(paths.buildSlotsDir(), { recursive: true });
    const startedFile = join(paths.buildSlotsDir(), `scope-${process.pid}.started`);
    rmSync(startedFile, { force: true });
    const scoped = inBuildScope(scope.slot, scope.memoryMaxMB, argv, startedFile);
    if (scoped === null) return unscoped;
    return {
        argv: scoped.argv,
        env: scoped.env,
        scopeFailed: () => {
            const started = existsSync(startedFile);
            rmSync(startedFile, { force: true });
            return !started;
        },
    };
}

/** The one warning line before a command whose scope systemd-run could not make runs again without it. */
export function scopeFailedWarning(code: number): string {
    return `toli: systemd-run could not start the build's scope (exit ${code}), running it without a memory cap`;
}

/**
 * Run `command` with this process's stdio plus `env`, passing termination signals on; resolves to its exit code.
 * With `scope` it runs in its own systemd scope where the host has one (`launchInScope`). When systemd-run is there
 * but cannot make the scope (no user session bus over ssh, no lingering), the command never started: it runs once
 * more without a scope, after one warning line. A command that ran keeps its own exit code.
 */
export async function runInSlot(
    command: string[],
    env: Record<string, string>,
    scope: BuildScope | null,
): Promise<number> {
    const [program, ...args] = command;
    if (program === undefined) throw new ToliError("usage: bin/toli build-slot -- <command...>");
    const resolved = program.includes("/") ? program : Bun.which(program, { PATH: process.env.PATH ?? "" });
    if (!resolved) {
        warn(`toli: ${program}: command not found`);
        return 127;
    }
    const argv: Argv = [resolved, ...args];
    const launch = launchInScope(scope, argv);
    const run = await spawnForwarding(launch.argv, { ...launch.env, ...env });
    if (!launch.scopeFailed() || run.signalled) return run.code;
    warn(scopeFailedWarning(run.code));
    return (await spawnForwarding(argv, env)).code;
}

/** `path` with its symlinks resolved, or null when it does not exist. */
function realOrNull(path: string): string | null {
    try {
        return realpathSync(path);
    } catch {
        return null;
    }
}

/**
 * Whether `cwd` lies in a live-stack project's checkout (docs/projects.md "Live-stack mode"): the machine's one build
 * there is its running stack's, so a build started in it (a lead's native subagent's, through the shim) skips the
 * slots, as that project's `bin/toli spawn` jawans do by running without the shim.
 */
export function inLiveStackCheckout(cwd: string): boolean {
    const here = realOrNull(cwd);
    if (here === null) return false;
    return loadProjects().some((project) => {
        if (project.liveStack !== true) return false;
        const checkout = realOrNull(paths.projectDir(project.name));
        return checkout !== null && (here === checkout || here.startsWith(`${checkout}${sep}`));
    });
}

/**
 * Run `body` in a heavy-build slot, waiting (never failing) in arrival order while every slot is busy; `body` gets
 * `slotShareEnv` plus `TOLI_BUILD_SLOT` set to the slot's number, and the slot's scope. Inside a slot already
 * (`TOLI_BUILD_SLOT` set) it runs at once with nothing added, so a nested build never waits on its own slot; with
 * `cwd` in a live-stack project's checkout it runs at once without a slot or scope, still at one slot's share.
 */
export async function withBuildSlot<T>(cwd: string, body: (held: HeldSlot) => Promise<T>): Promise<T> {
    if ((process.env.TOLI_BUILD_SLOT ?? "") !== "") return await body({ env: {}, scope: null });
    // Readable before `init`: an uninitialised machine gets the default slots, never a failed build.
    const machine: Machine = hasMachine() ? loadMachine() : { name: "", role: "coordinator" };
    const capacity = capacityFor(machine, availableParallelism());
    const memoryMaxMB = buildMemoryMaxMB(machine, capacity.buildSlots, Math.floor(totalmem() / MB));
    const share: Record<string, string> = { ...slotShareEnv(process.env, capacity.cargoJobs) };
    if (inLiveStackCheckout(cwd)) return await body({ env: share, scope: null });
    const lock = flock();
    if (lock === null) {
        warn("toli: flock(2) unavailable, running without a heavy-build slot");
        return await body({ env: share, scope: { slot: 0, memoryMaxMB } });
    }
    const held = await takeInTurn(capacity.buildSlots, lock);
    if (held === null) throw new ToliError("toli: stopped waiting for a heavy-build slot");
    try {
        const slot = held.index + 1;
        pauseDevStacks();
        return await body({ env: { ...share, TOLI_BUILD_SLOT: String(slot) }, scope: { slot, memoryMaxMB } });
    } finally {
        lock(held.fd, LOCK_UN);
        closeSync(held.fd);
        resumeDevStacksWhenIdle(capacity.buildSlots);
    }
}

/** A pid flag's value: a positive integer. */
function pidFlag(value: string, flag: string): number {
    const pid = Number(value);
    if (!Number.isInteger(pid) || pid <= 0) throw new ToliError(`${flag} must be a pid, got "${value}"`);
    return pid;
}

/**
 * `bin/toli build-slot -- <command...>`: refuse a build outside the places toli knows (`checkBuildPlace`, AGENTS.md
 * rule 5), then run the command in a heavy-build slot (`withBuildSlot`), in its own memory-capped systemd scope where
 * the host has one; a nested one stays in its parent's scope. `--cargo <pid>` and `--hold <pid>` are toli's rustc
 * wrapper's (`slotForCargo`, `holdForCargo`).
 */
export async function buildSlotCommand(argv: string[]): Promise<number> {
    const args = new Args(argv, { values: ["cargo", "hold"] });
    args.maxPositional(0);
    const cargo = args.str("cargo");
    if (cargo !== undefined) return await slotForCargo(pidFlag(cargo, "--cargo"));
    const hold = args.str("hold");
    if (hold !== undefined) return await holdForCargo(pidFlag(hold, "--hold"));
    const command = args.rest;
    if (command.length === 0) throw new ToliError("usage: bin/toli build-slot -- <command...>");
    checkBuildPlace(process.cwd(), command);
    return await withBuildSlot(process.cwd(), ({ env, scope }) => runInSlot(command, env, scope));
}
