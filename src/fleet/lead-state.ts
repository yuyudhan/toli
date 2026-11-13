// The lead's records (docs/sardars.md): the turn record in state/lead/state.json, the `lead attach` marker, and the
// lock both are read and written under. Shared by the service loop (lead.ts) and its status (lead-service.ts).
import { existsSync, rmSync } from "node:fs";
import { paths } from "../core/paths.ts";
import { pidAlive, readJson, run, withLock } from "../core/util.ts";
import { liveSession } from "../harness/session.ts";

/**
 * The lead's turn record. `pid` is the process running the current turn and `ompPid` the omp it started; both are
 * null between turns. Either being alive means a turn is in progress (an omp left running by a crashed service
 * still counts, so no second turn or attach writes into the same conversation).
 */
export type LeadState = {
    lastTurnAt: string | null;
    lastExit: number | null;
    turns: number;
    sessionFile: string | null;
    pid: number | null;
    ompPid: number | null;
};

/** Written by `lead attach` while its interactive omp runs; the service leaves the conversation alone meanwhile. */
export type LeadAttach = { pid: number; startedAt: string };

const EMPTY_STATE: LeadState = {
    lastTurnAt: null,
    lastExit: null,
    turns: 0,
    sessionFile: null,
    pid: null,
    ompPid: null,
};

export function readLeadState(): LeadState {
    return { ...EMPTY_STATE, ...readJson<Partial<LeadState>>(paths.leadState(), {}) };
}

/** The pid of a headless turn in progress, or null. */
export function turnPid(state: LeadState): number | null {
    if (state.pid !== null && pidAlive(state.pid)) return state.pid;
    if (state.ompPid !== null && pidAlive(state.ompPid)) return state.ompPid;
    return null;
}

export function leadLock(): string {
    return paths.lock("lead");
}

/** The attach marker's pid when that process is alive; a dead marker is removed. The caller holds the lead lock. */
export function attachPidLocked(): number | null {
    const path = paths.leadAttach();
    if (!existsSync(path)) return null;
    const marker = readJson<LeadAttach | null>(path, null);
    if (marker !== null && pidAlive(marker.pid)) return marker.pid;
    rmSync(path, { force: true });
    return null;
}

/** The interactive lead session this machine has open, if any: the extension-registered session, else `lead attach`. */
export function interactiveLeadPid(): number | null {
    const session = liveSession();
    if (session !== null) return session.pid;
    return withLock(leadLock(), attachPidLocked);
}

/** This process and its ancestors, nearest first, from one `ps` listing; just this process when `ps` fails. */
function ancestry(): number[] {
    const ps = run(["ps", "-A", "-o", "pid=,ppid="], { timeoutMs: 20_000 });
    const parents = new Map<number, number>();
    if (ps.code === 0)
        for (const line of ps.stdout.split("\n")) {
            const [pid, ppid] = line.trim().split(/\s+/).map(Number);
            if (pid !== undefined && ppid !== undefined && pid > 0) parents.set(pid, ppid);
        }
    const chain: number[] = [];
    for (let pid: number | undefined = process.pid; pid !== undefined && pid > 1 && !chain.includes(pid); ) {
        chain.push(pid);
        pid = parents.get(pid);
    }
    return chain;
}

/**
 * The lead session running this command, whose native harness subagents die with it: the first of the interactive
 * session (state/session.json), the `lead attach` omp and a headless turn's omp that is alive and an ancestor of this
 * process; null when none is. A lead no record names (a Claude Code lead) is never mistaken for one that is open.
 */
export function dispatchingSessionPid(): number | null {
    const { ompPid } = readLeadState();
    const candidates = [liveSession()?.pid ?? null, withLock(leadLock(), attachPidLocked), ompPid];
    const live = candidates.filter((pid): pid is number => pid !== null && pidAlive(pid));
    if (live.length === 0) return null;
    const chain = ancestry();
    return live.find((pid) => chain.includes(pid)) ?? null;
}
