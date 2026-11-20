import { Args } from "../core/args.ts";
import { paths } from "../core/paths.ts";
import { isValidName, now, out, printJson, readJson, ToliError, withLock, writeJsonAtomic } from "../core/util.ts";
import { parseOptionalTier, type Tier } from "../harness/models.ts";
import { cancelQueuedRuns } from "../jawans/runs.ts";
import { findProject } from "../projects/projects.ts";
import type { Workspace } from "../projects/strategy.ts";
import { answerWake } from "./answer-wake.ts";
import { recordDecision } from "./decisions.ts";
import { forwardEscalatedAnswer, noteLateAnswer, requireDelegator } from "./delegated-answer.ts";
import { type DelegationFields, reportDue, reportToDelegator } from "./delegation-report.ts";
import { delegationTaskCommand } from "./delegation-sync.ts";
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
import { holderName, ownTask, requireOwnReport } from "./task-guard.ts";
import { describeTask } from "./task-line.ts";
import { parseShape } from "./task-shape.ts";
import { startTaskCommand } from "./task-start.ts";

/**
 * Where a task's jawans work, recorded when its workspace is prepared (src/projects/workspace.ts). `base`: per-task
 * only. `pinned`: the task was pinned to the clone (`workspace prepare --same-branch`) and keeps it until `--reset`.
 */
export type TaskWorkspace = {
    strategy: Workspace;
    path: string;
    branch: string | null;
    base: string | null;
    pinned?: true;
};

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
     * gone pid frees its jawan slot and the task needs a re-dispatch (src/records/agents.ts agentSessionGone).
     */
    agentSession?: { agent: string; pid: number };
    /**
     * `task wait --on "<what>"`: the task is active but deliberately waits on something outside a jawan (a deferred
     * spawn, a push, another task, a slice `delegate --for` handed to another machine); oversight reports it as
     * waiting, never as needing a re-dispatch. Recording a new jawan, holding, finishing or dropping the task clears it.
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
    for (const task of tasks) out(describeTask(task));
}

/**
 * Cancel the queued jawan runs of task `id`, now `how` (done, dropped, handed back), naming each: they never start.
 * A run already started is left to finish, never signalled.
 */
export function cancelQueuedRunsOf(id: string, how: string): void {
    for (const run of cancelQueuedRuns(id, `${id} is ${how}`))
        out(`${id}: cancelled queued run ${run.id}; it never started`);
}

/** `task done <id> [--report <file>] [--commit <sha>] [--note "..."]`; the task's queued runs are cancelled. */
function done(argv: string[]): void {
    const args = new Args(argv, { values: ["report", "commit", "note"] });
    args.maxPositional(1);
    const report = args.str("report");
    const commit = args.str("commit");
    const note = args.str("note");
    const task = updateTask(ownTask(args.pos(0, "id")), (entry) => {
        requireOwnReport(report, entry);
        entry.status = "done";
        entry.doneAt = now().toISOString();
        if (report !== undefined) entry.report = report;
        if (commit !== undefined) entry.commit = commit;
        if (note !== undefined) entry.notes.push(note);
    });
    out(describeTask(task));
    cancelQueuedRunsOf(task.id, "done");
}

/**
 * `task hold <id> --question "..." --option "<choice> => <then>" --option ... [--recommend <n|choice>] [--blocks "..."]
 * [--reversible]`: put the task in the Needs-you queue. A hold needs its question and 2-4 options, so the user answers
 * it by number; anything less is refused before the task changes. Re-holding replaces every hold field. A done or
 * dropped task is reopened as held, with a note naming who reopened it, so a question from a job still running is
 * never lost. `--reversible` needs a recommendation and refuses holds about push, merge, main, MR, tag, release,
 * destructive, security or money steps.
 */
function hold(argv: string[]): void {
    const args = new Args(argv, { values: ["question", "option", "recommend", "blocks"], booleans: ["reversible"] });
    args.maxPositional(1);
    const question = args.str("question")?.trim();
    const options = args.all("option").map(parseOption);
    if (!question || options.length < HOLD_OPTIONS_MIN || options.length > HOLD_OPTIONS_MAX)
        throw new ToliError(
            `hold needs --question "..." and ${HOLD_OPTIONS_MIN}-${HOLD_OPTIONS_MAX} --option "<choice> => <what happens then>" values, so the user answers by number; got ${question ? "" : "no question and "}${options.length}`,
        );
    const recommendValue = args.str("recommend")?.trim();
    let recommend: string | undefined;
    if (recommendValue) {
        const match = matchOption(options, recommendValue);
        if (match === undefined)
            throw new ToliError(`--recommend must be an option's number (1-${options.length}) or its choice text`);
        recommend = match.choice;
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
    let reopened: string | undefined;
    const task = updateTask(ownTask(args.pos(0, "id")), (entry) => {
        if (entry.status === "done" || entry.status === "dropped") {
            reopened = `reopened from ${entry.status} by ${holderName()} to hold on a question`;
            entry.notes.push(reopened);
            delete entry.doneAt;
        }
        entry.status = "held";
        entry.question = question;
        entry.heldAt = now().toISOString();
        entry.options = options;
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
    out(describeTask(task));
    if (reopened !== undefined) out(`${task.id}: ${reopened}; the question is in bin/toli needs`);
}

/**
 * `task answer <id> "<answer>" [--from <machine> [--answer-id <id>]]`: record the user's words verbatim, release the
 * task and name every task waiting on it, so the lead that ran this dispatches them in the same turn (no wake: it would
 * dispatch them twice). `--from`: the delegator's lead forwarded it, so a wake is posted; noteLateAnswer when it is not
 * held. `--answer-id`: the delivered item's id; a copy of an answer already applied here is dropped (T2151).
 */
function answer(argv: string[]): void {
    const args = new Args(argv, { values: ["from", "answer-id"] });
    args.maxPositional(2);
    const reply = args.pos(1, "answer");
    const from = args.str("from");
    const answerId = args.str("answer-id");
    let heldFrom: string | undefined;
    let late = false;
    let repeat = false;
    const task = updateTask(args.pos(0, "id"), (entry) => {
        if (answerId !== undefined && entry.answerIds?.includes(answerId)) {
            repeat = true;
            return;
        }
        late = noteLateAnswer(entry, from, reply);
        if (answerId !== undefined) entry.answerIds = [...(entry.answerIds ?? []), answerId];
        if (late) return;
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
    if (repeat) {
        out(`${task.id}: answer ${answerId} is already applied here; this copy is dropped`);
        return;
    }
    out(describeTask(task));
    if (late) return;
    if (isValidName(task.project)) recordDecision(task, reply);
    const brief = briefPath(task.project, task.id) ?? `data/projects/${task.project}/briefs/${task.id}.md`;
    out(`unblocked: dispatch ${task.id} now (toli-dispatch skill; put the answer in its brief, ${brief})`);
    for (const line of answerWake(task, loadBacklog().tasks, from !== undefined)) out(line);
    forwardEscalatedAnswer(heldFrom, reply);
}

/**
 * `task drop <id>`: the task is dropped and its queued jawan runs are cancelled (never started), each named in the
 * output; a run already started is left to finish, never signalled.
 */
function drop(argv: string[]): void {
    const args = new Args(argv);
    args.maxPositional(1);
    const task = updateTask(ownTask(args.pos(0, "id")), (entry) => {
        entry.status = "dropped";
    });
    out(describeTask(task));
    cancelQueuedRunsOf(task.id, "dropped");
}

/** Run one `task` subcommand; only `list --fleet` returns a promise (callers await it), so the rest throw synchronously. */
export function taskCommand(argv: string[]): Promise<void> | undefined {
    const [sub, ...rest] = argv;
    const delegated = [routeToOwner, delegationTaskCommand, pinTaskCommand, startTaskCommand];
    if (sub !== undefined && delegated.some((fn) => fn(sub, rest))) return;
    switch (sub) {
        case "add":
            add(rest);
            break;
        case "list":
            return list(rest);
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
