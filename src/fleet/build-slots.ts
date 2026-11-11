// Heavy-build slots: at most `capacity.buildSlots` heavy commands (cargo build, test, clippy, ...) run at once on this
// machine, each with `capacity.cargoJobs` compile jobs, so together they use about every core; the rest wait their
// turn. A slot is a flock(2) on state/build-slots/<n>.lock that `bin/toli build-slot` holds while its command runs,
// so a holder that dies, however it dies, frees its slot. Jawans reach it through the cargo shim in bin/shims, first
// on their PATH (src/jawans/env.ts). On Linux with a user manager each build runs in its own systemd scope capped at
// `capacity.buildMemoryMax` (src/jawans/scope.ts), so an OOM kill takes the build, not the session that started it.
import { closeSync, mkdirSync, openSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import { Args } from "../core/args.ts";
import { hasMachine, loadMachine, type Machine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { ToliError, warn } from "../core/util.ts";
import { inBuildScope } from "../jawans/scope.ts";
import { type Flock, flock, LOCK_EX, LOCK_NB, LOCK_UN } from "./cargo-lock.ts";
import { capacityFor } from "./resources.ts";

const POLL_MS = 500;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
/** The share of the RAM every build slot's default memory cap adds up to; the rest stays for the lead's session. */
const BUILD_MEMORY_SHARE = 0.75;
const MB = 1024 * 1024;

const slotFile = (index: number): string => join(paths.buildSlotsDir(), `${index + 1}.lock`);

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

/**
 * Run `command` with this process's stdio plus `env`, passing termination signals on; resolves to its exit code.
 * With `scope` it runs in its own systemd scope where the host has one (src/jawans/scope.ts `inBuildScope`).
 */
async function runInSlot(command: string[], env: Record<string, string>, scope: BuildScope | null): Promise<number> {
    const [program, ...args] = command;
    if (program === undefined) throw new ToliError("usage: bin/toli build-slot -- <command...>");
    const resolved = program.includes("/") ? program : Bun.which(program, { PATH: process.env.PATH ?? "" });
    if (!resolved) {
        warn(`toli: ${program}: command not found`);
        return 127;
    }
    const scoped =
        scope === null
            ? { argv: [resolved, ...args], env: {} }
            : inBuildScope(scope.slot, scope.memoryMaxMB, [resolved, ...args]);
    const child = Bun.spawn(scoped.argv, {
        env: { ...process.env, ...scoped.env, ...env },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    });
    const handlers = FORWARDED_SIGNALS.map((signal) => [signal, () => child.kill(signal)] as const);
    for (const [signal, handler] of handlers) process.on(signal, handler);
    try {
        // A child ended by a signal resolves to 128 + its number, as a shell reports it. systemd-run --scope execs
        // the command, so the child is the build itself either way.
        return await child.exited;
    } finally {
        for (const [signal, handler] of handlers) process.off(signal, handler);
    }
}

/**
 * `bin/toli build-slot -- <command...>`: run the command in a heavy-build slot with `CARGO_BUILD_JOBS` at one slot's
 * share and `TOLI_BUILD_SLOT` set, waiting (never failing) while every slot is busy, in its own memory-capped systemd
 * scope where the host has one. Inside a slot already (`TOLI_BUILD_SLOT` set) it runs the command at once and in its
 * parent's scope, so a nested build never waits on its own slot.
 */
export async function buildSlotCommand(argv: string[]): Promise<number> {
    const args = new Args(argv);
    args.maxPositional(0);
    const command = args.rest;
    if (command.length === 0) throw new ToliError("usage: bin/toli build-slot -- <command...>");
    if ((process.env.TOLI_BUILD_SLOT ?? "") !== "") return await runInSlot(command, {}, null);
    // Readable before `init`: an uninitialised machine gets the default slots, never a failed build.
    const machine: Machine = hasMachine() ? loadMachine() : { name: "", role: "coordinator" };
    const capacity = capacityFor(machine, availableParallelism());
    const memoryMaxMB = buildMemoryMaxMB(machine, capacity.buildSlots, Math.floor(totalmem() / MB));
    const jobs = { CARGO_BUILD_JOBS: String(capacity.cargoJobs) };
    const lock = flock();
    if (lock === null) {
        warn("toli: flock(2) unavailable, running without a heavy-build slot");
        return await runInSlot(command, jobs, { slot: 0, memoryMaxMB });
    }
    let held = tryTake(capacity.buildSlots, lock);
    if (held === null) warn(`toli: waiting for a heavy-build slot (${capacity.buildSlots} busy)`);
    while (held === null) {
        await Bun.sleep(POLL_MS);
        held = tryTake(capacity.buildSlots, lock);
    }
    try {
        const slot = held.index + 1;
        return await runInSlot(command, { ...jobs, TOLI_BUILD_SLOT: String(slot) }, { slot, memoryMaxMB });
    } finally {
        lock(held.fd, LOCK_UN);
        closeSync(held.fd);
    }
}
