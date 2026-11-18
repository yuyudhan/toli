// `task start <id> [--agent <id>] [--reopen]` and `task wait <id> --on "<what>"`: a task's jawan starts, or the active
// task waits on something. A done or dropped task starts again only with `--reopen` (a follow-up on landed work), noted
// on the task.
import { existsSync } from "node:fs";
import { Args } from "../core/args.ts";
import { paths } from "../core/paths.ts";
import { isValidName, now, out, ToliError } from "../core/util.ts";
import { dispatchingSessionPid } from "../fleet/lead-state.ts";
import { updateRun } from "../jawans/runs.ts";
import { updateTask } from "./backlog.ts";
import { isClosed } from "./task-end.ts";
import { holderName } from "./task-guard.ts";
import { describeTask } from "./task-line.ts";

/**
 * `task start <id> [--agent <id>] [--reopen]`. A `bin/toli spawn` run id started without `--task` (by hand, or by a
 * private helper restarting it) gets the task recorded on its run too, so the run and the task always name each other.
 * `--reopen` makes a done or dropped task active again for a follow-up, with a note naming who reopened it; without it
 * a closed task is refused, naming the flag.
 */
function start(argv: string[]): void {
    const args = new Args(argv, { values: ["agent"], booleans: ["reopen"] });
    args.maxPositional(1);
    const agent = args.str("agent");
    let reopened: string | undefined;
    const task = updateTask(args.pos(0, "id"), (entry) => {
        if (isClosed(entry.status)) {
            if (!args.bool("reopen"))
                throw new ToliError(
                    `${entry.id} is ${entry.status}; a follow-up reopens it: bin/toli task start ${entry.id} --reopen`,
                );
            reopened = `reopened from ${entry.status} by ${holderName()} for a follow-up`;
            entry.notes.push(reopened);
            delete entry.doneAt;
        }
        entry.status = "active";
        entry.startedAt ??= now().toISOString();
        if (agent !== undefined) {
            entry.agent = agent;
            entry.dispatchedAt = now().toISOString();
            delete entry.waitingOn;
            const session = agent.startsWith("j-") ? null : dispatchingSessionPid();
            if (session === null) delete entry.agentSession;
            else entry.agentSession = { agent, pid: session };
        }
    });
    if (agent !== undefined && isValidName(agent) && existsSync(paths.jawanRecord(agent)))
        updateRun(agent, (run) => {
            run.task ??= task.id;
            run.project ??= task.project;
        });
    out(describeTask(task));
    if (reopened !== undefined) out(`${task.id}: ${reopened}`);
}

/** `task wait <id> --on "<what>"`: the active task waits on `<what>` (no re-dispatch); see Task.waitingOn. */
function wait(argv: string[]): void {
    const args = new Args(argv, { values: ["on"] });
    args.maxPositional(1);
    const on = args.str("on")?.trim();
    if (!on) throw new ToliError('wait needs --on "<what it waits on>"');
    const task = updateTask(args.pos(0, "id"), (entry) => {
        if (entry.status === "done" || entry.status === "dropped" || entry.status === "held")
            throw new ToliError(`${entry.id} is ${entry.status}; only a queued or active task can wait`);
        entry.status = "active";
        entry.startedAt ??= now().toISOString();
        entry.waitingOn = on;
    });
    out(describeTask(task));
}

/** Run `task start` or `task wait`; false when `sub` is neither. */
export function startTaskCommand(sub: string, argv: string[]): boolean {
    if (sub === "start") start(argv);
    else if (sub === "wait") wait(argv);
    else return false;
    return true;
}
