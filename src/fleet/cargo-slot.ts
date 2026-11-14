// A heavy-build slot for a cargo that bypassed toli's cargo shim (src/fleet/build-slots.ts): something put another
// cargo ahead of the shim on PATH (a login profile, a harness's shell snapshot, git's exec path in a hook). toli's
// rustc wrapper (bin/shims/toli-rustc-wrapper, a jawan's `RUSTC_WRAPPER`, src/jawans/env.ts) runs on such a cargo's
// `rustc -vV` probe, outside any slot, as `bin/toli build-slot --cargo <cargo pid>`: it starts a detached holder
// (`build-slot --hold <cargo pid> --cwd <its directory>`) that waits in line, takes a slot for that cargo (recording
// that directory and the cargo's CARGO_TARGET_DIR for the disk keeper) and writes
// state/build-slots/cargo-<pid>.held, and returns once it holds. Only the probe waits: cargo runs it before it takes
// its build folder's lock, and a later rustc call that waited for a slot under that lock would deadlock with a build
// in the slot waiting for the lock. The wrapper finds the holder of later rustc calls (of that cargo, of a cargo it
// starts, of its build scripts) through the process ancestry. The holder frees the slot once the cargo exits or is
// killed, and a killed holder frees it with its flock.
import { spawn as spawnChild } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, join, resolve } from "node:path";
import { hasMachine, loadMachine, type Machine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { pidAlive, run, warn, writeTextAtomic } from "../core/util.ts";
import { buildsOutsideSlots, busyBuildSlots, POLL_MS, slotHolder, takeInTurn } from "./build-queue.ts";
import { FORWARDED_SIGNALS, liveStackProjectAt, resumeDevStacksWhenIdle } from "./build-slots.ts";
import { type Flock, flock, LOCK_EX, LOCK_NB, LOCK_UN } from "./cargo-lock.ts";
import { pauseLiveStacks, resumeLiveStacks } from "./live-stack-pause.ts";
import { heldFile, holderHolds } from "./outside-builds.ts";
import { capacityFor } from "./resources.ts";
import { pauseDevStacks } from "./stack-pause.ts";

/** This checkout's CLI (not paths.toliBin(): TOLI_ROOT may point the data elsewhere, as in tests). */
const TOLI_SCRIPT = resolve(import.meta.dir, "..", "..", "bin", "toli");
/** How often a cargo's `rustc -vV` probe looks again for the holder of its slot. */
const HOLDER_POLL_MS = 100;
/** Flocked by the one holder of a cargo's slot while it waits for and holds it. */
const claimFile = (cargoPid: number): string => join(paths.buildSlotsDir(), `cargo-${cargoPid}.claim`);
const HOLDER_FILE = /^cargo-(\d+)\.(held|claim)$/;

/** The heavy cargo commands, the same list as bin/shims/cargo's: they run in a slot, every other one runs at once. */
const HEAVY_CARGO: Readonly<Record<string, true>> = {
    build: true,
    b: true,
    check: true,
    c: true,
    test: true,
    t: true,
    clippy: true,
    nextest: true,
    run: true,
    r: true,
    bench: true,
    doc: true,
    d: true,
    install: true,
    rustc: true,
    rustdoc: true,
};
/** Cargo's global options that take a value, skipped when looking for the subcommand. */
const CARGO_VALUE_OPTIONS: Readonly<Record<string, true>> = {
    "--color": true,
    "--config": true,
    "--explain": true,
    "-C": true,
    "-Z": true,
};

/** Whether a cargo command line runs a heavy command: its first word that is not `+toolchain` or a global option. */
function heavyCargo(argv: string[]): boolean {
    for (let i = 1; i < argv.length; i++) {
        const arg = argv[i] as string;
        if (arg === "--") return false;
        if (Object.hasOwn(CARGO_VALUE_OPTIONS, arg)) i++;
        else if (!arg.startsWith("+") && !arg.startsWith("-")) return Object.hasOwn(HEAVY_CARGO, arg);
    }
    return false;
}

/** A process's command line as `ps` reports it, split on spaces; empty when it is gone. */
function processArgv(pid: number): string[] {
    const result = run(["ps", "-ww", "-o", "args=", "-p", String(pid)], { timeoutMs: 5000 });
    const line = result.code === 0 ? result.stdout.trim() : "";
    return line === "" ? [] : line.split(/\s+/);
}

/** A process's parent pid, or 0 when it is gone. */
function parentPid(pid: number): number {
    const result = run(["ps", "-o", "ppid=", "-p", String(pid)], { timeoutMs: 5000 });
    const ppid = result.code === 0 ? Number(result.stdout.trim()) : 0;
    return Number.isInteger(ppid) ? ppid : 0;
}

/**
 * The cargo whose run a slot is for: `cargoPid` when it runs a heavy command, climbing through each parent that is a
 * cargo (or a cargo subcommand binary) running a heavy command too, so the slot spans the outer command's whole run:
 * `cargo nextest run` (cargo-nextest) runs `cargo test --no-run` and then the test binaries itself, which a slot held
 * only for the inner cargo would leave outside. Null when `cargoPid` runs no heavy command. The cargo binary itself,
 * or an interpreter running a cargo script (`/bin/sh /path/to/cargo build`).
 */
function heavyCargoRun(cargoPid: number): number | null {
    let chosen: number | null = null;
    for (let pid = cargoPid, depth = 0; pid > 1 && depth < 16; pid = parentPid(pid), depth++) {
        const argv = processArgv(pid);
        const at = argv.slice(0, 2).findIndex((word) => /^cargo(-[\w-]+)?$/.test(basename(word)));
        if (at < 0 || !heavyCargo(argv.slice(at))) break;
        chosen = pid;
    }
    return chosen;
}

/** Whether some process flocks `cargoPid`'s claim file: a holder waiting for or holding its slot. */
function claimed(cargoPid: number, lock: Flock): boolean {
    let fd: number;
    try {
        fd = openSync(claimFile(cargoPid), "r");
    } catch {
        return false;
    }
    try {
        if (lock(fd, LOCK_EX | LOCK_NB) !== 0) return true;
        lock(fd, LOCK_UN);
        return false;
    } finally {
        closeSync(fd);
    }
}

/** Remove the held and claim files of holders that are gone (a SIGKILLed holder cannot remove its own). */
function sweepHolderFiles(lock: Flock): void {
    for (const name of readdirSync(paths.buildSlotsDir())) {
        const match = HOLDER_FILE.exec(name);
        if (match === null) continue;
        const cargoPid = Number(match[1]);
        const stale = match[2] === "held" ? !holderHolds(cargoPid) : !claimed(cargoPid, lock) && !pidAlive(cargoPid);
        if (stale) rmSync(join(paths.buildSlotsDir(), name), { force: true });
    }
}

/**
 * `bin/toli build-slot --hold <cargo pid> --cwd <dir>` (detached, started by `slotForCargo`): the one holder of that
 * cargo's slot, recorded as building in `cwd` into this environment's CARGO_TARGET_DIR (the cargo's, inherited). It
 * waits in line, holds the slot while the cargo lives and frees it once the cargo exits, or when it is itself stopped,
 * however (a flock dies with its process).
 */
export async function holdForCargo(cargoPid: number, cwd: string): Promise<number> {
    const lock = flock();
    if (lock === null) return 1;
    mkdirSync(paths.buildSlotsDir(), { recursive: true });
    const claimFd = openSync(claimFile(cargoPid), "a");
    if (lock(claimFd, LOCK_EX | LOCK_NB) !== 0) {
        closeSync(claimFd); // Another holder has it.
        return 0;
    }
    sweepHolderFiles(lock);
    const machine: Machine = hasMachine() ? loadMachine() : { name: "", role: "coordinator" };
    const capacity = capacityFor(machine, availableParallelism());
    const held = await takeInTurn(capacity.buildSlots, lock, slotHolder(cwd), cargoPid, () => pidAlive(cargoPid));
    const release = (): void => {
        rmSync(heldFile(cargoPid), { force: true });
        if (held !== null) {
            lock(held.fd, LOCK_UN);
            closeSync(held.fd);
            resumeLiveStacks();
            resumeDevStacksWhenIdle();
        }
        rmSync(claimFile(cargoPid), { force: true });
        closeSync(claimFd);
    };
    if (held === null) {
        release();
        return 0;
    }
    for (const signal of FORWARDED_SIGNALS)
        process.on(signal, () => {
            release();
            process.exit(0);
        });
    pauseDevStacks();
    pauseLiveStacks();
    writeTextAtomic(heldFile(cargoPid), `${process.pid} ${held.index + 1}\n`);
    while (pidAlive(cargoPid)) await Bun.sleep(POLL_MS);
    release();
    return 0;
}

/**
 * `bin/toli build-slot --cargo <cargo pid>` (bin/shims/toli-rustc-wrapper, on a cargo's `rustc -vV` probe outside any
 * slot): when that cargo runs a heavy command outside a live-stack project's checkout, return only once a holder
 * (`holdForCargo`) holds a slot for its run (`heavyCargoRun`), starting one when none is waiting, and saying once that
 * it waits. Any other cargo returns at once. Never fails: a build runs even when toli cannot take a slot for it.
 */
export async function slotForCargo(probingCargo: number): Promise<number> {
    const cargoPid = heavyCargoRun(probingCargo);
    if (cargoPid === null) return 0;
    if (liveStackProjectAt(process.cwd()) !== null) return 0;
    const lock = flock();
    if (lock === null) return 0; // The shim's `build-slot` says so; every rustc call need not.
    mkdirSync(paths.buildSlotsDir(), { recursive: true });
    const machine: Machine = hasMachine() ? loadMachine() : { name: "", role: "coordinator" };
    const slots = capacityFor(machine, availableParallelism()).buildSlots;
    let told = false;
    while (pidAlive(cargoPid) && !holderHolds(cargoPid)) {
        if (!claimed(cargoPid, lock)) {
            const holder = spawnChild(
                process.execPath,
                [TOLI_SCRIPT, "build-slot", "--hold", String(cargoPid), "--cwd", process.cwd()],
                { cwd: paths.root(), detached: true, stdio: "ignore" },
            );
            holder.unref();
        }
        await Bun.sleep(HOLDER_POLL_MS);
        if (!told && !holderHolds(cargoPid) && busyBuildSlots() + buildsOutsideSlots(cargoPid).length >= slots) {
            warn(`toli: waiting for a heavy-build slot (${slots} busy)`);
            told = true;
        }
    }
    return 0;
}
