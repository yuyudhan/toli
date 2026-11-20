// A delegated task reports to the machine that delegated it (docs/sardars.md): whenever its owner changes its status,
// question, notes, commit or report, the owner sends the task as it is now to the delegating machine, where
// `bin/toli delegation update` writes it back onto the `--for` task (src/records/delegation-sync.ts) and, for a new
// outcome (done, held, dropped), wakes that machine's lead with `<owner>/T<n> <status>: <title>`. Delivery goes
// through the outbox, so an unreachable delegator gets it from the minute tick; a repeat is applied once.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { loadFleet, loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, requireName, stamp, ToliError, warn } from "../core/util.ts";
import { sendNow } from "../jobs/outbox.ts";
import { fitTitle } from "../peer/envelope.ts";
import type { Status, Task } from "./backlog.ts";
import type { HoldOption } from "./hold-options.ts";

/** A delegating machine's task that a delegated task works for: `<machine>/<task>`. */
export type Upstream = { machine: string; task: string };

/**
 * Who handed a task to this machine (`bin/toli delegate`, docs/sardars.md); results and questions go back there.
 * `key` is the delegated work's delegationKey (src/fleet/delegate.ts): a repeat of it while this task is open is this
 * task. `upstream` is the chain above `machine` when it forwarded its own delegated task here (origin first): each
 * of those tasks gets the same reports, so the work's originator follows it wherever it went. `slice`: `machine`
 * delegated this task as a slice (its own jawan keeps the `--for` task), so work this task forwards on reports to
 * this task alone, never to the machines above. `refusedBy`: machines that refused this task's report because they
 * record no delegation of their task to it (src/records/report-refusal.ts); no further report goes to them.
 */
export type DelegatedBy = {
    machine: string;
    task?: string;
    id: string;
    key?: string;
    at: string;
    upstream?: Upstream[];
    slice?: true;
    refusedBy?: string[];
};

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
    /**
     * The owner forwarded the work on (its update named `forwardedTo`): once it drops its copy, the work lives only in
     * those delegations, so this one no longer counts for the `--for` task either way.
     */
    forwarded?: true;
};

/** The delegation fields of a task (src/records/backlog.ts `Task`). */
export type DelegationFields = {
    /** Set on a task another machine's lead delegated here: its report goes back to that machine. */
    delegatedBy?: DelegatedBy;
    /** Fleet ids (`<machine>/T<n>`) of tasks this one was delegated as: once all are done, so is this task. */
    delegatedTo?: string[];
    /**
     * Fleet ids of slices of this task delegated while its own jawan works on it: their outcome adds notes, its commit
     * and report, and a wake, but never changes this task's status (src/records/delegation-sync.ts).
     */
    slices?: string[];
    /**
     * Delegations sent from this task (`delegate --for`) whose receipt, with the task's fleet id, has not landed yet
     * (queued, pulled, or still crossing): `id` is the delegation's id. The owner's report can arrive first (it handed
     * the work back or dropped it on arrival), and is taken for this task by that id (src/peer/envelope.ts).
     */
    sending?: Array<{ machine: string; id: string }>;
    /** Each delegated task's last reported state, by fleet id. */
    delegates?: Record<string, DelegateState>;
    /** `task escalate`: this hold is a delegated task's question; answering it here also answers it there. */
    heldFrom?: string;
    /** `task handback`: this delegated task was given back to its delegator, for this reason. */
    handedBack?: string;
    /**
     * Verify work (`delegate --verify`): it checks ship work another jawan or machine made, so a machine verify-only
     * for the project takes it (docs/projects.md "Verify-only machines"). Its jawan is a verifier (`--work verify`).
     */
    verify?: true;
};

/** What travels to the delegator (JSON on `delegation update`'s stdin). */
export type DelegationUpdate = {
    owner: string;
    id: string;
    /** The delegator's own task this one works for, when the delegation named one. */
    forTask?: string;
    task: Pick<Task, "status" | "title" | "updatedAt" | "notes"> &
        Partial<Pick<Task, "question" | "options" | "recommend" | "blocks" | "commit" | "handedBack">>;
    /**
     * The delegation's id (`delegatedBy.id`), in the update to the delegator: it names the delegation the `--for` task
     * sent before it knew this task's fleet id (`sending`).
     */
    delegation?: string;
    /**
     * Fleet ids this delegated task was itself delegated on as (its live `delegatedTo`): the work goes on there, and
     * the receiving task follows those too.
     */
    forwardedTo?: string[];
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

/** The machines that may answer a delegated task's question: its delegator and every machine above it. */
export function delegators(by: DelegatedBy | undefined): string[] {
    return by === undefined ? [] : [by.machine, ...(by.upstream ?? []).map((entry) => entry.machine)];
}

/**
 * Every machine and task a delegated task reports to: its delegator, then the chain above it, less those that refused
 * a report as unrecorded there.
 */
function reportTargets(by: DelegatedBy): Array<{ machine: string; task?: string }> {
    const targets = [
        { machine: by.machine, ...(by.task === undefined ? {} : { task: by.task }) },
        ...(by.upstream ?? []),
    ];
    return targets.filter((target) => !(by.refusedBy ?? []).includes(target.machine));
}

/**
 * The fleet ids `task` was delegated as that still carry its work (not dropped, not handed back). On a delegated
 * task these are where it was forwarded: its own drop then means "forwarded", not "given up".
 */
export function liveDelegations(task: Task): string[] {
    return (task.delegatedTo ?? []).filter((id) => {
        const state = task.delegates?.[id];
        return state === undefined || (state.status !== "dropped" && state.handedBack === undefined);
    });
}

/** Record that `task` sent delegation `id` to `machine` (`delegate --for`), until its receipt or report lands. */
export function noteSending(task: Task, machine: string, id: string): void {
    if (task.sending?.some((sent) => sent.machine === machine && sent.id === id)) return;
    task.sending = [...(task.sending ?? []), { machine, id }];
}

/** Delegation `id` to `machine` landed (its receipt or its owner's report) or was given up: no longer `sending`. */
export function landSending(task: Task, machine: string, id: string): void {
    const left = (task.sending ?? []).filter((sent) => sent.machine !== machine || sent.id !== id);
    if (left.length > 0) task.sending = left;
    else delete task.sending;
}

/** The `upstream` chain a delegation or link carries (`what` names it in errors); absent is an empty chain. */
export function parseUpstream(value: unknown, what: string): Upstream[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new ToliError(`${what}: upstream must be a list of {machine, task}`);
    return value.map((entry: unknown) => {
        const machine: unknown = typeof entry === "object" && entry !== null ? Reflect.get(entry, "machine") : null;
        const task: unknown = typeof entry === "object" && entry !== null ? Reflect.get(entry, "task") : null;
        if (typeof machine !== "string" || typeof task !== "string")
            throw new ToliError(`${what}: upstream must be a list of {machine, task}`);
        return { machine: requireName("machine", machine), task: requireName("task", task) };
    });
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

/**
 * The inbox message `by` (the delegator, by default, or a machine above it) gets for `task` as it is now. A task
 * dropped here while forwarded on reads "forwarded to <fleet id>": the work goes on there.
 */
export function delegationReport(
    owner: string,
    task: Task,
    by: { machine: string; task?: string } | undefined = task.delegatedBy,
): { title: string; body: string } {
    const id = fleetId(owner, task.id);
    const via = task.delegatedBy !== undefined && by?.machine !== task.delegatedBy.machine ? task.delegatedBy : null;
    const forwards = liveDelegations(task);
    const lines = [
        `- task: ${id} (${task.status}), owned by ${owner}`,
        ...(by?.task === undefined ? [] : [`- for: ${by.task} on ${by.machine}`]),
        ...(via === null
            ? []
            : [`- via: ${via.machine}${via.task === undefined ? "" : `/${via.task}`}, which forwarded it`]),
        ...(forwards.length === 0 ? [] : [`- forwarded to: ${forwards.join(", ")}`]),
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
    const status =
        task.handedBack !== undefined
            ? "handed back"
            : task.status === "dropped" && forwards.length > 0
              ? `forwarded to ${forwards.join(", ")}`
              : task.status;
    return { title: `${id} ${status}: ${task.title}`, body: lines.join("\n") };
}

/** The update for `task` as it is now, owned by `owner`, for `to` (its delegator by default, or one above it). */
export function delegationUpdate(
    owner: string,
    task: Task,
    to: { machine: string; task?: string } | undefined = task.delegatedBy,
): DelegationUpdate {
    const { status, title, updatedAt, notes, question, options, recommend, blocks, commit, handedBack } = task;
    const forwards = liveDelegations(task);
    const by = task.delegatedBy;
    const direct = by !== undefined && to?.machine === by.machine && to.task === by.task;
    return {
        owner,
        id: task.id,
        ...(to?.task === undefined ? {} : { forTask: to.task }),
        ...(direct ? { delegation: by.id } : {}),
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
        ...(forwards.length === 0 ? {} : { forwardedTo: forwards }),
        report: reportText(task),
        message: delegationReport(owner, task, to),
    };
}

/**
 * Send `task` as it is now to its delegator and every machine above it (`upstream`); a failure is a warning (the
 * outbox keeps it for the tick).
 */
export function reportToDelegator(task: Task): void {
    const by = task.delegatedBy;
    if (by === undefined) return;
    const owner = loadMachine().name;
    const at = stamp(now());
    for (const to of reportTargets(by)) {
        const target = loadFleet().machines.find((entry) => entry.name === to.machine);
        if (target === undefined) {
            warn(`${task.id}: delegator ${to.machine} is not in config/fleet.json; its report was not sent`);
            continue;
        }
        const update = delegationUpdate(owner, task, to);
        const id = to.machine === by.machine ? `update-${task.id}-${at}` : `update-${task.id}-${to.machine}-${at}`;
        // The envelope title is a label within TITLE_MAX (a receiver before T2119 refuses a longer one); the update
        // carries the task's whole title, and the receiver's inbox item is its message.title.
        const label = fitTitle(update.message.title);
        const sent = sendNow(owner, target, "update", label, JSON.stringify(update), id);
        if (sent.delivered || sent.pulled) continue;
        // A refusal is final: the item already sits in state/outbox/cancelled/, and src/records/report-refusal.ts
        // stopped this task's reports to a machine that records no delegation of it.
        if (sent.refused !== undefined) warn(`${task.id}: ${to.machine} refused its report: ${sent.refused}`);
        else warn(`${task.id}: report to ${to.machine} queued (${sent.error}); the minute tick retries`);
    }
}
