// The lead's records (docs/sardars.md): the turn record in state/lead/state.json, the `lead attach` marker, and the
// lock both are read and written under. Shared by the service loop (lead.ts) and its status (lead-service.ts).
import { existsSync, rmSync } from "node:fs";
import { ancestry } from "../core/ancestry.ts";
import { paths } from "../core/paths.ts";
import { recordedPidRuns } from "../core/pid-lock.ts";
import { pidAlive, readJson, withLock, writeJsonAtomic } from "../core/util.ts";
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

/**
 * The pid of a headless turn in progress, or null. A recorded pid counts only while it can still be the process the
 * record named (recordedPidRuns): after a reboot the pid in a surviving record usually belongs to another program, or
 * to a thread of one, and must never hold the inbox.
 */
export function turnPid(state: LeadState): number | null {
    const file = paths.leadState();
    if (state.pid !== null && recordedPidRuns(state.pid, file)) return state.pid;
    if (state.ompPid !== null && recordedPidRuns(state.ompPid, file)) return state.ompPid;
    return null;
}

/**
 * Clear a turn record whose processes are gone (a service killed mid-turn, a reboot), so it never reads as a turn in
 * progress; its wake stays in pending.md for the next turn. Returns the line to log, or null when there was none. The
 * caller holds the lead lock.
 */
export function clearDeadTurnLocked(): string | null {
    const state = readLeadState();
    if ((state.pid === null && state.ompPid === null) || turnPid(state) !== null) return null;
    writeJsonAtomic(paths.leadState(), { ...state, pid: null, ompPid: null } satisfies LeadState);
    const omp = state.ompPid === null ? "" : ` (omp pid ${state.ompPid})`;
    return `lead turn record named pid ${state.pid ?? "none"}${omp}, which no longer runs: cleared`;
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

/** Who holds this machine's inbox: a headless lead turn, the interactive session, or a `lead attach`, and its pid. */
export type InboxHolder = { kind: "headless" | "session" | "attach"; pid: number };

/**
 * The one claim on this machine's inbox (docs/sardars.md "The lead on each machine"), so two Sardars never act on the
 * same items: a headless turn in progress (its pid in state.json), else the live interactive session (session.json),
 * else a `lead attach`. Each counts only while its pid is alive, and whichever starts first holds it: the service
 * starts no turn while a session or attach holds it, however long that session leaves its wakes unread (it may be
 * sitting at a prompt), and a session opened during a turn takes no wake until the turn ends. The caller holds the
 * lead lock, so a turn's claim and a session's take never interleave.
 */
export function inboxHolderLocked(): InboxHolder | null {
    const turn = turnPid(readLeadState());
    if (turn !== null) return { kind: "headless", pid: turn };
    const session = liveSession();
    if (session !== null) return { kind: "session", pid: session.pid };
    const attach = attachPidLocked();
    return attach === null ? null : { kind: "attach", pid: attach };
}

/** The interactive lead session this machine has open, if any: the extension-registered session, else `lead attach`. */
export function interactiveLeadPid(): number | null {
    const session = liveSession();
    if (session !== null) return session.pid;
    return withLock(leadLock(), attachPidLocked);
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
