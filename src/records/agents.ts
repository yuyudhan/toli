// Whether a native harness subagent recorded on a task (`task start T<n> --agent <id>`) is running. A live lead
// session is no evidence: one interactive omp lives for days while the subagents it started finish within the hour,
// so the session being alive says nothing about any one of them (T1419). The evidence is the agent's own report,
// state/agents/<id>.json, which the omp extension writes for every subagent session while it runs (AgentReporter):
// its omp pid, the last time it reported, and when it ended. An agent no harness reports (a Claude Code subagent, a
// label such as `<machine> lead (talk ...)`) counts as running only for the grace minutes after it was recorded.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
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
 * Whether the task's agent is a native harness subagent of this machine: neither a `bin/toli spawn` run (`j-...`,
 * judged by its run record) nor a `bin/toli remote` run (`remote:<machine>:...`: the target counts it as its own
 * run, and only its record here ends it), and not delegated to another machine.
 */
export function nativeAgent(task: Task): task is Task & { agent: string } {
    return (
        task.agent !== undefined &&
        !task.agent.startsWith("j-") &&
        !task.agent.startsWith("remote:") &&
        !delegatedAway(task)
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
 * no report since it was recorded, it was recorded less than `graceMinutes` ago. `session`: the lead session that
 * recorded it is gone. `ended`: it reported its end after it was recorded. `silent`: it stopped reporting at `since`
 * (`evidence`: its report), or never reported and was recorded at `since`, the grace minutes ago or more.
 */
export type AgentState =
    | { state: "live" }
    | { state: "session"; pid: number }
    | { state: "ended"; at: string; evidence: string }
    | { state: "silent"; since: string; evidence: string | null };

export function agentState(task: Task & { agent: string }, at: Date, graceMinutes: number): AgentState {
    const session = task.agentSession;
    if (session !== undefined && agentSessionGone(task)) return { state: "session", pid: session.pid };
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
