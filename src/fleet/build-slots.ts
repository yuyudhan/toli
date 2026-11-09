// Heavy-build slots: at most `capacity.buildSlots` heavy commands (cargo build, test, clippy, ...) run at once on this
// machine, each with `capacity.cargoJobs` compile jobs, so together they use about every core; the rest wait their
// turn. A slot is a flock(2) on state/build-slots/<n>.lock that `bin/toli build-slot` holds while its command runs,
// so a holder that dies, however it dies, frees its slot. Jawans reach it through the cargo shim in bin/shims, first
// on their PATH (src/jawans/env.ts).
import { closeSync, mkdirSync, openSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { Args } from "../core/args.ts";
import { hasMachine, loadMachine, type Machine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { ToliError, warn } from "../core/util.ts";
import { type Flock, flock, LOCK_EX, LOCK_NB, LOCK_UN } from "./cargo-lock.ts";
import { capacityFor } from "./resources.ts";

const POLL_MS = 500;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

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

/** Run `command` with this process's stdio plus `env`, passing termination signals on; resolves to its exit code. */
async function runInSlot(command: string[], env: Record<string, string>): Promise<number> {
    const [program, ...args] = command;
    if (program === undefined) throw new ToliError("usage: bin/toli build-slot -- <command...>");
    const resolved = program.includes("/") ? program : Bun.which(program, { PATH: process.env.PATH ?? "" });
    if (!resolved) {
        warn(`toli: ${program}: command not found`);
        return 127;
    }
    const child = Bun.spawn([resolved, ...args], {
        env: { ...process.env, ...env },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    });
    const handlers = FORWARDED_SIGNALS.map((signal) => [signal, () => child.kill(signal)] as const);
    for (const [signal, handler] of handlers) process.on(signal, handler);
    try {
        // A child ended by a signal resolves to 128 + its number, as a shell reports it.
        return await child.exited;
    } finally {
        for (const [signal, handler] of handlers) process.off(signal, handler);
    }
}

/**
 * `bin/toli build-slot -- <command...>`: run the command in a heavy-build slot with `CARGO_BUILD_JOBS` at one slot's
 * share and `TOLI_BUILD_SLOT` set, waiting (never failing) while every slot is busy. Inside a slot already
 * (`TOLI_BUILD_SLOT` set) it runs the command at once, so a nested build never waits on its own slot.
 */
export async function buildSlotCommand(argv: string[]): Promise<number> {
    const args = new Args(argv);
    args.maxPositional(0);
    const command = args.rest;
    if (command.length === 0) throw new ToliError("usage: bin/toli build-slot -- <command...>");
    if ((process.env.TOLI_BUILD_SLOT ?? "") !== "") return await runInSlot(command, {});
    // Readable before `init`: an uninitialised machine gets the default slots, never a failed build.
    const machine: Machine = hasMachine() ? loadMachine() : { name: "", role: "coordinator" };
    const capacity = capacityFor(machine, availableParallelism());
    const jobs = { CARGO_BUILD_JOBS: String(capacity.cargoJobs) };
    const lock = flock();
    if (lock === null) {
        warn("toli: flock(2) unavailable, running without a heavy-build slot");
        return await runInSlot(command, jobs);
    }
    let held = tryTake(capacity.buildSlots, lock);
    if (held === null) warn(`toli: waiting for a heavy-build slot (${capacity.buildSlots} busy)`);
    while (held === null) {
        await Bun.sleep(POLL_MS);
        held = tryTake(capacity.buildSlots, lock);
    }
    try {
        return await runInSlot(command, { ...jobs, TOLI_BUILD_SLOT: String(held.index + 1) });
    } finally {
        lock(held.fd, LOCK_UN);
        closeSync(held.fd);
    }
}
