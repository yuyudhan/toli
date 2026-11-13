// `lead.dispatch` in config/machine.json: how this machine's lead starts jawans (docs/sardars.md "The lead service").
// "spawn" (the default): any lead turn dispatches with `bin/toli spawn`, the headless ones included. "subagents": jawans
// run only as the interactive Sardar's own subagents, so a headless lead turn starts none and leaves that work unread
// for the interactive session.
import { hasMachine, loadMachine, type Machine } from "../core/config.ts";
import { ToliError } from "../core/util.ts";
import { LEAD_TURN_ENV } from "./full.ts";

export type LeadDispatch = "spawn" | "subagents";

const DISPATCHES: readonly LeadDispatch[] = ["spawn", "subagents"];

/** `lead.dispatch`, validated; "spawn" when unset. */
export function leadDispatch(machine: Machine): LeadDispatch {
    const raw: unknown = machine.lead?.dispatch;
    if (raw === undefined) return "spawn";
    const known = DISPATCHES.find((value) => value === raw);
    if (known === undefined) throw new ToliError('config/machine.json lead.dispatch must be "spawn" or "subagents"');
    return known;
}

/** This machine's `lead.dispatch`; "spawn" before `bin/toli init` wrote a config. */
export function machineDispatch(): LeadDispatch {
    return hasMachine() ? leadDispatch(loadMachine()) : "spawn";
}

/**
 * Refuse starting a jawan from a headless lead turn while `lead.dispatch` is "subagents": the user wants every jawan
 * to run as a subagent of the interactive Sardar's live session, which an unattended turn has none of. The interactive
 * Sardar's own commands are never refused.
 */
export function refuseHeadlessDispatch(action: string): void {
    if (process.env[LEAD_TURN_ENV] !== "headless") return;
    if (machineDispatch() !== "subagents") return;
    throw new ToliError(
        `refusing to ${action}: config/machine.json lead.dispatch is "subagents", so jawans run only as the ` +
            "interactive Sardar's subagents and a headless lead turn starts none. Leave the item unacknowledged: it " +
            "stays unread and wakes the interactive Sardar's next session (bin/toli lead attach)",
    );
}
