// Active tasks no live run works on: the run recorded on the task ended (a `bin/toli spawn` run, or a `bin/toli
// remote` run whose record names the task) some minutes ago, its native harness subagent ended, stopped reporting or
// never reported running (src/records/agents.ts), or no jawan was ever recorded. Nothing else re-dispatches such a
// task, so the digest's Next block lists it first, the tick posts it to the inbox once per ended run (a `[toli wake]`
// for the lead), and `bin/toli fleet check` names it with the fleet's idle machines.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { hasMachine, loadMachine, machineSettings } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { isValidName, now, readJson, ToliError, withLock, writeJsonAtomic } from "../core/util.ts";
import { ACTIVE, type JawanRun, listRuns } from "../jawans/runs.ts";
import { agentState, nativeAgent } from "./agents.ts";
import type { Task } from "./backlog.ts";
import { addInboxItem } from "./inbox.ts";

export const DEFAULT_STALE_TASK_MINUTES = 15;
const LAST_LINE_LIMIT = 300;

/** `oversight.staleTaskMinutes`: how long after its run ended an active task counts as stale. */
export function staleTaskMinutes(): number {
    const raw = machineSettings().oversight?.staleTaskMinutes;
    if (raw === undefined) return DEFAULT_STALE_TASK_MINUTES;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)
        throw new ToliError("config/machine.json oversight.staleTaskMinutes must be a positive number");
    return raw;
}

/**
 * One finished `bin/toli remote` run, read from its record in data/projects/<p>/runs or data/remote. `runId`: the
 * jawan run `exec` recorded on the target (`exec: recorded as run <id>` in the output), when it got that far.
 */
export type RemoteRunRecord = {
    path: string;
    task: string;
    runId: string | null;
    finishedAt: string;
    lastLine: string | null;
};

/** A `bin/toli spawn`/`exec` run id: `j-<yyyymmdd>-<hhmmss>-<4 hex>`. */
const RUN_ID = /\bj-\d{8}-\d{6}-[0-9a-f]{4}\b/;

/** An answer recorded after the stale task's run ended that it may be waiting on. */
export type StaleAnswer = { id: string; answer: string; at: string };

export type StaleTask = {
    id: string;
    project: string;
    title: string;
    agent: string | null;
    /** When the task last changed (the tick gives a task with no jawan this long before posting it). */
    changedAt: string;
    /**
     * `none`: no jawan recorded; `ended`: its recorded run finished (or its native subagent reported its end); `gone`:
     * its spawn run's record is missing; `session`: its native subagent's lead session (`session`) is no longer
     * running, so the subagent died with it; `silent`: its native subagent stopped reporting running, or never did
     * (`evidence` null); `waiting`: deliberately waits on `waitingOn` (`task wait`), so it needs no re-dispatch.
     */
    reason: "none" | "ended" | "gone" | "session" | "silent" | "waiting";
    /** The pid of the lead session a `session` task's subagent died with; null otherwise. */
    session: number | null;
    /** What a `waiting` task waits on; null otherwise. */
    waitingOn: string | null;
    /**
     * When the run ended (`gone`: when the task last changed; `session`: when the agent was recorded; `silent`: its
     * last report, else when it was recorded); null for `none`.
     */
    endedAt: string | null;
    /** The run's last report line (its outcome inbox item or remote output), when there is one. */
    lastLine: string | null;
    /** The file that shows the run ended (or a `silent` agent's last report), relative to the toli root. */
    evidence: string | null;
    answers: StaleAnswer[];
};

function lastLineOf(text: string): string | null {
    const line = text
        .split("\n")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "")
        .at(-1);
    if (line === undefined) return null;
    return line.length <= LAST_LINE_LIMIT ? line : `${line.slice(0, LAST_LINE_LIMIT)}...`;
}

/** Parse one remote run record; null when the file is not one or names no task. */
export function parseRemoteRecord(path: string, text: string): RemoteRunRecord | null {
    if (!text.startsWith("# remote ")) return null;
    const promptStart = text.indexOf("\n## Prompt\n");
    const outputStart = text.indexOf("\n## Output\n", Math.max(0, promptStart));
    const header = promptStart < 0 ? text : text.slice(0, promptStart);
    const finishedAt = /^- finished: (\S+)$/m.exec(header)?.[1];
    if (finishedAt === undefined) return null;
    const prompt = promptStart < 0 ? "" : text.slice(promptStart, outputStart < 0 ? undefined : outputStart);
    // Records from before `- task:` name their task only in the brief's `# Task T<n>` heading.
    const task = /^- task: (T\d+)$/im.exec(header)?.[1] ?? /^#\s*Task\s+(T\d+)\b/m.exec(prompt)?.[1];
    if (task === undefined) return null;
    const output = outputStart < 0 ? "" : text.slice(outputStart + "\n## Output\n".length);
    const runId = new RegExp(`^exec: recorded as run (${RUN_ID.source})`, "m").exec(output)?.[1] ?? null;
    return { path, task: task.toUpperCase(), runId, finishedAt, lastLine: lastLineOf(output) };
}

/** Every remote run record modified at or after `sinceMs` (epoch milliseconds) that names a task. */
export function listRemoteRecords(sinceMs: number): RemoteRunRecord[] {
    const base = paths.projectsDataDir();
    const projects = existsSync(base)
        ? readdirSync(base, { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .map((entry) => paths.projectRunsDir(entry.name))
        : [];
    const records: RemoteRunRecord[] = [];
    for (const dir of [paths.remoteDir(), ...projects]) {
        if (!existsSync(dir)) continue;
        for (const file of readdirSync(dir)) {
            if (!file.endsWith(".md")) continue;
            const path = join(dir, file);
            if (statSync(path).mtimeMs < sinceMs) continue;
            const record = parseRemoteRecord(path, readFileSync(path, "utf8"));
            if (record !== null) records.push(record);
        }
    }
    return records;
}

/** Whether `text` names task `id` as a whole word. */
export function mentions(text: string | null | undefined, id: string): boolean {
    return text !== null && text !== undefined && new RegExp(`\\b${id}\\b`).test(text);
}

/**
 * Answers recorded after `since` that `task` may be waiting on: its own, its project's, or one naming it. Answers from
 * before `answeredAt` was recorded fall back to the task's last change.
 */
function answersSince(task: Task, tasks: Task[], since: string, lastLine: string | null): StaleAnswer[] {
    return tasks
        .flatMap((entry) => {
            const at = entry.answeredAt ?? entry.updatedAt;
            const related =
                entry.id === task.id ||
                entry.project === task.project ||
                mentions(entry.blocks, task.id) ||
                mentions(lastLine, entry.id);
            return entry.answer !== undefined && entry.status !== "held" && at > since && related
                ? [{ id: entry.id, answer: entry.answer, at }]
                : [];
        })
        .sort((a, b) => a.at.localeCompare(b.at));
}

function readLastLine(path: string | null): string | null {
    if (path === null || !existsSync(path)) return null;
    return lastLineOf(readFileSync(path, "utf8"));
}

export type StaleInput = { at: Date; minutes: number; runs: JawanRun[]; records: RemoteRunRecord[] };

/**
 * The run that carries on `run`: follow its continuations (`resumedBy`) and replacements (`replacedBy`) to the latest
 * one, so a task naming an earlier run of a resumed or restarted chain is judged by the run working now.
 */
function latestOfChain(run: JawanRun, runs: JawanRun[]): JawanRun {
    const seen = new Set<string>([run.id]);
    let latest = run;
    for (;;) {
        const nextId = latest.resumedBy ?? latest.replacedBy;
        const next = nextId === undefined || seen.has(nextId) ? undefined : runs.find((entry) => entry.id === nextId);
        if (next === undefined) return latest;
        seen.add(next.id);
        latest = next;
    }
}

/**
 * The active tasks in `tasks` that no live run works on (or that wait on something, `task wait`), oldest end first. A
 * task answered less than the grace minutes ago is not among them: its lead is dispatching it.
 */
export function staleTasks(tasks: Task[], input: StaleInput): StaleTask[] {
    const graceMs = input.minutes * 60_000;
    const found: StaleTask[] = [];
    for (const task of tasks) {
        if (task.status !== "active") continue;
        if (input.runs.some((run) => run.task === task.id && ACTIVE.includes(run.status))) continue;
        // The latest run of the chain the task names is alive, even when that run carries no task id.
        const named = task.agent === undefined ? undefined : input.runs.find((entry) => entry.id === task.agent);
        const latest = named === undefined ? undefined : latestOfChain(named, input.runs);
        if (latest !== undefined && ACTIVE.includes(latest.status)) continue;
        // The lead dispatches an answered task in the turn that recorded the answer. The grace minutes run from the
        // answer too, however long ago its old run ended, so the tick never tells the lead to re-dispatch what it is
        // dispatching right now.
        if (task.answeredAt !== undefined && input.at.getTime() - Date.parse(task.answeredAt) < graceMs) continue;
        const base = {
            waitingOn: null,
            session: null,
            id: task.id,
            project: task.project,
            title: task.title,
            agent: task.agent ?? null,
            changedAt: task.updatedAt,
        };
        const dispatched = task.dispatchedAt ?? task.startedAt ?? task.createdAt;
        let end: Pick<StaleTask, "reason" | "endedAt" | "lastLine" | "evidence"> & Partial<Pick<StaleTask, "session">>;
        if (task.waitingOn !== undefined) {
            found.push({
                ...base,
                waitingOn: task.waitingOn,
                reason: "waiting",
                endedAt: null,
                lastLine: null,
                evidence: null,
                answers: [],
            });
            continue;
        }
        if (task.agent === undefined) {
            end = { reason: "none", endedAt: null, lastLine: null, evidence: null };
        } else if (task.agent.startsWith("j-")) {
            if (latest === undefined) end = { reason: "gone", endedAt: task.updatedAt, lastLine: null, evidence: null };
            else
                end = {
                    reason: "ended",
                    endedAt: latest.endedAt ?? latest.startedAt,
                    lastLine: readLastLine(latest.inbox),
                    evidence: relative(paths.root(), latest.inbox ?? paths.jawanRecord(latest.id)),
                };
        } else {
            // An agent naming its run on the target (`remote:<machine>:j-...`) is ended only by that run's record: an
            // earlier, killed dispatch of the same task finishing after the new one was recorded says nothing about it.
            const agentRun = RUN_ID.exec(task.agent)?.[0];
            const record = input.records
                .filter(
                    (entry) =>
                        entry.task === task.id &&
                        entry.finishedAt > dispatched &&
                        (agentRun === undefined || entry.runId === agentRun),
                )
                .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))
                .at(-1);
            // A `bin/toli remote` run is ended only by its record, and a task delegated away is the other machine's;
            // a native subagent is live only while it reports running (src/records/agents.ts).
            if (record !== undefined)
                end = {
                    reason: "ended",
                    endedAt: record.finishedAt,
                    lastLine: record.lastLine,
                    evidence: relative(paths.root(), record.path),
                };
            else if (!nativeAgent(task)) continue;
            else {
                const agent = agentState(task, input.at, input.minutes);
                if (agent.state === "live") continue;
                end =
                    agent.state === "session"
                        ? { reason: "session", session: agent.pid, endedAt: dispatched, lastLine: null, evidence: null }
                        : agent.state === "ended"
                          ? { reason: "ended", endedAt: agent.at, lastLine: null, evidence: agent.evidence }
                          : { reason: "silent", endedAt: agent.since, lastLine: null, evidence: agent.evidence };
            }
        }
        if (end.endedAt !== null && input.at.getTime() - Date.parse(end.endedAt) < graceMs) continue;
        found.push({ ...base, ...end, answers: answersSince(task, tasks, end.endedAt ?? dispatched, end.lastLine) });
    }
    return found.sort((a, b) => (a.endedAt ?? "").localeCompare(b.endedAt ?? ""));
}

/** The stale active tasks among `tasks` (this machine's backlog), from its spawn runs and remote run records. */
export function findStaleTasks(tasks: Task[], at: Date = now()): StaleTask[] {
    const active = tasks.filter((task) => task.status === "active");
    if (active.length === 0) return [];
    const earliest = Math.min(
        ...active.map((task) => Date.parse(task.dispatchedAt ?? task.startedAt ?? task.createdAt)),
    );
    return staleTasks(tasks, {
        at,
        minutes: staleTaskMinutes(),
        runs: listRuns(),
        records: listRemoteRecords(Number.isFinite(earliest) ? earliest : 0),
    });
}

function ago(at: Date, iso: string): string {
    const minutes = Math.max(0, Math.round((at.getTime() - Date.parse(iso)) / 60_000));
    return minutes < 120 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

/** How the task's jawan ended, for staleLine. */
function howEnded(task: StaleTask, at: Date): string {
    const when = ago(at, task.endedAt ?? "");
    const evidence = task.evidence === null ? "" : ` (${task.evidence})`;
    switch (task.reason) {
        case "none":
            return "no running jawan is recorded on it";
        case "gone":
            return `its run ${task.agent} has no record left (task last changed ${when})`;
        case "session":
            return `its agent ${task.agent} died with its session ${task.session ?? "?"} (dispatched ${when})`;
        case "silent":
            return task.evidence === null
                ? `its agent ${task.agent} never reported running (dispatched ${when})`
                : `its agent ${task.agent} has not reported running since ${when}${evidence}`;
        default:
            return `its run ${task.agent} ended ${when}${evidence}`;
    }
}

/** One line naming the task, how its run ended, its last report line and any answer recorded since. */
export function staleLine(task: StaleTask, at: Date = now()): string {
    if (task.reason === "waiting") return `${task.id} (${task.project}) is active, waiting on ${task.waitingOn ?? "?"}`;
    const how = howEnded(task, at);
    const last = task.lastLine === null ? "" : `; last report line: "${task.lastLine}"`;
    const answers =
        task.reason === "none"
            ? ""
            : task.answers.length === 0
              ? "; no answer recorded since"
              : `; answer recorded since: ${task.answers.map((answer) => `${answer.id} "${answer.answer}"`).join(", ")}`;
    return `${task.id} (${task.project}) is active but ${how}${last}${answers}`;
}

/** What the lead does about a stale task: dispatch one, re-dispatch it (naming its brief), or nothing while it waits. */
export function redispatchCommand(task: Pick<StaleTask, "id" | "project" | "reason" | "waitingOn">): string {
    if (task.reason === "waiting")
        return `nothing to dispatch while it waits; once that is through it gets a jawan (bin/toli task start ${task.id} --agent <id>) or moves on by itself`;
    const brief = briefPath(task.project, task.id) ?? "<file>";
    if (task.reason === "none")
        return `dispatch one and record it (bin/toli task start ${task.id} --agent <id>, or bin/toli spawn --task ${task.id} --brief ${brief}), or hold/drop it`;
    return `re-dispatch it now (bin/toli spawn --task ${task.id} --brief ${brief}, or bin/toli task start ${task.id} --agent <id>), or hold/drop/done it`;
}

/** The task's brief under data/projects/<p>/briefs (`T<n>.md`, else `T<n>-*.md`), relative to the root; else null. */
export function briefPath(project: string, id: string): string | null {
    if (!isValidName(project)) return null;
    const dir = paths.projectBriefsDir(project);
    if (!existsSync(dir)) return null;
    const exact = join(dir, `${id}.md`);
    if (existsSync(exact)) return relative(paths.root(), exact);
    const match = readdirSync(dir)
        .filter((file) => file.endsWith(".md") && new RegExp(`^${id}[-_.]`).test(file))
        .sort()[0];
    return match === undefined ? null : relative(paths.root(), join(dir, match));
}

/** The inbox sender for oversight items: this machine's name. */
export function fromName(): string {
    return hasMachine() ? loadMachine().name : "toli";
}

type SurfacedState = { surfaced: Record<string, string> };

/** What makes a stale finding new: the run's end, or for a task with no jawan, when it became active. */
function surfaceKey(task: StaleTask): string {
    return `${task.reason}:${task.endedAt ?? ""}:${task.agent ?? ""}`;
}

/**
 * The tick's oversight: post every newly stale active task among `tasks` to the inbox in one item (a `[toli wake]`
 * for the lead), once per ended run; a task with no jawan recorded waits the same grace minutes from its last change.
 * Returns the log line, or null when nothing is new.
 */
export function surfaceStaleTasks(tasks: Task[], at: Date = now()): string | null {
    const graceMs = staleTaskMinutes() * 60_000;
    const stale = findStaleTasks(tasks, at).filter(
        (task) =>
            task.reason !== "waiting" &&
            (task.reason !== "none" || at.getTime() - Date.parse(task.changedAt) >= graceMs),
    );
    const fresh = withLock(paths.lock("stale-tasks"), () => {
        const state = readJson<SurfacedState>(paths.staleTasksState(), { surfaced: {} });
        const surfaced = state.surfaced ?? {};
        const ids = new Set(stale.map((task) => task.id));
        const news = stale.filter((task) => surfaced[task.id] !== surfaceKey(task));
        const next: Record<string, string> = {};
        for (const [id, key] of Object.entries(surfaced)) if (ids.has(id)) next[id] = key;
        for (const task of news) next[task.id] = surfaceKey(task);
        writeJsonAtomic(paths.staleTasksState(), { surfaced: next });
        return news;
    });
    if (fresh.length === 0) return null;
    const path = addInboxItem(
        fromName(),
        `${fresh.length} active task${fresh.length === 1 ? " has" : "s have"} no live run`,
        [
            "Lead: nothing is working on these. Re-dispatch each now (put any recorded answer in its brief), or hold,",
            "drop or close it. Its jawan's last line says what it stopped on.",
            "",
            ...fresh.map((task) => `- ${staleLine(task, at)}\n  ${redispatchCommand(task)}`),
        ].join("\n"),
    );
    return `stale tasks: ${fresh.map((task) => task.id).join(", ")} posted to ${relative(paths.root(), path)}`;
}
