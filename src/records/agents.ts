// Whether a native harness subagent recorded on a task (`task start T<n> --agent <id>`) is running. A live lead
// session is no evidence: one interactive omp lives for days while the subagents it started finish within the hour,
// so the session being alive says nothing about any one of them (T1419). The evidence is the agent's own report,
// state/agents/<id>.json, which the omp extension writes for every subagent session while it runs (AgentReporter):
// its omp pid, the last time it reported, and when it ended. An agent no harness reports (a Claude Code subagent, a
// label such as `fleet talk`) counts as running only for the grace minutes after it was recorded. A label naming
// another fleet machine (`<machine> coordinates (talk ...)`) is no agent here: that machine holds the work (T1427).
// A lead omp started before this evidence existed (its extension predates agent reports, so no
// state/agent-sessions/<pid>.json) keeps the earlier rule until it restarts: its subagents run while it does (T1429).
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hasMachine, loadFleet, loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { isValidName, pidAlive, readJson, writeJsonAtomic } from "../core/util.ts";
import type { Task } from "./backlog.ts";

/** How often a running subagent reports (the extension's beat). */
export const AGENT_REPORT_EVERY_MS = 60_000;
/** A report older than this, from a subagent that has not ended, means it stopped: its omp hung or was killed. */
export const AGENT_REPORT_TIMEOUT_MS = 3 * AGENT_REPORT_EVERY_MS;

/** state/agents/<id>.json: the omp pid running subagent `<id>`, its last report and, once it finished, its end. */
export type AgentReport = { pid: number; at: string; endedAt?: string };

/** The agent the extension's session runs, as omp passes it (`ctx.agent`); undefined in an older omp. */
export type SessionAgent = { kind: string; id: string } | undefined;

const AGENTS_DIR = join("state", "agents");
/** state/agent-sessions/<pid>.json: omp `pid` loaded an extension whose subagents report (markReportingSession). */
const SESSIONS_DIR = join("state", "agent-sessions");

/** A reporting omp's mark: its pid and when its extension loaded. */
export type ReportingSession = { pid: number; startedAt: string };

/**
 * Mark omp `pid` as one whose subagents report (the extension calls this when it loads), and remove the marks of omp
 * processes that are gone, so a reused pid never inherits one.
 */
export function markReportingSession(root: string, pid: number, at: Date): void {
    const dir = join(root, SESSIONS_DIR);
    mkdirSync(dir, { recursive: true });
    for (const file of readdirSync(dir)) {
        const marked = Number(file.replace(/\.json$/, ""));
        if (marked !== pid && !(Number.isInteger(marked) && marked > 0 && pidAlive(marked)))
            rmSync(join(dir, file), { force: true });
    }
    writeJsonAtomic(join(dir, `${pid}.json`), { pid, startedAt: at.toISOString() } satisfies ReportingSession);
}

/** Whether lead session `pid` runs an extension whose subagents report (false: it predates agent reports). */
function sessionReports(pid: number): boolean {
    return existsSync(join(paths.root(), SESSIONS_DIR, `${pid}.json`));
}

/** The agent's report, relative to the toli root; null for an id that cannot name a file. */
export function agentReportFile(id: string): string | null {
    return isValidName(id) ? join(AGENTS_DIR, `${id}.json`) : null;
}

/**
 * The extension's reporter for one omp session: a subagent session (`kind` "sub") reports while it runs, from its
 * agent loop's start (`started`), every beat (`beat`), until its loop ends (`ended`); a resumed subagent starts again.
 * The main session and an agent whose id names no file report nothing.
 */
export class AgentReporter {
    readonly #root: string;
    readonly #pid: number;
    #file: string | null = null;
    #running = false;

    constructor(root: string, pid: number) {
        this.#root = root;
        this.#pid = pid;
    }

    #write(report: AgentReport): void {
        if (this.#file === null) return;
        mkdirSync(join(this.#root, AGENTS_DIR), { recursive: true });
        writeJsonAtomic(join(this.#root, this.#file), report);
    }

    started(agent: SessionAgent, at: Date): void {
        const file = agent?.kind === "sub" ? agentReportFile(agent.id) : null;
        if (file === null) return;
        this.#file = file;
        this.#running = true;
        this.#write({ pid: this.#pid, at: at.toISOString() });
    }

    beat(at: Date): void {
        if (this.#running) this.#write({ pid: this.#pid, at: at.toISOString() });
    }

    ended(at: Date): void {
        if (!this.#running) return;
        this.#running = false;
        this.#write({ pid: this.#pid, at: at.toISOString(), endedAt: at.toISOString() });
    }
}

/** An open delegation to another machine: one not dropped and not handed back. That machine runs the task. */
export function delegatedAway(task: Task): boolean {
    return (task.delegatedTo ?? []).some((id) => {
        const state = task.delegates?.[id];
        return state === undefined || (state.status !== "dropped" && state.handedBack === undefined);
    });
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
 * A native subagent's state. `live`: it reported running within AGENT_REPORT_TIMEOUT_MS from a running omp, or, with
 * no report since it was recorded, it was recorded less than `graceMinutes` ago, or the lead session that recorded it
 * is alive and predates agent reports (T1429). `session`: the lead session that recorded it is gone. `ended`: it
 * reported its end after it was recorded. `silent`: it stopped reporting at `since` (`evidence`: its report), or never
 * reported and was recorded at `since`, the grace minutes ago or more.
 */
export type AgentState =
    | { state: "live" }
    | { state: "session"; pid: number }
    | { state: "ended"; at: string; evidence: string }
    | { state: "silent"; since: string; evidence: string | null };

export function agentState(task: Task & { agent: string }, at: Date, graceMinutes: number): AgentState {
    const session = task.agentSession;
    if (session !== undefined && agentSessionGone(task)) return { state: "session", pid: session.pid };
    // A lead omp whose extension predates agent reports writes none for its subagents: they run while it does.
    if (session !== undefined && session.agent === task.agent && !sessionReports(session.pid)) return { state: "live" };
    const recorded = task.dispatchedAt ?? task.startedAt ?? task.createdAt;
    const file = agentReportFile(task.agent);
    const report = file === null ? null : readJson<AgentReport | null>(join(paths.root(), file), null);
    if (file !== null && report !== null) {
        if (
            report.endedAt === undefined &&
            pidAlive(report.pid) &&
            at.getTime() - Date.parse(report.at) <= AGENT_REPORT_TIMEOUT_MS
        )
            return { state: "live" };
        // A report from before the task was recorded is an earlier run of the same agent id: it says nothing here.
        if (report.endedAt !== undefined && Date.parse(report.endedAt) >= Date.parse(recorded))
            return { state: "ended", at: report.endedAt, evidence: file };
        if (report.endedAt === undefined && Date.parse(report.at) >= Date.parse(recorded))
            return { state: "silent", since: report.at, evidence: file };
    }
    if (at.getTime() - Date.parse(recorded) < graceMinutes * 60_000) return { state: "live" };
    return { state: "silent", since: recorded, evidence: null };
}
