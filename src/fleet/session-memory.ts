// A lead session that grows without bound (docs/sardars.md "A Sardar session that grows too big"): an interactive omp
// left open for days keeps its whole conversation in memory, and once the machine runs out the kernel's or earlyoom's
// killer ends it along with whatever else it picks. The minute tick reads the live session's resident memory; past
// `lead.sessionMemoryGB` (default 8) it posts one inbox item to this machine's lead per session, recommending a stow
// and a restart. toli never stops or signals the session itself: the Sardar (or the user) restarts it.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { hasMachine, loadMachine, type Machine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, platform, readJson, run, ToliError, withLock, writeJsonAtomic } from "../core/util.ts";
import { liveSession, type SessionFile } from "../harness/session.ts";
import { addInboxItem } from "../records/inbox.ts";
import { procFile } from "./resources.ts";

export const DEFAULT_SESSION_MEMORY_GB = 8;

/** state/lead/memory-alert.json: the session alerted (its pid and start), its resident memory then, and when. */
type MemoryAlert = { pid: number; startedAt: string; rssMB: number; at: string };

/** `lead.sessionMemoryGB`: the resident memory past which the live lead session is told to stow and restart. */
export function sessionMemoryGB(machine: Machine): number {
    const raw: unknown = machine.lead?.sessionMemoryGB;
    if (raw === undefined) return DEFAULT_SESSION_MEMORY_GB;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)
        throw new ToliError("config/machine.json lead.sessionMemoryGB must be a positive number");
    return raw;
}

/** `VmRSS:  25165824 kB` from Linux's /proc/<pid>/status, in MB; null when absent. */
export function parseVmRss(status: string): number | null {
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return match?.[1] === undefined ? null : Math.round(Number(match[1]) / 1024);
}

/** A process's resident memory in MB (Linux: /proc; macOS: `ps`), or null when it cannot be read. */
export function residentMB(pid: number): number | null {
    if (platform() === "darwin") {
        const result = run(["ps", "-o", "rss=", "-p", String(pid)], { timeoutMs: 10_000 });
        const kb = Number(result.stdout.trim());
        return result.code === 0 && result.stdout.trim() !== "" && Number.isFinite(kb) ? Math.round(kb / 1024) : null;
    }
    const file = procFile(`${pid}/status`);
    return existsSync(file) ? parseVmRss(readFileSync(file, "utf8")) : null;
}

function gbText(mb: number): string {
    return `${(mb / 1024).toFixed(1)} GB`;
}

function alertBody(machine: string, session: SessionFile, rssMB: number, limitGB: number): string {
    return [
        `The lead session on ${machine} (pid ${session.pid}, open since ${session.startedAt}) holds ${gbText(rssMB)} of resident memory, past lead.sessionMemoryGB (${limitGB} GB). A session that keeps growing ends in the out-of-memory killer, which takes other processes with it.`,
        "",
        "Recommended: stow this session (`/stow`: notes and memory written down), then close it and start a fresh one, which picks up from the stowed notes. toli never stops or signals a live session; restarting it is yours to do.",
    ].join("\n");
}

/**
 * The tick's step: when the live lead session's resident memory is past `lead.sessionMemoryGB`, post one inbox item
 * to this machine's lead for that session; a new session (another pid or start) may be alerted again. Returns the line
 * to log, or null.
 */
export function alertSessionMemory(): string | null {
    if (!hasMachine()) return null;
    const session = liveSession();
    if (session === null) {
        rmSync(paths.leadMemoryAlert(), { force: true });
        return null;
    }
    const machine = loadMachine();
    const limitGB = sessionMemoryGB(machine);
    const rssMB = residentMB(session.pid);
    if (rssMB === null || rssMB <= limitGB * 1024) return null;
    return withLock(paths.lock("memory-alert"), () => {
        const alert = readJson<MemoryAlert | null>(paths.leadMemoryAlert(), null);
        if (alert?.pid === session.pid && alert.startedAt === session.startedAt) return null;
        const title = `lead session pid ${session.pid} on ${machine.name} at ${gbText(rssMB)}: stow and restart it`;
        addInboxItem(machine.name, title, alertBody(machine.name, session, rssMB, limitGB));
        writeJsonAtomic(paths.leadMemoryAlert(), {
            pid: session.pid,
            startedAt: session.startedAt,
            rssMB,
            at: now().toISOString(),
        } satisfies MemoryAlert);
        return `lead session pid ${session.pid} holds ${gbText(rssMB)}, past ${limitGB} GB: lead told to stow and restart it`;
    });
}
