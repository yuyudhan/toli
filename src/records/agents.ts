// Whether a native harness subagent recorded on a task (`task start T<n> --agent <id>`) is running. A live lead
// session is no evidence: one interactive omp lives for days while the subagents it started finish within the hour,
// so the session being alive says nothing about any one of them (T1419). The evidence is the agent's report,
// state/agents/<id>.json, which its harness writes while it runs:
// - omp: the extension in the session that started the subagent reads that session's async jobs every minute
//   (SubagentWatch) and reports each running `task` subagent with its omp pid, then its end once it stops running.
//   The subagent's own session is no reporter: an interactive omp does not always load extensions there (T1541).
// - Claude Code: its hooks (`bin/toli hook claude-agent`) report the subagent at SubagentStart, after each of its tool
//   calls and at SubagentStop. Such a report names no pid and counts while it is fresher than the grace minutes.
// An agent no harness reports (a label such as `fleet talk`) counts as running only for the grace minutes after it
// was recorded. A label naming another fleet machine (`<machine> coordinates (talk ...)`) is no agent here: that
// machine holds the work (T1427). A lead omp whose extension does not watch its subagents (its
// state/agent-sessions/<pid>.json is missing or predates `watches`) keeps the earlier rule until it restarts: its
// subagents run while it does (T1429).
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hasMachine, loadFleet, loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { isJsonObject, isValidName, pidAlive, readJson, writeJsonAtomic } from "../core/util.ts";
import type { Task } from "./backlog.ts";
import { liveDelegations } from "./delegation-report.ts";

/** How often the omp extension reports the subagents its session runs (the watch's beat). */
export const AGENT_REPORT_EVERY_MS = 60_000;
/** A beat report older than this, from a subagent that has not ended, means its omp hung or was killed. */
export const AGENT_REPORT_TIMEOUT_MS = 3 * AGENT_REPORT_EVERY_MS;

/**
 * state/agents/<id>.json: when subagent `<id>` last reported running and, once it finished, its end. `pid`: the omp
 * that reports it every beat; absent from a report sent on the agent's own activity (a Claude Code hook's).
 */
export type AgentReport = { pid?: number; at: string; endedAt?: string };

const AGENTS_DIR = join("state", "agents");
/** state/agent-sessions/<pid>.json: omp `pid` runs an extension that watches its subagents (markWatchingSession). */
const SESSIONS_DIR = join("state", "agent-sessions");

/** A watching omp's mark: its pid, when its extension started watching, and `watches` (absent from older marks). */
export type WatchingSession = { pid: number; startedAt: string; watches: true };

/**
 * Mark omp `pid` as one whose extension watches its subagents, and remove the marks of omp processes that are gone,
 * so a reused pid never inherits one.
 */
export function markWatchingSession(root: string, pid: number, at: Date): void {
    const dir = join(root, SESSIONS_DIR);
    mkdirSync(dir, { recursive: true });
    for (const file of readdirSync(dir)) {
        const marked = Number(file.replace(/\.json$/, ""));
        if (marked !== pid && !(Number.isInteger(marked) && marked > 0 && pidAlive(marked)))
            rmSync(join(dir, file), { force: true });
    }
    writeJsonAtomic(join(dir, `${pid}.json`), {
        pid,
        startedAt: at.toISOString(),
        watches: true,
    } satisfies WatchingSession);
}

/** Whether lead session `pid` runs an extension that watches its subagents (false: it predates the watch). */
function sessionWatches(pid: number): boolean {
    const mark = readJson<unknown>(join(paths.root(), SESSIONS_DIR, `${pid}.json`), null);
    return isJsonObject(mark) && mark.watches === true;
}

/** The agent's report, relative to the toli root; null for an id that cannot name a file. */
export function agentReportFile(id: string): string | null {
    return isValidName(id) ? join(AGENTS_DIR, `${id}.json`) : null;
}

/** Write agent `id`'s report under toli root `root`; false (nothing written) for an id that cannot name a file. */
function writeReport(root: string, id: string, report: AgentReport): boolean {
    const file = agentReportFile(id);
    if (file === null) return false;
    mkdirSync(join(root, AGENTS_DIR), { recursive: true });
    writeJsonAtomic(join(root, file), report);
    return true;
}

/**
 * The agent ids of the `task` subagents an omp session's async-job snapshot (`ctx.getAsyncJobSnapshot()`) lists as
 * running; none for a session without one or a snapshot shaped otherwise.
 */
export function runningSubagents(snapshot: unknown): string[] {
    if (!isJsonObject(snapshot) || !Array.isArray(snapshot.running)) return [];
    const ids: string[] = [];
    for (const job of snapshot.running as unknown[])
        if (isJsonObject(job) && job.type === "task" && typeof job.agentId === "string") ids.push(job.agentId);
    return ids;
}

/**
 * The extension's watch over the subagents one omp session runs: every beat (`observe`) it reports each running one
 * with the omp pid, and the end of each that ran at the previous beat and no longer does. A resumed subagent runs
 * again; observing none at the session's end ends them all.
 */
export class SubagentWatch {
    readonly #root: string;
    readonly #pid: number;
    #running = new Set<string>();

    constructor(root: string, pid: number) {
        this.#root = root;
        this.#pid = pid;
    }

    observe(running: readonly string[], at: Date): void {
        const stamp = at.toISOString();
        const now = new Set<string>();
        for (const id of running) if (writeReport(this.#root, id, { pid: this.#pid, at: stamp })) now.add(id);
        for (const id of this.#running)
            if (!now.has(id)) writeReport(this.#root, id, { pid: this.#pid, at: stamp, endedAt: stamp });
        this.#running = now;
    }
}

/** What a Claude Code hook saw subagent `id` do: start, finish a tool call, or stop. */
export type HookAgentEvent = "start" | "tool" | "stop";

/**
 * Record a Claude Code hook's report on subagent `id` under toli root `root`. A tool call refreshes the report but
 * never revives one that ended (an async hook can land after the stop); a new start (a resumed subagent) does.
 */
export function reportHookEvent(root: string, id: string, event: HookAgentEvent, at: Date): void {
    const stamp = at.toISOString();
    if (event === "stop") {
        writeReport(root, id, { at: stamp, endedAt: stamp });
        return;
    }
    const file = agentReportFile(id);
    if (file === null) return;
    if (event === "tool" && readJson<AgentReport | null>(join(root, file), null)?.endedAt !== undefined) return;
    writeReport(root, id, { at: stamp });
}

/** An open delegation to another machine: one not dropped and not handed back. That machine runs the task. */
export function delegatedAway(task: Task): boolean {
    return liveDelegations(task).length > 0;
}

/**
 * The other fleet machine (or paired peer) a label agent names, as in `<machine> coordinates (talk 19:20)`: that
 * machine holds the work, so the task waits on it. Null for a harness agent id (one name, no spaces), a `bin/toli
 * remote` run (`remote:<machine>:...`, judged by its record) and a label naming no other machine.
 */
export function labelHolder(agent: string): string | null {
    if (isValidName(agent) || agent.startsWith("remote:")) return null;
    const words = new Set(agent.split(/[^A-Za-z0-9._-]+/));
    const self = hasMachine() ? loadMachine().name : "";
    const peers = readJson<{ peers?: Array<{ name: string; status: string }> }>(paths.peers(), {}).peers ?? [];
    const names = [
        ...loadFleet().machines.map((machine) => machine.name),
        ...peers.filter((peer) => peer.status === "active").map((peer) => peer.name),
    ];
    return names.find((name) => name !== self && words.has(name)) ?? null;
}

/**
 * Whether the task's agent is a native harness subagent of this machine: neither a `bin/toli spawn` run (`j-...`,
 * judged by its run record) nor a `bin/toli remote` run (`remote:<machine>:...`: the target counts it as its own
 * run, and only its record here ends it), not delegated to another machine, and not a label naming one.
 */
export function nativeAgent(task: Task): task is Task & { agent: string } {
    return (
        task.agent !== undefined &&
        !task.agent.startsWith("j-") &&
        !task.agent.startsWith("remote:") &&
        !delegatedAway(task) &&
        labelHolder(task.agent) === null
    );
}

/**
 * Whether the task's native harness subagent died with the lead session that recorded it: `agentSession` names the
 * current agent and its pid is no longer running.
 */
export function agentSessionGone(task: Pick<Task, "agent" | "agentSession">): boolean {
    const session = task.agentSession;
    return session !== undefined && session.agent === task.agent && !pidAlive(session.pid);
}

/**
 * A native subagent's state. `live`: it reported running within AGENT_REPORT_TIMEOUT_MS from a running omp, or within
 * `graceMinutes` on its own activity (a report naming no pid), or, with no report since it was recorded, it was
 * recorded less than `graceMinutes` ago, or the lead session that recorded it is alive and does not watch its
 * subagents (T1429). `session`: the lead session that recorded it is gone. `ended`: it reported its end after it was
 * recorded. `silent`: it stopped reporting at `since` (`evidence`: its report), or never reported and was recorded at
 * `since`, the grace minutes ago or more.
 */
export type AgentState =
    | { state: "live" }
    | { state: "session"; pid: number }
    | { state: "ended"; at: string; evidence: string }
    | { state: "silent"; since: string; evidence: string | null };

export function agentState(task: Task & { agent: string }, at: Date, graceMinutes: number): AgentState {
    const session = task.agentSession;
    if (session !== undefined && agentSessionGone(task)) return { state: "session", pid: session.pid };
    // A lead omp whose extension does not watch its subagents writes no report for them: they run while it does.
    if (session !== undefined && session.agent === task.agent && !sessionWatches(session.pid)) return { state: "live" };
    const recorded = task.dispatchedAt ?? task.startedAt ?? task.createdAt;
    const file = agentReportFile(task.agent);
    const report = file === null ? null : readJson<AgentReport | null>(join(paths.root(), file), null);
    if (file !== null && report !== null) {
        const fresh =
            report.pid === undefined
                ? at.getTime() - Date.parse(report.at) < graceMinutes * 60_000
                : pidAlive(report.pid) && at.getTime() - Date.parse(report.at) <= AGENT_REPORT_TIMEOUT_MS;
        if (report.endedAt === undefined && fresh) return { state: "live" };
        // A report from before the task was recorded is an earlier run of the same agent id: it says nothing here.
        if (report.endedAt !== undefined && Date.parse(report.endedAt) >= Date.parse(recorded))
            return { state: "ended", at: report.endedAt, evidence: file };
        if (report.endedAt === undefined && Date.parse(report.at) >= Date.parse(recorded))
            return { state: "silent", since: report.at, evidence: file };
    }
    if (at.getTime() - Date.parse(recorded) < graceMinutes * 60_000) return { state: "live" };
    return { state: "silent", since: recorded, evidence: null };
}
