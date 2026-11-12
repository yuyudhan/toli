// Heavy-build slots: at most `capacity.buildSlots` heavy commands (cargo build, test, clippy, ...) run at once on this
// machine, each with `capacity.cargoJobs` compile jobs, so together they use about every core; the rest wait their
// turn, first come first served. A slot is a flock(2) on state/build-slots/<n>.lock that `bin/toli build-slot` holds
// while its command runs, so a holder that dies, however it dies, frees its slot. A waiter holds a numbered ticket in
// state/build-slots/queue/ (also a flock, so a waiter that dies leaves the line with it), and only the oldest live
// ticket may take a free slot. Jawans reach it through the cargo shim in bin/shims, first on their PATH
// (src/jawans/env.ts); a gate's runner (src/forge/gate.ts) and `bin/toli push` with a pre-push hook (src/forge/forge.ts)
// hold one for their whole run, so a project's push check gets one slot's share even when it calls cargo directly.
// On Linux with a user manager each build runs in its own systemd scope capped at
// `capacity.buildMemoryMax` (src/jawans/scope.ts), so an OOM kill takes the build, not the session that started it.
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { join, sep } from "node:path";
import { Args } from "../core/args.ts";
import { hasMachine, loadMachine, type Machine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { ToliError, warn } from "../core/util.ts";
import { inBuildScope } from "../jawans/scope.ts";
import { loadProjects } from "../projects/projects.ts";
import { type Flock, flock, LOCK_EX, LOCK_NB, LOCK_UN } from "./cargo-lock.ts";
import { capacityFor } from "./resources.ts";

const POLL_MS = 500;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
/** The share of the RAM every build slot's default memory cap adds up to; the rest stays for the lead's session. */
const BUILD_MEMORY_SHARE = 0.75;
const MB = 1024 * 1024;

const slotFile = (index: number): string => join(paths.buildSlotsDir(), `${index + 1}.lock`);
const queueDir = (): string => join(paths.buildSlotsDir(), "queue");
const queueLockFile = (): string => join(paths.buildSlotsDir(), "queue.lock");
const TICKET = /^(\d+)\.wait$/;
const ticketFile = (seq: number): string => join(queueDir(), `${seq}.wait`);

/** A waiter's place in line: its number and the fd holding the flock on its ticket file. */
type Ticket = { seq: number; fd: number };

/**
 * Run `body` holding the queue lock, which every ticket taken, checked or left goes through, so a ticket is never
 * seen between its file's creation and its owner's flock on it.
 */
function withQueueLock<T>(lock: Flock, body: () => T): T {
    mkdirSync(queueDir(), { recursive: true });
    const fd = openSync(queueLockFile(), "a");
    try {
        if (lock(fd, LOCK_EX) !== 0) throw new ToliError(`toli: cannot lock ${queueLockFile()}`);
        return body();
    } finally {
        closeSync(fd);
    }
}

/** Join the line: the next number from the queue's counter, its ticket file created and flocked by this process. */
function takeTicket(lock: Flock): Ticket {
    return withQueueLock(lock, () => {
        const counter = join(queueDir(), "next");
        let text = "";
        try {
            text = readFileSync(counter, "utf8").trim();
        } catch {
            // No ticket taken yet on this machine: start at 0.
        }
        let seq = /^\d+$/.test(text) ? Number(text) : 0;
        for (;;) {
            const fd = openSync(ticketFile(seq), "a");
            if (lock(fd, LOCK_EX | LOCK_NB) === 0) {
                writeFileSync(counter, `${seq + 1}\n`);
                return { seq, fd };
            }
            // Only a lost counter makes a number repeat; a live owner keeps its ticket, this waiter takes the next.
            closeSync(fd);
            seq += 1;
        }
    });
}

/** Whether `ticket` is the oldest live one. A ticket ahead whose owner died (its flock is free) is removed. */
function firstInLine(ticket: Ticket, lock: Flock): boolean {
    return withQueueLock(lock, () => {
        const ahead = readdirSync(queueDir())
            .flatMap((name) => {
                const match = TICKET.exec(name);
                return match === null ? [] : [Number(match[1])];
            })
            .filter((seq) => seq < ticket.seq)
            .sort((a, b) => a - b);
        for (const seq of ahead) {
            let fd: number;
            try {
                fd = openSync(ticketFile(seq), "r");
            } catch {
                continue; // Left the line meanwhile.
            }
            const dead = lock(fd, LOCK_EX | LOCK_NB) === 0;
            if (dead) unlinkSync(ticketFile(seq));
            closeSync(fd);
            if (!dead) return false;
        }
        return true;
    });
}

/** Leave the line: the ticket file removed and its flock released. */
function leaveLine(ticket: Ticket, lock: Flock): void {
    withQueueLock(lock, () => {
        unlinkSync(ticketFile(ticket.seq));
        closeSync(ticket.fd);
    });
}

/** Wait in line for a free slot, first come first served; prints the waiting line once if it has to wait. */
async function takeInTurn(slots: number, lock: Flock): Promise<{ index: number; fd: number }> {
    const ticket = takeTicket(lock);
    try {
        let told = false;
        for (;;) {
            const held = firstInLine(ticket, lock) ? tryTake(slots, lock) : null;
            if (held !== null) return held;
            if (!told) warn(`toli: waiting for a heavy-build slot (${slots} busy)`);
            told = true;
            await Bun.sleep(POLL_MS);
        }
    } finally {
        leaveLine(ticket, lock);
    }
}

/** Take a free slot without waiting: its index and the fd holding it, or null when every slot is busy. */
function tryTake(slots: number, lock: Flock): { index: number; fd: number } | null {
    mkdirSync(paths.buildSlotsDir(), { recursive: true });
    for (let index = 0; index < slots; index++) {
        const fd = openSync(slotFile(index), "a");
        if (lock(fd, LOCK_EX | LOCK_NB) === 0) return { index, fd };
        closeSync(fd);
    }
    return null;
}

/** How many of the first `slots` build slots a command holds right now (0 where flock is unavailable). */
export function busyBuildSlots(slots: number): number {
    const lock = flock();
    if (lock === null) return 0;
    let busy = 0;
    for (let index = 0; index < slots; index++) {
        let fd: number;
        try {
            fd = openSync(slotFile(index), "r");
        } catch {
            continue; // Never taken yet: free.
        }
        if (lock(fd, LOCK_EX | LOCK_NB) === 0) lock(fd, LOCK_UN);
        else busy += 1;
        closeSync(fd);
    }
    return busy;
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
type BuildScope = { slot: number; memoryMaxMB: number };

/** What a command run in a slot gets: the variables to add to its environment, and its scope (null: none). */
export type HeldSlot = { env: Record<string, string>; scope: BuildScope | null };

/** The test harnesses' thread variables: capped at one slot's share like the compile jobs, unless already set. */
const TEST_THREAD_VARS = ["RUST_TEST_THREADS", "NEXTEST_TEST_THREADS"] as const;

/**
 * One slot's share of the cores for a heavy command: `CARGO_BUILD_JOBS` at `cargoJobs` (always: one setting per
 * machine), and `RUST_TEST_THREADS` / `NEXTEST_TEST_THREADS` at the same number where the caller has not set them, so
 * `cargo test` and nextest never run a test per core either. Cargo reads them from the environment however it was
 * reached (the shim, or a `just` recipe calling the real cargo directly).
 */
function slotShareEnv(cargoJobs: number): Record<string, string> {
    const env: Record<string, string> = { CARGO_BUILD_JOBS: String(cargoJobs) };
    for (const name of TEST_THREAD_VARS) if ((process.env[name] ?? "") === "") env[name] = String(cargoJobs);
    return env;
}

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
 * Run `command` with this process's stdio plus `env`, passing termination signals on; resolves to its exit code.
 * With `scope` it runs in its own systemd scope where the host has one (src/jawans/scope.ts `inBuildScope`). When
 * systemd-run is there but cannot make the scope (no user session bus over ssh, no lingering), the build never
 * started: it runs once more without a scope, after one warning line. A build that ran keeps its own exit code.
 */
async function runInSlot(command: string[], env: Record<string, string>, scope: BuildScope | null): Promise<number> {
    const [program, ...args] = command;
    if (program === undefined) throw new ToliError("usage: bin/toli build-slot -- <command...>");
    const resolved = program.includes("/") ? program : Bun.which(program, { PATH: process.env.PATH ?? "" });
    if (!resolved) {
        warn(`toli: ${program}: command not found`);
        return 127;
    }
    const argv: [string, ...string[]] = [resolved, ...args];
    if (scope === null) return (await spawnForwarding(argv, env)).code;
    mkdirSync(paths.buildSlotsDir(), { recursive: true });
    const startedFile = join(paths.buildSlotsDir(), `scope-${process.pid}.started`);
    rmSync(startedFile, { force: true });
    const scoped = inBuildScope(scope.slot, scope.memoryMaxMB, argv, startedFile);
    if (scoped === null) return (await spawnForwarding(argv, env)).code;
    const run = await spawnForwarding(scoped.argv, { ...scoped.env, ...env });
    const started = existsSync(startedFile);
    rmSync(startedFile, { force: true });
    if (started || run.signalled) return run.code;
    warn(`toli: systemd-run could not start the build's scope (exit ${run.code}), running it without a memory cap`);
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
function inLiveStackCheckout(cwd: string): boolean {
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
    const share = slotShareEnv(capacity.cargoJobs);
    if (inLiveStackCheckout(cwd)) return await body({ env: share, scope: null });
    const lock = flock();
    if (lock === null) {
        warn("toli: flock(2) unavailable, running without a heavy-build slot");
        return await body({ env: share, scope: { slot: 0, memoryMaxMB } });
    }
    const held = await takeInTurn(capacity.buildSlots, lock);
    try {
        const slot = held.index + 1;
        return await body({ env: { ...share, TOLI_BUILD_SLOT: String(slot) }, scope: { slot, memoryMaxMB } });
    } finally {
        lock(held.fd, LOCK_UN);
        closeSync(held.fd);
    }
}

/**
 * `bin/toli build-slot -- <command...>`: run the command in a heavy-build slot (`withBuildSlot`), in its own
 * memory-capped systemd scope where the host has one; a nested one stays in its parent's scope.
 */
export async function buildSlotCommand(argv: string[]): Promise<number> {
    const args = new Args(argv);
    args.maxPositional(0);
    const command = args.rest;
    if (command.length === 0) throw new ToliError("usage: bin/toli build-slot -- <command...>");
    return await withBuildSlot(process.cwd(), ({ env, scope }) => runInSlot(command, env, scope));
}
