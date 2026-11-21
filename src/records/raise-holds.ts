// A worker's own holds reach the user (docs/sardars.md "Holds on a worker reach the coordinator"): a held task's
// question is the user's (the Needs-you queue), but he talks to the coordinator, not to every worker. Each minute tick
// on a worker raises its own held tasks to the coordinator as a `forUser` update through the outbox (the same
// `delegation update` a delegated task sends its delegator), where it is held in the Needs-you queue once
// (src/records/delegated-word.ts); his answer there goes back to this task like a delegator's (`task answer --from`).
// Once the task is no longer held with that question (answered on either machine, dropped, re-held with another), the
// next tick sends the task as it is, which closes the coordinator's copy. A delegated task is left out (its delegator
// gets its hold, and raises it on when it is a worker itself), and so is a hold carrying the coordinator's own question.
import { coordinatorName, fleetMachine, loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, readJson, stamp, withLock, writeJsonAtomic } from "../core/util.ts";
import { queuedText, sendNow } from "../jobs/outbox.ts";
import { loadBacklog, type Task } from "./backlog.ts";
import { type DelegationUpdate, delegationUpdate, fleetId, splitFleetId } from "./delegation-report.ts";

/** state/raised-holds.json: per task id here, the question raised to the coordinator and when. */
type Raised = Record<string, { question: string; at: string }>;

/** Whether `task` is a hold the coordinator's user should see: held here, for no delegator, not his own question. */
function raisable(task: Task, coordinator: string): boolean {
    return (
        task.status === "held" &&
        task.question !== undefined &&
        task.delegatedBy === undefined &&
        (task.heldFrom === undefined || splitFleetId(task.heldFrom).machine !== coordinator)
    );
}

/**
 * The tick's step on a worker: raise each new held question to the coordinator, and send the task as it is once a
 * raised one is no longer asked. Returns one line per message sent.
 */
export function raiseHolds(): string[] {
    const machine = loadMachine();
    const coordinator = coordinatorName(machine);
    if (coordinator === null) return [];
    return withLock(paths.lock("raised-holds"), () => {
        const raised = readJson<Raised>(paths.raisedHolds(), {});
        const tasks = loadBacklog().tasks;
        const lines: string[] = [];
        for (const id of Object.keys(raised)) if (!tasks.some((task) => task.id === id)) delete raised[id];
        for (const task of tasks) {
            const open = raisable(task, coordinator);
            const before = raised[task.id];
            if (open ? before?.question === task.question : before === undefined) continue;
            const update: DelegationUpdate = {
                ...delegationUpdate(machine.name, task, { machine: coordinator }),
                forUser: true,
                project: task.project,
            };
            const sent = sendNow(
                machine.name,
                fleetMachine(coordinator),
                "update",
                update.message.title,
                JSON.stringify(update),
                `raise-${task.id}-${stamp(now())}`,
            );
            if (open) raised[task.id] = { question: task.question ?? "", at: now().toISOString() };
            else delete raised[task.id];
            const what = open ? "hold raised to" : "raised hold cleared on";
            const how = sent.delivered ? "" : `: ${queuedText(coordinator, sent)}`;
            lines.push(`${fleetId(machine.name, task.id)} ${what} ${coordinator}${how}`);
        }
        writeJsonAtomic(paths.raisedHolds(), raised);
        return lines;
    });
}
