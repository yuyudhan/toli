import { Args } from "./args.ts";
import { paths } from "./paths.ts";
import { findProject } from "./projects.ts";
import { MateError, now, out, printJson, readJson, withLock, writeJsonAtomic } from "./util.ts";

export const STATUSES = ["queued", "active", "held", "done", "dropped"] as const;
export type Status = (typeof STATUSES)[number];
export type Shape = "ship" | "scout";

export type Task = {
    id: string;
    project: string;
    title: string;
    shape: Shape;
    status: Status;
    notes: string[];
    question?: string;
    answer?: string;
    report?: string;
    commit?: string;
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    doneAt?: string;
};

type BacklogFile = { nextId: number; tasks: Task[] };

export function loadBacklog(): BacklogFile {
    const backlog = readJson<BacklogFile>(paths.backlog(), { nextId: 1, tasks: [] });
    return { nextId: backlog.nextId ?? 1, tasks: backlog.tasks ?? [] };
}

function updateBacklog<T>(fn: (backlog: BacklogFile) => T): T {
    return withLock(paths.lock("backlog"), () => {
        const backlog = loadBacklog();
        const result = fn(backlog);
        writeJsonAtomic(paths.backlog(), backlog);
        return result;
    });
}

/** Mutate one task by id under the backlog lock and return a copy of the result. */
function updateTask(id: string, fn: (task: Task) => void): Task {
    return updateBacklog((backlog) => {
        const task = backlog.tasks.find((entry) => entry.id === id.toUpperCase());
        if (!task) throw new MateError(`unknown task "${id}"`);
        fn(task);
        task.updatedAt = now().toISOString();
        return { ...task };
    });
}

function parseShape(value: string | undefined, fallback: Shape): Shape {
    if (value === undefined) return fallback;
    if (value !== "ship" && value !== "scout") throw new MateError("--shape must be ship or scout");
    return value;
}

function describe(task: Task): string {
    const extras: string[] = [];
    if (task.status === "held" && task.question) extras.push(`question: ${task.question}`);
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
        throw new MateError(`--status must be one of ${STATUSES.join(", ")}`);
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
    const args = new Args(argv);
    args.maxPositional(1);
    const task = updateTask(args.pos(0, "id"), (entry) => {
        if (entry.status === "done" || entry.status === "dropped")
            throw new MateError(`${entry.id} is ${entry.status}`);
        entry.status = "active";
        entry.startedAt ??= now().toISOString();
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

function hold(argv: string[]): void {
    const args = new Args(argv, { values: ["question"] });
    args.maxPositional(1);
    const question = args.str("question");
    if (!question) throw new MateError('hold needs --question "..."');
    const task = updateTask(args.pos(0, "id"), (entry) => {
        if (entry.status === "done" || entry.status === "dropped")
            throw new MateError(`${entry.id} is ${entry.status}`);
        entry.status = "held";
        entry.question = question;
        delete entry.answer;
    });
    out(describe(task));
}

function answer(argv: string[]): void {
    const args = new Args(argv);
    args.maxPositional(2);
    const reply = args.pos(1, "answer");
    const task = updateTask(args.pos(0, "id"), (entry) => {
        if (entry.status !== "held") throw new MateError(`${entry.id} is ${entry.status}, not waiting on an answer`);
        entry.answer = reply;
        entry.notes.push(`Q: ${entry.question ?? ""}\nA: ${reply}`);
        entry.status = entry.startedAt === undefined ? "queued" : "active";
    });
    out(describe(task));
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
            throw new MateError("usage: mate task add|list|start|done|hold|answer|drop");
    }
}
