import { Args } from "../core/args.ts";
import { paths } from "../core/paths.ts";
import {
    isValidName,
    now,
    out,
    printJson,
    readJson,
    requireName,
    ToliError,
    withLock,
    writeJsonAtomic,
} from "../core/util.ts";
import { parseOptionalTier, type Tier } from "../harness/models.ts";
import { findProject } from "../projects/projects.ts";
import type { Workspace } from "../projects/strategy.ts";
import { recordDecision } from "./decisions.ts";
import { reportDue, reportToDelegator } from "./delegation-report.ts";
import { listFleet, routeToOwner } from "./fleet-tasks.ts";
import { answerWake, briefPath } from "./stale.ts";

/** Who handed a task to this machine (`bin/toli delegate`, docs/sardars.md); results and questions go back there. */
export type DelegatedBy = { machine: string; task?: string; id: string; at: string };

/** Where a task's jawans work, recorded when its workspace is prepared (src/projects/workspace.ts). `base`: per-task only. */
export type TaskWorkspace = { strategy: Workspace; path: string; branch: string | null; base: string | null };

export const STATUSES = ["queued", "active", "held", "done", "dropped"] as const;
export type Status = (typeof STATUSES)[number];
export type Shape = "ship" | "scout";

/** One answer a held task offers the user, and what the lead does if it is chosen. */
export type HoldOption = { choice: string; outcome: string };

/** How many options a held question offers when it offers any. */
export const HOLD_OPTIONS_MIN = 2;
export const HOLD_OPTIONS_MAX = 4;

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
    workspace?: TaskWorkspace;
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    doneAt?: string;
    /** Set on a task another machine's lead delegated here: its report goes back to that machine. */
    delegatedBy?: DelegatedBy;
    /** Fleet ids (`<machine>/T<n>`) of tasks this one was delegated as. */
    delegatedTo?: string[];
};

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
 * held or dropped reports to its delegator once the lock is released (src/records/delegation-report.ts).
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
    return after;
}

function parseShape(value: string | undefined, fallback: Shape): Shape {
    if (value === undefined) return fallback;
    if (value !== "ship" && value !== "scout") throw new ToliError("--shape must be ship or scout");
    return value;
}

function describe(task: Task): string {
    const extras: string[] = [];
    if (task.status === "held" && task.question) extras.push(`question: ${task.question}`);
    if (task.agent) extras.push(`agent: ${task.agent}`);
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
        }
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

/** Parse one `--option "<choice> => <what happens then>"`. */
function parseOption(value: string): HoldOption {
    const at = value.indexOf("=>");
    const choice = at === -1 ? "" : value.slice(0, at).trim();
    const outcome = at === -1 ? "" : value.slice(at + 2).trim();
    if (choice === "" || outcome === "")
        throw new ToliError(`--option must be "<choice> => <what happens then>", got "${value}"`);
    return { choice, outcome };
}

/** The option a reply or recommendation names: its 1-based number or its exact choice text (any case). */
export function matchOption(options: HoldOption[], value: string): HoldOption | undefined {
    const text = value.trim();
    if (/^\d+$/.test(text)) return options[Number(text) - 1];
    return options.find((option) => option.choice.toLowerCase() === text.toLowerCase());
}

/**
 * Words that make a hold never auto-applied, whatever the caller says: push, merge, main, MR/PR, tag, release,
 * destructive or irreversible steps, security, money. Returns the first word found, else undefined.
 */
const IRREVERSIBLE_WORDS =
    /\b(push(?:es|ed|ing)?|merg(?:e|es|ed|ing)|main|master|MRs?|PRs?|merge requests?|pull requests?|tags?|releases?|deploy(?:s|ed|ing|ment)?|delet(?:e|es|ed|ing)|drop(?:s|ped|ping)?|destroy(?:s|ed|ing)?|destructive|irreversible|force|wipe|reset|rm|security|secrets?|credentials?|passwords?|tokens?|permissions?|auth|money|payments?|billing|cost|price|pricing)\b/i;

export function irreversibleTopic(texts: (string | undefined)[]): string | undefined {
    for (const text of texts) {
        const match = text === undefined ? null : IRREVERSIBLE_WORDS.exec(text);
        if (match) return match[0];
    }
    return undefined;
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
        delete entry.answer;
    });
    out(describe(task));
}

/**
 * `task answer <id> "<answer>" [--from <machine>]`: record the user's words verbatim, release the task, say it is
 * ready to dispatch, and name (and post as a wake) every task waiting on it, so the lead re-dispatches them in the
 * same turn. `--from`: the answer was forwarded by another machine's lead (`task answer <this machine>/T<n>` there),
 * which the task's notes record; the wake posted here makes this machine's lead dispatch it.
 */
function answer(argv: string[]): void {
    const args = new Args(argv, { values: ["from"] });
    args.maxPositional(2);
    const reply = args.pos(1, "answer");
    const from = args.str("from");
    if (from !== undefined) requireName("machine", from);
    const task = updateTask(args.pos(0, "id"), (entry) => {
        if (entry.status !== "held") throw new ToliError(`${entry.id} is ${entry.status}, not waiting on an answer`);
        const chosen = matchOption(entry.options ?? [], reply);
        entry.answer = reply;
        entry.answeredAt = now().toISOString();
        const via = from === undefined ? "" : ` (recorded by ${from}'s lead)`;
        entry.notes.push(`Q: ${entry.question ?? ""}\nA: ${reply}${chosen ? ` (= ${chosen.choice})` : ""}${via}`);
        entry.status = entry.startedAt === undefined ? "queued" : "active";
    });
    out(describe(task));
    if (isValidName(task.project)) recordDecision(task, reply);
    const brief = briefPath(task.project, task.id) ?? `data/projects/${task.project}/briefs/${task.id}.md`;
    out(`unblocked: dispatch ${task.id} now (toli-dispatch skill; put the answer in its brief, ${brief})`);
    for (const line of answerWake(task, loadBacklog().tasks)) out(line);
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
    if (sub !== undefined && routeToOwner(sub, rest)) return;
    switch (sub) {
        case "add":
            add(rest);
            break;
        case "list":
            return list(rest);
        case "start":
            start(rest);
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
            throw new ToliError("usage: toli task add|list|start|done|hold|answer|drop");
    }
}
