// A live interactive session that stopped attending (docs/sardars.md "The lead on each machine"): an omp left open
// for days, or one sitting at a prompt, keeps state/session.json alive, and while it does it holds the inbox (no
// headless lead turn runs beside it: src/fleet/lead-state.ts inboxHolderLocked). It counts as attending only while it
// reads its wakes:
// once a wake has stayed unread (unacknowledged) for `lead.idleSessionMinutes` of the session's life, the digest and
// doctor flag it and the tick runs due jobs headless. toli never stops the session itself. A session whose extension
// has not even taken a wake for `lead.silentSessionMinutes` is silent: deaf to its inbox, not merely busy, and the tick
// alerts the coordinator (src/fleet/silent-alert.ts).
import { hasMachine, loadMachine, type Machine } from "../core/config.ts";
import { now, stamp, ToliError } from "../core/util.ts";
import { liveSession, type SessionFile } from "../harness/session.ts";
import { listResults } from "../jobs/results.ts";
import { ackedThrough } from "../records/acks.ts";
import { listInbox } from "../records/inbox.ts";
import { readLeadState, turnPid } from "./lead-state.ts";

const DEFAULT_IDLE_SESSION_MINUTES = 60;
const DEFAULT_SILENT_SESSION_MINUTES = 20;

/** `lead.<key>` in config/machine.json: a positive number of minutes, else `fallback` when unset. */
function leadMinutes(machine: Machine, key: "idleSessionMinutes" | "silentSessionMinutes", fallback: number): number {
    const raw: unknown = machine.lead?.[key];
    if (raw === undefined) return fallback;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)
        throw new ToliError(`config/machine.json lead.${key} must be a positive number`);
    return raw;
}

/** `lead.idleSessionMinutes`: how long a live session may leave a wake unread before it is flagged as idle. */
export function idleSessionMinutes(machine: Machine): number {
    return leadMinutes(machine, "idleSessionMinutes", DEFAULT_IDLE_SESSION_MINUTES);
}

/** A live session that left wakes unread: since `unreadSince` (the oldest unread item's stamp), over `minutes`. */
export type IdleSession = { pid: number; startedAt: string; unreadSince: string; minutes: number };

/**
 * The live interactive session and, when it has stopped reading its wakes, why: an inbox item or job result still
 * unacknowledged `minutes` after it arrived and after the session registered (a session just opened gets the same
 * time to read what was already waiting). Null when no interactive session is live.
 */
export function sessionPresence(): { session: SessionFile; idle: IdleSession | null } | null {
    const session = liveSession();
    if (session === null) return null;
    const minutes = hasMachine() ? idleSessionMinutes(loadMachine()) : DEFAULT_IDLE_SESSION_MINUTES;
    const cutoff = now().getTime() - minutes * 60_000;
    // An unparsable start (a hand-edited record) counts as long ago, so it never shields the session.
    if (Date.parse(session.startedAt) > cutoff) return { session, idle: null };
    const unread = [
        ...listInbox().filter((item) => item.unseen),
        ...listResults().filter((result) => result.unseen),
    ].map((item) => item.stamp);
    const oldest = unread.toSorted()[0];
    if (oldest === undefined || oldest > stamp(new Date(cutoff))) return { session, idle: null };
    return { session, idle: { pid: session.pid, startedAt: session.startedAt, unreadSince: oldest, minutes } };
}

/** `pid 382655 has left wakes unread since <stamp> (over 60 min)`, as logs, digest and doctor say it. */
export function idleSessionText(idle: IdleSession): string {
    return `pid ${idle.pid} has left wakes unread since ${idle.unreadSince} (over ${idle.minutes} min)`;
}

/**
 * A live session whose extension has taken no wake: `waiting` inbox items and job results it was never given, the
 * oldest from `waitingSince`, `minutes` ago.
 */
export type SilentSession = { pid: number; waitingSince: string; waiting: number; minutes: number };

/**
 * The live interactive session when it is silent: an item it was never given (above the user's ack and the session's
 * delivered mark) has waited `lead.silentSessionMinutes` (default 20), and the session registered that long ago. A
 * session that takes its wakes but has not acknowledged them yet (a long turn) is not silent, and neither is one
 * while a headless turn holds the inbox (its wakes wait for that turn). Null otherwise.
 */
export function silentSession(): SilentSession | null {
    const session = liveSession();
    if (session === null || turnPid(readLeadState()) !== null) return null;
    const limit = hasMachine()
        ? leadMinutes(loadMachine(), "silentSessionMinutes", DEFAULT_SILENT_SESSION_MINUTES)
        : DEFAULT_SILENT_SESSION_MINUTES;
    const at = now().getTime();
    const cutoff = at - limit * 60_000;
    if (Date.parse(session.startedAt) > cutoff) return null;
    const inboxGiven = ackedThrough("inboxDelivered");
    const jobsGiven = ackedThrough("jobsDelivered");
    const waiting = [
        ...listInbox().filter((item) => item.unseen && item.stamp > inboxGiven),
        ...listResults().filter((result) => result.unseen && result.stamp > jobsGiven),
    ]
        .map((item) => item.stamp)
        .toSorted();
    const oldest = waiting[0];
    if (oldest === undefined || oldest > stamp(new Date(cutoff))) return null;
    // A stamp is an ISO time with `-` for `:` and `.`: 2026-11-11T08-33-00-000Z.
    const since = Date.parse(oldest.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, "T$1:$2:$3.$4Z"));
    return {
        pid: session.pid,
        waitingSince: oldest,
        waiting: waiting.length,
        minutes: Math.floor((at - since) / 60_000),
    };
}

/** `pid 382655 has taken no wake for 25 min (2 waiting since <stamp>)`, as the tick and `lead status` say it. */
export function silentSessionText(silent: SilentSession): string {
    return `pid ${silent.pid} has taken no wake for ${silent.minutes} min (${silent.waiting} waiting since ${silent.waitingSince})`;
}
