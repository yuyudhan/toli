// The disk keeper's own files and processes (src/fleet/disk.ts): logs/disk.log, its lock state/disk-keep.lock, the
// pause marker state/disk-keep.pause, and the background keeper, which the minute tick leaves all of the keeping to.
// Each is handled so that a full disk never stops the keeper: log lines wait in memory until it has freed something,
// a lock it cannot write is done without, and no failed write throws.
import { spawn as spawnChild } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, resolve } from "node:path";
import { loadMachine, type Machine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, pidAlive } from "../core/util.ts";
import { capacityFor, diskKeepFloor, measureVolume } from "./resources.ts";

export const KEEPER_LOCK = "disk-keep";
/** How long the background keeper waits for busy builds to pause before it gives up on a target (tier 5). */
const BACKGROUND_LOCK_WAIT_MS = 30 * 60_000;
/** This checkout's CLI (not paths.toliBin(): TOLI_ROOT may point the data elsewhere, as in tests). */
const TOLI_SCRIPT = resolve(import.meta.dir, "..", "..", "bin", "toli");

/** GB with one decimal, as every keeper line prints sizes. */
export const gb = (value: number): string => `${value.toFixed(1)} GB`;
export const GIB = 1024 ** 3;

export const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The machine's floor on a volume of `totalGB`: capacity.diskKeepGB, capped by diskKeepFloor. */
export function machineFloor(machine: Machine, totalGB: number): { floorGB: number; note?: string } {
    return diskKeepFloor(capacityFor(machine, Math.max(1, cpus().length)).diskKeepGB, totalGB);
}

/** How the keeper lock went: claimed for this pid, held by a live keeper, or not writable (a full disk). */
export type Claim = { kind: "claimed" } | { kind: "held"; pid: number } | { kind: "unwritable"; reason: string };

/**
 * Claim the keeper lock for this pid. A lock file that cannot be written or read (a full disk refuses even a pid) is
 * `unwritable`: the keeper then runs without it, since a second keeper deleting alongside costs nothing but a wasted
 * try, and a keeper that never runs on a full disk costs every build.
 */
export function claimKeeper(): Claim {
    const file = paths.lock(KEEPER_LOCK);
    const pid = String(process.pid);
    /** A write that failed part way leaves an empty or truncated pid of ours behind; it must not look like a holder. */
    const unwritable = (error: unknown): Claim => {
        try {
            if (pid.startsWith(readFileSync(file, "utf8"))) rmSync(file, { force: true });
        } catch {
            // Not a file of ours to remove.
        }
        return { kind: "unwritable", reason: describe(error) };
    };
    try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, pid, { flag: "wx" });
        return { kind: "claimed" };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return unwritable(error);
    }
    let holder: number;
    try {
        holder = Number(readFileSync(file, "utf8").trim());
    } catch (error) {
        return { kind: "unwritable", reason: describe(error) };
    }
    if (pidAlive(holder)) return { kind: "held", pid: holder };
    try {
        writeFileSync(file, pid);
        return { kind: "claimed" };
    } catch (error) {
        return unwritable(error);
    }
}

/** Drop the keeper lock if this pid holds it. */
export function releaseKeeper(): void {
    const file = paths.lock(KEEPER_LOCK);
    try {
        if (readFileSync(file, "utf8").trim() === String(process.pid)) rmSync(file, { force: true });
    } catch {
        // Already gone.
    }
}

/** The live pid in the keeper lock, or null when no keeper runs (no lock, an unreadable one, a dead pid). */
function keeperHolder(): number | null {
    try {
        const holder = Number(readFileSync(paths.lock(KEEPER_LOCK), "utf8").trim());
        return Number.isInteger(holder) && holder > 0 && pidAlive(holder) ? holder : null;
    } catch {
        return null;
    }
}

/** A pause marker older than this (file mtime) no longer pauses, even while its pid lives; a long job re-touches it. */
export const PAUSE_EXPIRY_MS = 2 * 60 * 60_000;

/** The pause marker's pid, reason and mtime, or null when it is missing or unreadable. */
function readPause(): { pid: number; reason: string; mtimeMs: number } | null {
    try {
        const file = paths.diskKeepPause();
        const mtimeMs = statSync(file).mtimeMs;
        const [first = "", ...rest] = readFileSync(file, "utf8").trim().split(/\s+/);
        return { pid: Number(first), reason: rest.join(" "), mtimeMs };
    } catch {
        return null;
    }
}

const expiredPause = (mtimeMs: number): boolean => now().getTime() - mtimeMs > PAUSE_EXPIRY_MS;

/**
 * The pause marker state/disk-keep.pause: its first word is a pid, the rest of the file a free-text reason. Live pid
 * and touched within PAUSE_EXPIRY_MS: the keeper must not delete now. Missing, unreadable, naming a dead pid (stale)
 * or older than that (expired): no pause.
 */
export function diskPause(): { pid: number; reason: string } | null {
    const pause = readPause();
    if (pause === null || expiredPause(pause.mtimeMs) || !pidAlive(pause.pid)) return null;
    return { pid: pause.pid, reason: pause.reason };
}

/**
 * Remove an expired pause marker whose pid is still alive, so its expiry is logged once; returns that pid, or null
 * when there is none. A marker touched again since it was read stays. A dead pid's marker is merely stale: left alone.
 */
export function expirePause(): number | null {
    const pause = readPause();
    if (pause === null || !expiredPause(pause.mtimeMs) || !pidAlive(pause.pid)) return null;
    try {
        if (statSync(paths.diskKeepPause()).mtimeMs !== pause.mtimeMs) return null;
        rmSync(paths.diskKeepPause(), { force: true });
    } catch {
        // Gone meanwhile, or not removable (a full disk keeps the file): diskPause ignores it either way.
    }
    return pause.pid;
}

/**
 * logs/disk.log for one keeper run. Until `open()` (the keeper has freed something, or will free nothing: a dry run, a
 * skip) lines wait in memory, since on a full disk the very first write would fail. A failed write keeps its lines for
 * the next try and never stops the keeper.
 */
export class DiskLog {
    private readonly pending: string[] = [];
    private live = false;

    constructor(private readonly dryRun: boolean) {}

    /** Write every line at once from now on. */
    open(): void {
        this.live = true;
        this.flush();
    }

    add(line: string): void {
        this.pending.push(`${now().toISOString()} ${this.dryRun ? "[dry run] " : ""}${line}\n`);
        if (this.live) this.flush();
    }

    /** Write the waiting lines: null once written, else why they could not be (they stay waiting). */
    flush(): string | null {
        if (this.pending.length === 0) return null;
        try {
            mkdirSync(paths.logsDir(), { recursive: true });
            appendFileSync(paths.diskLog(), this.pending.join(""));
            this.pending.length = 0;
            return null;
        } catch (error) {
            return `${this.pending.length} lines not written to logs/disk.log: ${describe(error)}`;
        }
    }
}

/**
 * Start `bin/toli disk keep --wait` detached (its lines reach logs/disk.log), to wipe busy targets as builds pause.
 * Bun's transpiler cache is off for it, as `bin/toli disk` does: the disk may still be full.
 */
export function startBackgroundKeeper(): void {
    let log: number | "ignore" = "ignore";
    try {
        mkdirSync(paths.logsDir(), { recursive: true });
        log = openSync(paths.diskLog(), "a");
    } catch {
        // A full disk: the keeper's own lines still reach logs/disk.log once it has freed something.
    }
    try {
        const child = spawnChild(
            process.execPath,
            [TOLI_SCRIPT, "disk", "keep", "--wait", String(BACKGROUND_LOCK_WAIT_MS / 60_000)],
            {
                cwd: paths.root(),
                detached: true,
                stdio: ["ignore", "ignore", log],
                env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
            },
        );
        child.unref();
    } finally {
        if (log !== "ignore") closeSync(log);
    }
}

/**
 * The minute tick's keeper: it only reads free disk (one `df`) and, under the floor, starts the background keeper,
 * which runs every tier (the last resort included) with the usual rules. The tick never waits on a deletion, which on
 * an I/O-starved disk can take an hour. Nothing starts while a keeper runs or a pause holds it; when free disk cannot
 * be read the background keeper starts anyway (it falls back to sweeping). A dry run starts nothing. Never throws.
 */
export function keepDiskDetached(dryRun: boolean): string | null {
    let why: string;
    try {
        const volume = measureVolume(paths.root());
        if (typeof volume === "string") why = `cannot read free disk (${volume})`;
        else {
            const { floorGB } = machineFloor(loadMachine(), volume.totalGB);
            if (volume.freeGB >= floorGB || keeperHolder() !== null || diskPause() !== null) return null;
            why = `free ${gb(volume.freeGB)} < floor ${gb(floorGB)}`;
        }
    } catch (error) {
        why = describe(error);
    }
    if (dryRun) return `disk keeper: ${why}: would start in the background (dry run)`;
    try {
        startBackgroundKeeper();
    } catch (error) {
        return `disk keeper: ${why}; background keeper not started: ${describe(error)}`;
    }
    return `disk keeper: ${why}: started in the background, so the tick does not wait on it (logs/disk.log)`;
}
