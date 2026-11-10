// A delegated task reports to the machine that delegated it (docs/sardars.md): whenever its owner changes its status,
// question, notes, commit or report, the owner sends the task as it is now to the delegating machine, where
// `bin/toli delegation update` writes it back onto the `--for` task (src/records/delegation-sync.ts) and, for a new
// outcome (done, held, dropped), wakes that machine's lead with `<owner>/T<n> <status>: <title>`. Delivery goes
// through the outbox, so an unreachable delegator gets it from the minute tick; a repeat is applied once.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { loadFleet, loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, stamp, warn } from "../core/util.ts";
import { sendNow } from "../jobs/outbox.ts";
import type { Status, Task } from "./backlog.ts";
import type { HoldOption } from "./hold-options.ts";

/** Who handed a task to this machine (`bin/toli delegate`, docs/sardars.md); results and questions go back there. */
export type DelegatedBy = { machine: string; task?: string; id: string; at: string };

/** The last state of one delegated task, as its owner sent it (`delegation update`). */
export type DelegateState = {
    status: Status;
    /** The owner's `updatedAt`: an update no newer than this one is a repeat and is skipped. */
    updatedAt: string;
    /** How many of the owner's notes are already copied onto the `--for` task. */
    notes: number;
    question?: string;
    options?: HoldOption[];
    recommend?: string;
    blocks?: string;
    commit?: string;
    /** The owner handed the work back (`task handback`) with this reason: it no longer counts for the `--for` task. */
    handedBack?: string;
};

/** The delegation fields of a task (src/records/backlog.ts `Task`). */
export type DelegationFields = {
    /** Set on a task another machine's lead delegated here: its report goes back to that machine. */
    delegatedBy?: DelegatedBy;
    /** Fleet ids (`<machine>/T<n>`) of tasks this one was delegated as. */
    delegatedTo?: string[];
    /** Each delegated task's last reported state, by fleet id. */
    delegates?: Record<string, DelegateState>;
    /** `task escalate`: this hold is a delegated task's question; answering it here also answers it there. */
    heldFrom?: string;
    /** `task handback`: this delegated task was given back to its delegator, for this reason. */
    handedBack?: string;
};

/** What travels to the delegator (JSON on `delegation update`'s stdin). */
export type DelegationUpdate = {
    owner: string;
    id: string;
    /** The delegator's own task this one works for, when the delegation named one. */
    forTask?: string;
    task: Pick<Task, "status" | "title" | "updatedAt" | "notes"> &
        Partial<Pick<Task, "question" | "options" | "recommend" | "blocks" | "commit" | "handedBack">>;
    /** The task's report file, read on the owner. */
    report: string | null;
    /** The wake the delegator's lead gets for a new outcome. */
    message: { title: string; body: string };
};

/** The statuses a delegator is woken for: the task finished, has a question, or was given up. */
export const REPORTED: readonly Status[] = ["done", "held", "dropped"];
const REPORT_LIMIT = 4000;

/** `<machine>/T<n>`: a task id unique across the fleet. */
export function fleetId(machine: string, id: string): string {
    return `${machine}/${id}`;
}

/** Split `<machine>/T<n>` into its owner and local id; a bare `T<n>` has no owner (this machine's). */
export function splitFleetId(id: string): { machine: string | null; id: string } {
    const slash = id.indexOf("/");
    if (slash < 0) return { machine: null, id: id.toUpperCase() };
    return { machine: id.slice(0, slash), id: id.slice(slash + 1).toUpperCase() };
}

/** Whether a change from `before` to `after` is one the delegator must get: anything its `--for` task mirrors. */
export function reportDue(before: Task, after: Task): boolean {
    if (after.delegatedBy === undefined) return false;
    return (
        before.status !== after.status ||
        before.question !== after.question ||
        before.notes.length !== after.notes.length ||
        before.commit !== after.commit ||
        before.report !== after.report
    );
}

function reportText(task: Task): string | null {
    if (task.report === undefined) return null;
    const path = isAbsolute(task.report) ? task.report : join(paths.root(), task.report);
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8").trimEnd();
    return text.length <= REPORT_LIMIT
        ? text
        : `${text.slice(0, REPORT_LIMIT)}\n[... truncated; full report on the owner]`;
}

/** The inbox message the delegator gets for `task` as it is now. */
export function delegationReport(owner: string, task: Task): { title: string; body: string } {
    const id = fleetId(owner, task.id);
    const by = task.delegatedBy;
    const lines = [
        `- task: ${id} (${task.status}), owned by ${owner}`,
        ...(by?.task === undefined ? [] : [`- for: ${by.task} on ${by.machine}`]),
        ...(task.commit === undefined ? [] : [`- commit: ${task.commit}`]),
        ...(task.report === undefined ? [] : [`- report (on ${owner}): ${task.report}`]),
    ];
    if (task.handedBack !== undefined)
        lines.push(
            "",
            `${owner}'s lead handed this work back: ${task.handedBack}`,
            by?.task === undefined
                ? "Give it to another Sardar (`bin/toli delegate <machine> ...`) or do it here."
                : `${by.task} is queued again: give it to another Sardar (\`bin/toli delegate <machine> "<title>" --brief <file> --for ${by.task}\`) or dispatch it here.`,
        );
    if (task.status === "held") {
        lines.push("", "## Question", "", task.question ?? "");
        for (const [index, option] of (task.options ?? []).entries())
            lines.push(`${index + 1}. ${option.choice} => ${option.outcome}`);
        if (task.recommend !== undefined) lines.push(`Recommended: ${task.recommend}`);
        if (task.blocks !== undefined) lines.push(`Blocks: ${task.blocks}`);
        lines.push(
            "",
            `You delegated this work, so you answer it: \`bin/toli task answer ${id} "<answer>"\` (it goes to ${owner},`,
            `whose lead resumes the work at once). Only a question that needs the user (push, merge, release, money,`,
            `security, a destructive step, or his taste) goes to him: \`bin/toli task escalate ${id}\` puts it in your`,
            "Needs-you queue, and his answer there goes to the owner too.",
        );
    }
    const notes = task.notes.slice(-3);
    if (notes.length > 0) lines.push("", "## Latest notes", "", ...notes.map((note) => `- ${note}`));
    const report = reportText(task);
    if (report !== null) lines.push("", "## Report", "", report);
    const status = task.handedBack === undefined ? task.status : "handed back";
    return { title: `${id} ${status}: ${task.title}`, body: lines.join("\n") };
}

/** The update for `task` as it is now, owned by `owner`. */
export function delegationUpdate(owner: string, task: Task): DelegationUpdate {
    const { status, title, updatedAt, notes, question, options, recommend, blocks, commit, handedBack } = task;
    return {
        owner,
        id: task.id,
        ...(task.delegatedBy?.task === undefined ? {} : { forTask: task.delegatedBy.task }),
        task: {
            status,
            title,
            updatedAt,
            notes,
            ...(question === undefined ? {} : { question }),
            ...(options === undefined ? {} : { options }),
            ...(recommend === undefined ? {} : { recommend }),
            ...(blocks === undefined ? {} : { blocks }),
            ...(commit === undefined ? {} : { commit }),
            ...(handedBack === undefined ? {} : { handedBack }),
        },
        report: reportText(task),
        message: delegationReport(owner, task),
    };
}

/** Send `task` as it is now to its delegator; a failure is a warning (the outbox keeps it for the tick). */
export function reportToDelegator(task: Task): void {
    const by = task.delegatedBy;
    if (by === undefined) return;
    const owner = loadMachine().name;
    const target = loadFleet().machines.find((entry) => entry.name === by.machine);
    if (target === undefined) {
        warn(`${task.id}: delegator ${by.machine} is not in config/fleet.json; its report was not sent`);
        return;
    }
    const update = delegationUpdate(owner, task);
    const id = `update-${task.id}-${stamp(now())}`;
    const sent = sendNow(owner, target, "update", update.message.title, JSON.stringify(update), id);
    if (!sent.delivered) warn(`${task.id}: report to ${by.machine} queued (${sent.error}); the minute tick retries`);
}
