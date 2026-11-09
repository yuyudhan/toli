// The disk keeper's own files (src/fleet/disk.ts): logs/disk.log, its lock state/disk-keep.lock and the pause marker
// state/disk-keep.pause. Each is handled so that a full disk never stops the keeper: log lines wait in memory until
// it has freed something, a lock it cannot write is done without, and no failed write throws.
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../core/paths.ts";
import { now, pidAlive } from "../core/util.ts";

export const KEEPER_LOCK = "disk-keep";

/** GB with one decimal, as every keeper line prints sizes. */
export const gb = (value: number): string => `${value.toFixed(1)} GB`;
export const GIB = 1024 ** 3;

export const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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

/**
 * The pause marker state/disk-keep.pause: its first word is a pid, the rest of the file a free-text reason. Live pid:
 * the keeper must not delete now. Missing, unreadable, or naming a dead pid (stale): no pause.
 */
export function diskPause(): { pid: number; reason: string } | null {
    let text: string;
    try {
        text = readFileSync(paths.diskKeepPause(), "utf8").trim();
    } catch {
        return null;
    }
    const [first = "", ...rest] = text.split(/\s+/);
    const pid = Number(first);
    return pidAlive(pid) ? { pid, reason: rest.join(" ") } : null;
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
