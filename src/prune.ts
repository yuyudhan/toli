import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Args } from "./args.ts";
import { loadBacklog, type Task, updateBacklog } from "./backlog.ts";
import { type Machine, machineSettings, type RetentionConfig } from "./config.ts";
import { addInboxItem, listInbox } from "./inbox.ts";
import { queueOutbox } from "./jobs.ts";
import { paths } from "./paths.ts";
import { now, out, printJson, readJson, stamp, ToliError, withLock, writeJsonAtomic } from "./util.ts";

export type Retention = Required<RetentionConfig>;

export const DEFAULT_RETENTION: Retention = {
    jobResultsDays: 30,
    jobResultsKeep: 5,
    tasksDays: 90,
    logsDays: 14,
    inboxDays: 14,
};

/** How often the tick posts the dry-run listing to Malik's inbox. */
export const PRUNE_REPORT_DAYS = 7;

export type PruneKind = "job-result" | "task" | "log" | "inbox";

export type PruneItem = {
    kind: PruneKind;
    /** Repo-relative path, or the task id. */
    target: string;
    ageDays: number;
    action: "delete" | "archive";
    detail: string;
};

type ArchivedTask = Task & { archivedAt: string };
type TaskArchive = { tasks: ArchivedTask[] };

const DAY_MS = 24 * 60 * 60 * 1000;
const STAMP_PREFIX = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/;
const TASK_ARCHIVE = "tasks.json";

/** Defaults overlaid with config/machine.json `retention`; every value must be a non-negative integer. */
export function loadRetention(): Retention {
    const configured = machineSettings().retention ?? {};
    const retention = { ...DEFAULT_RETENTION };
    for (const key of Object.keys(DEFAULT_RETENTION) as (keyof Retention)[]) {
        const value = configured[key];
        if (value === undefined) continue;
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
            throw new ToliError(`config/machine.json retention.${key} must be a non-negative integer`);
        retention[key] = value;
    }
    return retention;
}

/** Time of a file named by `stamp()` (job results, inbox items), else its mtime. */
function fileTime(path: string, name: string): number {
    const match = STAMP_PREFIX.exec(name);
    return match ? Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`) : statSync(path).mtimeMs;
}

function jobResultItems(at: number, retention: Retention): PruneItem[] {
    const base = paths.jobResultsDir();
    if (!existsSync(base)) return [];
    const items: PruneItem[] = [];
    for (const job of readdirSync(base).sort()) {
        const dir = join(base, job);
        if (!statSync(dir).isDirectory()) continue;
        const results = readdirSync(dir)
            .filter((name) => name.endsWith(".md"))
            .map((name) => ({ path: join(dir, name), time: fileTime(join(dir, name), name) }))
            .sort((a, b) => b.time - a.time);
        for (const result of results.slice(retention.jobResultsKeep)) {
            if (at - result.time <= retention.jobResultsDays * DAY_MS) continue;
            items.push({
                kind: "job-result",
                target: relative(paths.root(), result.path),
                ageDays: Math.floor((at - result.time) / DAY_MS),
                action: "delete",
                detail: `job ${job} result (keeps newest ${retention.jobResultsKeep})`,
            });
        }
    }
    return items;
}

/** Finished or dropped tasks old enough to leave the active backlog. */
function oldTasks(tasks: Task[], at: number, retention: Retention): Task[] {
    return tasks.filter(
        (task) =>
            (task.status === "done" || task.status === "dropped") &&
            at - Date.parse(task.doneAt ?? task.updatedAt) > retention.tasksDays * DAY_MS,
    );
}

function logItems(at: number, retention: Retention): PruneItem[] {
    const dir = paths.logsDir();
    if (!existsSync(dir)) return [];
    const items: PruneItem[] = [];
    for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name);
        const info = statSync(path);
        if (!info.isFile() || at - info.mtimeMs <= retention.logsDays * DAY_MS) continue;
        items.push({
            kind: "log",
            target: relative(paths.root(), path),
            ageDays: Math.floor((at - info.mtimeMs) / DAY_MS),
            action: "delete",
            detail: "log not written recently",
        });
    }
    return items;
}

/** Acknowledged inbox items (worker results already delivered and seen); unseen items always stay. */
function inboxItems(at: number, retention: Retention): PruneItem[] {
    return listInbox()
        .filter((item) => !item.unseen)
        .map((item) => ({ item, time: fileTime(item.path, item.file) }))
        .filter(({ time }) => at - time > retention.inboxDays * DAY_MS)
        .map(({ item, time }) => ({
            kind: "inbox" as const,
            target: relative(paths.root(), item.path),
            ageDays: Math.floor((at - time) / DAY_MS),
            action: "delete" as const,
            detail: `acknowledged inbox item from ${item.from}`,
        }));
}

/** Everything prune would remove now. data/reports/ is never considered. */
export function planPrune(at: Date = now()): PruneItem[] {
    const time = at.getTime();
    const retention = loadRetention();
    const tasks = oldTasks(loadBacklog().tasks, time, retention).map((task) => ({
        kind: "task" as const,
        target: task.id,
        ageDays: Math.floor((time - Date.parse(task.doneAt ?? task.updatedAt)) / DAY_MS),
        action: "archive" as const,
        detail: `${task.status} task "${task.title}" -> data/archive/${TASK_ARCHIVE}`,
    }));
    return [...jobResultItems(time, retention), ...tasks, ...logItems(time, retention), ...inboxItems(time, retention)];
}

/**
 * Move old finished tasks to data/archive/tasks.json. The archive is written before the backlog, so a crash in
 * between leaves a task in both files, never in neither.
 */
function archiveTasks(ids: Set<string>, at: Date): number {
    return updateBacklog((backlog) => {
        const moving = oldTasks(backlog.tasks, at.getTime(), loadRetention()).filter((task) => ids.has(task.id));
        if (moving.length === 0) return 0;
        withLock(paths.lock("task-archive"), () => {
            const archive = readJson<TaskArchive>(paths.archive(TASK_ARCHIVE), { tasks: [] });
            const archivedAt = at.toISOString();
            archive.tasks.push(...moving.map((task) => ({ ...task, archivedAt })));
            writeJsonAtomic(paths.archive(TASK_ARCHIVE), archive);
        });
        const moved = new Set(moving.map((task) => task.id));
        backlog.tasks = backlog.tasks.filter((task) => !moved.has(task.id));
        return moving.length;
    });
}

export function applyPrune(items: PruneItem[], at: Date = now()): void {
    for (const item of items) {
        if (item.kind !== "task") rmSync(join(paths.root(), item.target), { force: true });
    }
    const taskIds = new Set(items.filter((item) => item.kind === "task").map((item) => item.target));
    if (taskIds.size > 0) archiveTasks(taskIds, at);
}

export function renderPrune(items: PruneItem[], applied: boolean): string {
    if (items.length === 0) return "prune: nothing to prune";
    const head = applied
        ? `prune: removed ${items.length} item${items.length === 1 ? "" : "s"} (tasks archived, not deleted)`
        : `prune (dry run): ${items.length} item${items.length === 1 ? "" : "s"} would go; nothing changed. Apply with \`bin/toli prune --apply\` only on Malik's word.`;
    const rows = items.map(
        (item) => `  ${item.action}\t${item.kind}\t${item.target}\t${item.ageDays}d\t${item.detail}`,
    );
    return [head, ...rows].join("\n");
}

/**
 * Tick hook: once every PRUNE_REPORT_DAYS, post the dry-run listing to Malik's inbox (a worker queues it for the
 * coordinator's inbox). Never applies anything. Returns a log line, or null when not due.
 */
export function weeklyPruneReport(machine: Machine, at: Date = now()): string | null {
    const last = readJson<{ lastReport?: string }>(paths.pruneState(), {}).lastReport;
    if (last && at.getTime() - Date.parse(last) < PRUNE_REPORT_DAYS * DAY_MS) return null;
    writeJsonAtomic(paths.pruneState(), { lastReport: at.toISOString() });
    const items = planPrune(at);
    if (items.length === 0) return "prune report: nothing to prune";
    const title = `prune dry run on ${machine.name}: ${items.length} item${items.length === 1 ? "" : "s"} would go`;
    const body = renderPrune(items, false);
    if (machine.role === "worker" && machine.coordinator) {
        queueOutbox(machine, title, body, `${stamp(at)}-prune`);
        return `prune report: ${items.length} items, queued for the coordinator inbox`;
    }
    return `prune report: ${items.length} items, ${addInboxItem(machine.name, title, body)}`;
}

export function pruneCommand(argv: string[]): void {
    const args = new Args(argv, { booleans: ["apply", "json"] });
    args.maxPositional(0);
    const at = now();
    const items = planPrune(at);
    if (args.bool("apply")) applyPrune(items, at);
    if (args.bool("json")) printJson({ applied: args.bool("apply"), items });
    else out(renderPrune(items, args.bool("apply")));
}
