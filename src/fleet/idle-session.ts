// A live interactive session that stopped attending (docs/sardars.md "The lead on each machine"): an omp left open
// for days, or one sitting at a prompt, keeps state/session.json alive, and while it does it holds the inbox (no
// headless lead turn runs beside it: src/fleet/lead-state.ts inboxHolderLocked). It counts as attending only while it
// reads its wakes:
// once a wake has stayed unread (unacknowledged) for `lead.idleSessionMinutes` of the session's life, the digest and
// doctor flag it and the tick runs due jobs headless. toli never stops the session itself.
import { hasMachine, loadMachine, type Machine } from "../core/config.ts";
import { now, stamp, ToliError } from "../core/util.ts";
import { liveSession, type SessionFile } from "../harness/session.ts";
import { listResults } from "../jobs/results.ts";
import { listInbox } from "../records/inbox.ts";

const DEFAULT_IDLE_SESSION_MINUTES = 60;

/** `lead.idleSessionMinutes`: how long a live session may leave a wake unread before it is flagged as idle. */
export function idleSessionMinutes(machine: Machine): number {
    const raw: unknown = machine.lead?.idleSessionMinutes;
    if (raw === undefined) return DEFAULT_IDLE_SESSION_MINUTES;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)
        throw new ToliError("config/machine.json lead.idleSessionMinutes must be a positive number");
    return raw;
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
