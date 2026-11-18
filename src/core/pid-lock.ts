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

/**
 * When `pid` started (ms since the epoch, to the second) and its command line; null when ps cannot say. The elapsed
 * time, not `lstart`, so no time zone comes into it.
 */
function processInfo(pid: number): { startMs: number; command: string } | null {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const result = run(["ps", "-o", "etime=", "-o", "args=", "-p", String(pid)], { env: { LC_ALL: "C" } });
    const match = /^\s*(\S+)\s+(.*)$/.exec(result.stdout.trim());
    if (result.code !== 0 || match === null) return null;
    const elapsed = elapsedMs(match[1] ?? "");
    if (Number.isNaN(elapsed)) return null;
    return { startMs: Date.now() - elapsed, command: match[2] ?? "" };
}

/**
 * Whether `pid`, read from `file`, is still the toli process that wrote it: alive, running toli, and started no later
 * than the file was last written. After a reboot the pid in a surviving lock or record usually belongs to another
 * program (T1771), which started after the file was written; a pid ps cannot describe is judged by liveness alone.
 */
export function toliHolds(pid: number, file: string): boolean {
    if (!pidAlive(pid)) return false;
    const info = processInfo(pid);
    if (info === null) return true;
    if (!/toli/.test(info.command)) return false;
    let writtenMs: number;
    try {
        writtenMs = statSync(file).mtimeMs;
    } catch {
        return true;
    }
    return info.startMs <= writtenMs + ELAPSED_SLACK_MS;
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
    let holder = 0;
    try {
        holder = Number(readFileSync(lockPath, "utf8").trim());
    } catch {
        // Released between the open and the read: take it.
    }
    if (toliHolds(holder, lockPath)) return false;
    writeJsonAtomic(lockPath, process.pid);
    return true;
}
