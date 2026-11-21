import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { pidAlive, run, writeJsonAtomic } from "./util.ts";

/**
 * Slack for `ps`'s whole-second elapsed time: a holder that wrote its file within a second of starting may look up
 * to a second younger than it is. A pid reused after a reboot started long after its file was written.
 */
const ELAPSED_SLACK_MS = 2_000;

/** `ps -o etime=`'s `[[dd-]hh:]mm:ss` in ms; NaN when it is not that. */
function elapsedMs(text: string): number {
    const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text);
    if (match === null) return Number.NaN;
    const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0));
    return ((((days ?? 0) * 24 + (hours ?? 0)) * 60 + (minutes ?? 0)) * 60 + (seconds ?? 0)) * 1000;
}

type ProcessInfo = { startMs: number; command: string };

/**
 * When `pid` started (ms since the epoch, to the second) and its command line; "absent" when ps lists no such process
 * (on Linux a thread's id answers a liveness probe yet is no process ps lists), null when ps cannot say. The elapsed
 * time, not `lstart`, so no time zone comes into it.
 */
function processInfo(pid: number): ProcessInfo | "absent" | null {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const result = run(["ps", "-o", "etime=", "-o", "args=", "-p", String(pid)], { env: { LC_ALL: "C" } });
    const listed = result.stdout.trim();
    if (result.code === 1 && listed === "") return "absent";
    const match = /^\s*(\S+)\s+(.*)$/.exec(listed);
    if (result.code !== 0 || match === null) return null;
    const elapsed = elapsedMs(match[1] ?? "");
    if (Number.isNaN(elapsed)) return null;
    return { startMs: Date.now() - elapsed, command: match[2] ?? "" };
}

/** Whether `info`'s process started no later than `file` was last written; `unreadable` when the file cannot be read. */
function startedBeforeWrite(info: ProcessInfo, file: string, unreadable: boolean): boolean {
    try {
        return info.startMs <= statSync(file).mtimeMs + ELAPSED_SLACK_MS;
    } catch {
        return unreadable;
    }
}

/**
 * Whether `pid`, read from `file`, is still the toli process that wrote it: alive, running toli, and started no later
 * than the file was last written. After a reboot the pid in a surviving lock or record usually belongs to another
 * program (T1771), which started after the file was written; a pid ps cannot describe is judged by liveness alone.
 */
export function toliHolds(pid: number, file: string): boolean {
    if (!pidAlive(pid)) return false;
    const info = processInfo(pid);
    if (info === "absent") return false;
    if (info === null) return true;
    if (!/toli/.test(info.command)) return false;
    return startedBeforeWrite(info, file, true);
}

/**
 * Whether `pid`, read from `file`, can still be the process that wrote it, whatever it runs: alive, a process ps lists,
 * and started no later than the file was last written. After a reboot a recorded pid usually names another program
 * started later, or a thread of one; where ps cannot say, liveness alone decides.
 */
export function recordedPidRuns(pid: number, file: string): boolean {
    if (!pidAlive(pid)) return false;
    const info = processInfo(pid);
    if (info === "absent") return false;
    return info === null || startedBeforeWrite(info, file, true);
}

/**
 * Whether `pid`, read from `file`, is certainly still the process `file` recorded, as one toli is about to kill must
 * be: ps describes it, its command line matches `command`, and it started no later than the file was last written.
 * Unlike toliHolds, a pid ps cannot describe is never presumed to be it.
 */
export function recordedProcessRuns(pid: number, file: string, command: RegExp): boolean {
    const info = processInfo(pid);
    if (info === null || info === "absent" || !command.test(info.command)) return false;
    return startedBeforeWrite(info, file, false);
}

/** The pid written in `lockPath`, or 0 when it is absent or unreadable. */
function lockHolder(lockPath: string): number {
    try {
        return Number(readFileSync(lockPath, "utf8").trim()) || 0;
    } catch {
        return 0;
    }
}

/** Whether `lockPath` still names this process: a run that may lose it (tryPidLock's takeover) checks before acting. */
export function holdsPidLock(lockPath: string): boolean {
    return lockHolder(lockPath) === process.pid;
}

/**
 * Take `lockPath` for this process without waiting, as a run that must never overlap another (the tick's messaging
 * pass, a pull, the peer listener): false when the toli process that wrote it still runs. One whose holder is gone, or
 * whose pid now belongs to another program (a reboot reused it), is taken over. The caller removes it.
 */
export function tryPidLock(lockPath: string): boolean {
    mkdirSync(dirname(lockPath), { recursive: true });
    try {
        const fd = openSync(lockPath, "wx");
        writeSync(fd, String(process.pid));
        closeSync(fd);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Released between the open and the read: 0, which no process holds, so it is taken.
    if (toliHolds(lockHolder(lockPath), lockPath)) return false;
    writeJsonAtomic(lockPath, process.pid);
    return true;
}
