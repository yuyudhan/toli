// A Sardar that stops taking its wakes (docs/sardars.md, step 1): while an interactive
// session is open it holds this machine's inbox, so when its extension stops fetching wakes nothing else reads them.
// Once that silence passes `lead.silentSessionMinutes` (src/fleet/idle-session.ts silentSession), the minute tick on a
// worker tells the coordinator, where the user is, once per episode; on the coordinator it is logged. The episode ends
// when the session takes a wake (its delivered marks move) or closes. toli never stops or signals a live session.
import { rmSync } from "node:fs";
import { coordinatorName, fleetMachine, loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, readJson, stamp, withLock, writeJsonAtomic } from "../core/util.ts";
import { queuedText, sendToMachine } from "../jobs/outbox.ts";
import { ackedThrough } from "../records/acks.ts";
import { type SilentSession, silentSession, silentSessionText } from "./idle-session.ts";

/** state/lead/silent-alert.json: the episode alerted (its session and delivered marks then), when, and to whom. */
export type SilentAlert = { pid: number; given: string; at: string; to: string | null };

/** The session's delivered marks: a take moves them, which ends a silence. */
function givenMarks(): string {
    return `${ackedThrough("inboxDelivered")} ${ackedThrough("jobsDelivered")}`;
}

/** The alert already raised for `silent`'s episode, or null. */
export function silentAlertFor(silent: SilentSession): SilentAlert | null {
    const alert = readJson<SilentAlert | null>(paths.leadSilentAlert(), null);
    return alert?.pid === silent.pid && alert.given === givenMarks() ? alert : null;
}

/**
 * The tick's step: when the interactive session is silent, alert the coordinator once per episode (a worker) or log
 * it (the coordinator); a session no longer silent ends the episode. Returns the line to log, or null.
 */
export function alertSilentSession(): string | null {
    const silent = silentSession();
    return withLock(paths.lock("silent-alert"), () => {
        if (silent === null) {
            rmSync(paths.leadSilentAlert(), { force: true });
            return null;
        }
        if (silentAlertFor(silent) !== null) return null;
        const machine = loadMachine();
        const coordinator = coordinatorName(machine);
        const text = `interactive session ${silentSessionText(silent)}`;
        let line = `${text}: this is the coordinator, nobody to alert`;
        if (coordinator !== null) {
            const wakes = `${silent.waiting} wake${silent.waiting === 1 ? "" : "s"}`;
            const title = `Sardar on ${machine.name} silent ${silent.minutes} min, ${wakes} pending`;
            const body = [
                `${machine.name}'s Sardar is not reading its inbox: its interactive session (pid ${silent.pid}) has taken no wake for ${silent.minutes} min, and ${wakes} wait for it, the oldest since ${silent.waitingSince}. While that session is open no headless lead turn takes them, so messages to ${machine.name} go unanswered.`,
                "",
                `\`bin/toli lead status\` on ${machine.name} says why. toli never stops or signals a live session: attend it, or close it so the lead service's headless turns take the wakes.`,
            ].join("\n");
            const sent = sendToMachine(
                machine.name,
                fleetMachine(coordinator),
                title,
                body,
                `silent-${machine.name}-${stamp()}`,
            );
            line = `${text}: alerted ${coordinator}${sent.delivered ? "" : ` (${queuedText(coordinator, sent)})`}`;
        }
        writeJsonAtomic(paths.leadSilentAlert(), {
            pid: silent.pid,
            given: givenMarks(),
            at: now().toISOString(),
            to: coordinator,
        } satisfies SilentAlert);
        return line;
    });
}
