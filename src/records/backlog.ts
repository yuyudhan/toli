import { existsSync } from "node:fs";
import { Args } from "../core/args.ts";
import { paths } from "../core/paths.ts";
import { isValidName, now, out, printJson, readJson, ToliError, withLock, writeJsonAtomic } from "../core/util.ts";
import { dispatchingSessionPid } from "../fleet/lead-state.ts";
import { parseOptionalTier, type Tier } from "../harness/models.ts";
import { updateRun } from "../jawans/runs.ts";
import { findProject } from "../projects/projects.ts";
import type { Workspace } from "../projects/strategy.ts";
import { answerWake } from "./answer-wake.ts";
import { recordDecision } from "./decisions.ts";
import { type DelegationFields, reportDue, reportToDelegator } from "./delegation-report.ts";
import { delegationTaskCommand, forwardEscalatedAnswer, requireDelegator } from "./delegation-sync.ts";
import { listFleet, routeToOwner } from "./fleet-tasks.ts";
import {
    HOLD_OPTIONS_MAX,
    HOLD_OPTIONS_MIN,
    type HoldOption,
    irreversibleTopic,
    matchOption,
    parseOption,
} from "./hold-options.ts";
import { pinTaskCommand } from "./pin.ts";
import { briefPath } from "./stale.ts";
import { isClosed, runTaskEnd } from "./task-end.ts";
import { parseShape } from "./task-shape.ts";

/** Where a task's jawans work, recorded when its workspace is prepared (src/projects/workspace.ts). `base`: per-task only. */
export type TaskWorkspace = { strategy: Workspace; path: string; branch: string | null; base: string | null };

export const STATUSES = ["queued", "active", "held", "done", "dropped"] as const;
export type Status = (typeof STATUSES)[number];
export type Shape = "ship" | "scout";

export type Task = {
    id: string;
    project: string;
    title: string;
    shape: Shape;
    status: Status;
    /** The model tier its jawans run on (`task add --tier`); without it, the shape's work type picks (docs/harnesses.md). */
    tier?: Tier;
    notes: string[];
    /** The held question for the user: the task's entry in the Needs-you queue (`bin/toli needs`). */
    question?: string;
    /** The answers offered with the question (2-4), each with its consequence. */
    options?: HoldOption[];
    /** The lead's or jawan's recommended answer: one of the option choices, or free text when there are none. */
    recommend?: string;
    /** What waits on the answer (other tasks, a release, a deadline). */
    blocks?: string;
    /** When the task was last held; the Needs-you queue's age. */
    heldAt?: string;
    /**
     * `task hold --reversible`: the recommended option is safe to undo, so an installation may apply it to a hold left
     * unanswered past its own timeout (with `task answer`); toli only records the mark. Never set for push, merge,
     * main, MR, tag, release, destructive, security or money holds (`irreversibleTopic` refuses them).
     */
    reversible?: boolean;
    /** When the digest last re-surfaced this hold as stale (once per hold). */
    staleSurfacedAt?: string;
    answer?: string;
    /** When the user's answer was recorded (`task answer`). */
    answeredAt?: string;
    report?: string;
    commit?: string;
    /** The jawan working on it: a harness agent id (`task start --agent`) or a `bin/toli spawn` run id. */
    agent?: string;
    /** When `agent` was last recorded; a run that finished after it is the recorded jawan's (src/records/stale.ts). */
    dispatchedAt?: string;
    /**
     * The lead session (dispatchingSessionPid) that recorded native subagent `agent`; the subagent dies with it, so a
     * gone pid frees its jawan slot and the task needs a re-dispatch (src/records/stale.ts agentSessionGone).
     */
    agentSession?: { agent: string; pid: number };
    /**
     * `task wait --on "<what>"`: the task is active but deliberately waits on something outside a jawan (a deferred
     * spawn, a push, another task); oversight reports it as waiting, never as needing a re-dispatch. Recording a new
     * jawan, holding, finishing or dropping the task clears it.
     */
    waitingOn?: string;
    /** `task pin`: stays on this machine, never offered to another by the queue balancer; the reason ("" if none). */
    pinned?: string;
    workspace?: TaskWorkspace;
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    doneAt?: string;
} & DelegationFields;

export type BacklogFile = { nextId: number; tasks: Task[] };

export function loadBacklog(): BacklogFile {
    const backlog = readJson<BacklogFile>(paths.backlog(), { nextId: 1, tasks: [] });
    return { nextId: backlog.nextId ?? 1, tasks: backlog.tasks ?? [] };
}

/** Read-modify-write data/backlog.json under the backlog lock. */
export function updateBacklog<T>(fn: (backlog: BacklogFile) => T): T {
    return withLock(paths.lock("backlog"), () => {
        const backlog = loadBacklog();
        const result = fn(backlog);
        writeJsonAtomic(paths.backlog(), backlog);
        return result;
    });
}

/**
 * Mutate one task by id under the backlog lock and return a copy of the result. A delegated task that becomes done,
 * held or dropped reports to its delegator once the lock is released (src/records/delegation-report.ts); a task that
 * becomes done or dropped then runs the `task-end` hook (src/records/task-end.ts).
 */
export function updateTask(id: string, fn: (task: Task) => void): Task {
    const { before, after } = updateBacklog((backlog) => {
        const task = backlog.tasks.find((entry) => entry.id === id.toUpperCase());
        if (!task) throw new ToliError(`unknown task "${id}"`);
        const copy = structuredClone(task);
        fn(task);
        task.updatedAt = now().toISOString();
        return { before: copy, after: { ...task } };
    });
    if (reportDue(before, after)) reportToDelegator(after);
    if (!isClosed(before.status) && isClosed(after.status)) runTaskEnd(after);
    return after;
}

function describe(task: Task): string {
    const extras: string[] = [];
    if (task.status === "held" && task.question) extras.push(`question: ${task.question}`);
    if (task.agent) extras.push(`agent: ${task.agent}`);
    if (task.waitingOn !== undefined) extras.push(`waiting on: ${task.waitingOn}`);
    if (task.pinned !== undefined) extras.push(task.pinned === "" ? "pinned" : `pinned: ${task.pinned}`);
    if (task.commit) extras.push(`commit: ${task.commit}`);
    if (task.report) extras.push(`report: ${task.report}`);
    if (task.delegatedBy)
        extras.push(
            `delegated by ${task.delegatedBy.machine}${task.delegatedBy.task ? `/${task.delegatedBy.task}` : ""}`,
        );
    if (task.delegatedTo?.length) extras.push(`delegated to ${task.delegatedTo.join(", ")}`);
    return `${task.id}\t${task.status}\t${task.project}\t${task.shape}\t${task.title}${extras.length ? `\t(${extras.join("; ")})` : ""}`;
}

function add(argv: string[]): void {
    const args = new Args(argv, { values: ["shape", "note", "tier"] });
    args.maxPositional(2);
    const project = findProject(args.pos(0, "project")).name;
    const title = args.pos(1, "title");
    const shape = parseShape(args.str("shape"), "ship");
    const tier = parseOptionalTier(args.str("tier"));
    const note = args.str("note");
    const id = updateBacklog((backlog) => {
        const taskId = `T${backlog.nextId}`;
        backlog.nextId += 1;
        const stamp = now().toISOString();
        backlog.tasks.push({
            id: taskId,
            project,
            title,
            shape,
            status: "queued",
            ...(tier === undefined ? {} : { tier }),
            notes: note === undefined ? [] : [note],
            createdAt: stamp,
            updatedAt: stamp,
        });
        return taskId;
    });
    out(id);
}

/** `task list`: synchronous for this machine's tasks; with `--fleet` it returns the ssh refresh's promise. */
function list(argv: string[]): Promise<void> | undefined {
    const args = new Args(argv, { booleans: ["json", "fleet", "cached"], values: ["status", "project"] });
    args.maxPositional(0);
    const status = args.str("status");
    if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
        throw new ToliError(`--status must be one of ${STATUSES.join(", ")}`);
    }
    const project = args.str("project");
    if (args.bool("fleet"))
        return listFleet({
            json: args.bool("json"),
            cachedOnly: args.bool("cached"),
            status: STATUSES.find((entry) => entry === status),
            project,
        });
    if (args.bool("cached")) throw new ToliError("--cached goes with --fleet");
    const tasks = loadBacklog().tasks.filter(
        (task) =>
            (status === undefined || task.status === status) && (project === undefined || task.project === project),
    );
    if (args.bool("json")) {
        printJson(tasks);
        return;
    }
    if (tasks.length === 0) {
        out("no tasks");
        return;
    }
    for (const task of tasks) out(describe(task));
}

/**
 * `task start <id> [--agent <id>]`. A `bin/toli spawn` run id started without `--task` (by hand, or by a private
 * helper restarting it) gets the task recorded on its run too, so the run and the task always name each other.
 */
function start(argv: string[]): void {
    const args = new Args(argv, { values: ["agent"] });
    args.maxPositional(1);
    const agent = args.str("agent");
    const task = updateTask(args.pos(0, "id"), (entry) => {
        if (entry.status === "done" || entry.status === "dropped")
            throw new ToliError(`${entry.id} is ${entry.status}`);
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
    out(describe(task));
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
    out(describe(task));
}

function done(argv: string[]): void {
    const args = new Args(argv, { values: ["report", "commit", "note"] });
    args.maxPositional(1);
    const report = args.str("report");
    const commit = args.str("commit");
    const note = args.str("note");
    const task = updateTask(args.pos(0, "id"), (entry) => {
        entry.status = "done";
        entry.doneAt = now().toISOString();
        if (report !== undefined) entry.report = report;
        if (commit !== undefined) entry.commit = commit;
        if (note !== undefined) entry.notes.push(note);
    });
    out(describe(task));
}

/**
 * `task hold <id> --question "..." [--option "<choice> => <then>"]... [--recommend <n|choice|text>] [--blocks "..."]
 * [--reversible]`: put the task in the Needs-you queue. Re-holding replaces every hold field. `--reversible` needs a
 * recommendation and refuses holds about push, merge, main, MR, tag, release, destructive, security or money steps.
 */
function hold(argv: string[]): void {
    const args = new Args(argv, { values: ["question", "option", "recommend", "blocks"], booleans: ["reversible"] });
    args.maxPositional(1);
    const question = args.str("question")?.trim();
    if (!question) throw new ToliError('hold needs --question "..."');
    const options = args.all("option").map(parseOption);
    if (options.length > 0 && (options.length < HOLD_OPTIONS_MIN || options.length > HOLD_OPTIONS_MAX))
        throw new ToliError(`give ${HOLD_OPTIONS_MIN}-${HOLD_OPTIONS_MAX} --option values, or none`);
    const recommendValue = args.str("recommend")?.trim();
    let recommend: string | undefined;
    if (recommendValue) {
        if (options.length === 0) recommend = recommendValue;
        else {
            const match = matchOption(options, recommendValue);
            if (match === undefined)
                throw new ToliError(`--recommend must be an option's number (1-${options.length}) or its choice text`);
            recommend = match.choice;
        }
    }
    const blocks = args.str("blocks")?.trim();
    const reversible = args.bool("reversible");
    if (reversible) {
        if (recommend === undefined)
            throw new ToliError("--reversible needs --recommend (the option applied after the timeout)");
        const topic = irreversibleTopic([
            question,
            blocks,
            ...options.flatMap((option) => [option.choice, option.outcome]),
        ]);
        if (topic !== undefined)
            throw new ToliError(
                `--reversible refused: the hold mentions "${topic}" (push, merge, main, MR, tag, release, destructive, security and money holds always wait for the user)`,
            );
    }
    const task = updateTask(args.pos(0, "id"), (entry) => {
        if (entry.status === "done" || entry.status === "dropped")
            throw new ToliError(`${entry.id} is ${entry.status}`);
        entry.status = "held";
        entry.question = question;
        entry.heldAt = now().toISOString();
        if (options.length > 0) entry.options = options;
        else delete entry.options;
        if (recommend !== undefined) entry.recommend = recommend;
        else delete entry.recommend;
        if (blocks) entry.blocks = blocks;
        else delete entry.blocks;
        if (reversible) entry.reversible = true;
        else delete entry.reversible;
        delete entry.staleSurfacedAt;
        delete entry.heldFrom;
        delete entry.waitingOn;
        delete entry.answer;
    });
    out(describe(task));
}

/**
 * `task answer <id> "<answer>" [--from <machine>]`: record the user's words verbatim, release the task, say it is
 * ready to dispatch, and name every task waiting on it, so the lead that ran this dispatches them in the same turn.
 * It posts no wake: that wake reaches the lead after it dispatched and makes it dispatch the same tasks again (a task
 * nobody dispatched stays queued, or is raised by the tick, src/records/stale.ts). `--from`: another machine's lead
 * forwarded the answer (`task answer <this machine>/T<n>` there); no lead here ran this, so a wake is posted.
 */
function answer(argv: string[]): void {
    const args = new Args(argv, { values: ["from"] });
    args.maxPositional(2);
    const reply = args.pos(1, "answer");
    const from = args.str("from");
    let heldFrom: string | undefined;
    const task = updateTask(args.pos(0, "id"), (entry) => {
        if (entry.status !== "held") throw new ToliError(`${entry.id} is ${entry.status}, not waiting on an answer`);
        if (from !== undefined) requireDelegator(entry, from);
        const chosen = matchOption(entry.options ?? [], reply);
        entry.answer = reply;
        entry.answeredAt = now().toISOString();
        const via = from === undefined ? "" : ` (recorded by ${from}'s lead)`;
        entry.notes.push(`Q: ${entry.question ?? ""}\nA: ${reply}${chosen ? ` (= ${chosen.choice})` : ""}${via}`);
        entry.status = entry.startedAt === undefined ? "queued" : "active";
        heldFrom = entry.heldFrom;
        delete entry.heldFrom;
    });
    out(describe(task));
    if (isValidName(task.project)) recordDecision(task, reply);
    const brief = briefPath(task.project, task.id) ?? `data/projects/${task.project}/briefs/${task.id}.md`;
    out(`unblocked: dispatch ${task.id} now (toli-dispatch skill; put the answer in its brief, ${brief})`);
    for (const line of answerWake(task, loadBacklog().tasks, from !== undefined)) out(line);
    forwardEscalatedAnswer(heldFrom, reply);
}

function drop(argv: string[]): void {
    const args = new Args(argv);
    args.maxPositional(1);
    const task = updateTask(args.pos(0, "id"), (entry) => {
        entry.status = "dropped";
    });
    out(describe(task));
}

/** Run one `task` subcommand; only `list --fleet` returns a promise (callers await it), so the rest throw synchronously. */
export function taskCommand(argv: string[]): Promise<void> | undefined {
    const [sub, ...rest] = argv;
    if (sub !== undefined && [routeToOwner, delegationTaskCommand, pinTaskCommand].some((fn) => fn(sub, rest))) return;
    switch (sub) {
        case "add":
            add(rest);
            break;
        case "list":
            return list(rest);
        case "start":
            start(rest);
            break;
        case "wait":
            wait(rest);
            break;
        case "done":
            done(rest);
            break;
        case "hold":
            hold(rest);
            break;
        case "answer":
            answer(rest);
            break;
        case "drop":
            drop(rest);
            break;
        default:
            throw new ToliError("usage: toli task add|list|start|wait|done|hold|answer|drop|pin|unpin|link|escalate");
    }
}
