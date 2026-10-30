import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Args } from "../core/args.ts";
import { paths } from "../core/paths.ts";
import { isValidName, now, out, printJson, readJson, ToliError, withLock, writeJsonAtomic } from "../core/util.ts";
import { findProject } from "../projects/projects.ts";
import type { Workspace } from "../projects/strategy.ts";

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
    /** When the digest last re-surfaced this hold as stale (once per hold). */
    staleSurfacedAt?: string;
    answer?: string;
    report?: string;
    commit?: string;
    /** The jawan working on it: a harness agent id (`task start --agent`) or a `bin/toli spawn` run id. */
    agent?: string;
    workspace?: TaskWorkspace;
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    doneAt?: string;
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

/** Mutate one task by id under the backlog lock and return a copy of the result. */
export function updateTask(id: string, fn: (task: Task) => void): Task {
    return updateBacklog((backlog) => {
        const task = backlog.tasks.find((entry) => entry.id === id.toUpperCase());
        if (!task) throw new ToliError(`unknown task "${id}"`);
        fn(task);
        task.updatedAt = now().toISOString();
        return { ...task };
    });
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
    return `${task.id}\t${task.status}\t${task.project}\t${task.shape}\t${task.title}${extras.length ? `\t(${extras.join("; ")})` : ""}`;
}

function add(argv: string[]): void {
    const args = new Args(argv, { values: ["shape", "note"] });
    args.maxPositional(2);
    const project = findProject(args.pos(0, "project")).name;
    const title = args.pos(1, "title");
    const shape = parseShape(args.str("shape"), "ship");
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
            notes: note === undefined ? [] : [note],
            createdAt: stamp,
            updatedAt: stamp,
        });
        return taskId;
    });
    out(id);
}

function list(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json"], values: ["status", "project"] });
    args.maxPositional(0);
    const status = args.str("status");
    if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
        throw new ToliError(`--status must be one of ${STATUSES.join(", ")}`);
    }
    const project = args.str("project");
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
        if (agent !== undefined) entry.agent = agent;
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
 * `task hold <id> --question "..." [--option "<choice> => <then>"]... [--recommend <n|choice|text>] [--blocks "..."]`:
 * put the task in the Needs-you queue. Re-holding replaces every hold field.
 */
function hold(argv: string[]): void {
    const args = new Args(argv, { values: ["question", "option", "recommend", "blocks"] });
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
        delete entry.staleSurfacedAt;
        delete entry.answer;
    });
    out(describe(task));
}

/** `task answer <id> "<answer>"`: record the user's words verbatim, release the task, and say it is ready to dispatch. */
function answer(argv: string[]): void {
    const args = new Args(argv);
    args.maxPositional(2);
    const reply = args.pos(1, "answer");
    const task = updateTask(args.pos(0, "id"), (entry) => {
        if (entry.status !== "held") throw new ToliError(`${entry.id} is ${entry.status}, not waiting on an answer`);
        const chosen = matchOption(entry.options ?? [], reply);
        entry.answer = reply;
        entry.notes.push(`Q: ${entry.question ?? ""}\nA: ${reply}${chosen ? ` (= ${chosen.choice})` : ""}`);
        entry.status = entry.startedAt === undefined ? "queued" : "active";
    });
    out(describe(task));
    if (isValidName(task.project)) recordDecision(task, reply);
    out(
        `unblocked: dispatch ${task.id} now (toli-dispatch skill; put the answer in its brief, data/projects/${task.project}/briefs/${task.id}.md)`,
    );
}

/** Append the held question, its options, and the user's verbatim answer to `data/projects/<p>/decisions.md`. */
function recordDecision(task: Task, reply: string): void {
    const file = paths.projectDecisions(task.project);
    const options = task.options ?? [];
    const chosen = matchOption(options, reply);
    const lines = [`- Q: ${task.question ?? ""}`];
    if (options.length > 0)
        lines.push(
            `- Options: ${options.map((option, index) => `${index + 1}. ${option.choice} => ${option.outcome}`).join("; ")}`,
        );
    if (task.recommend !== undefined) lines.push(`- Recommended: ${task.recommend}`);
    lines.push(`- A: ${reply}`);
    if (chosen !== undefined) lines.push(`- Chosen: ${chosen.choice} => ${chosen.outcome}`);
    withLock(paths.lock("decisions"), () => {
        mkdirSync(dirname(file), { recursive: true });
        const head = existsSync(file) ? "" : `# ${task.project} decisions\n`;
        const day = now().toISOString().slice(0, 10);
        appendFileSync(file, `${head}\n## ${day} ${task.id}: ${task.title}\n\n${lines.join("\n")}\n`);
    });
}

function drop(argv: string[]): void {
    const args = new Args(argv);
    args.maxPositional(1);
    const task = updateTask(args.pos(0, "id"), (entry) => {
        entry.status = "dropped";
    });
    out(describe(task));
}

export function taskCommand(argv: string[]): void {
    const [sub, ...rest] = argv;
    switch (sub) {
        case "add":
            add(rest);
            break;
        case "list":
            list(rest);
            break;
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
