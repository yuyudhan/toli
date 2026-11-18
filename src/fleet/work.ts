// `bin/toli fleet work [--json]`: what every fleet machine is doing now. Per machine: its lead (the interactive
// session in tmux and what its status line says, the lead service), the jawans running with their task, each
// project's queued, held and active tasks, and each clone's branch: commits ahead of its upstream and when this
// clone last pushed it. Read with plain tools and the `bin/toli` commands every release has (src/fleet/machine-script.ts).
import { Args } from "../core/args.ts";
import { isJsonObject, now, out, printJson, waited } from "../core/util.ts";
import { HARNESSES } from "../harness/harness.ts";
import type { JawanRun } from "../jawans/runs.ts";
import { AGENT_REPORT_TIMEOUT_MS } from "../records/agents.ts";
import type { Task } from "../records/backlog.ts";
import { liveDelegations } from "../records/delegation-report.ts";
import { DEFAULT_STALE_TASK_MINUTES } from "../records/stale.ts";
import { runOnFleet, type ScriptOutcome, type Section, section } from "./machine-script.ts";

/** The script every machine runs from its toli root; `$TOLI` is its CLI. */
export const WORK_SCRIPT = `
echo "@@lead"; "$TOLI" lead status 2>&1
here=$(pwd -P)
tmux list-panes -a -F '#{pane_id}|#{session_name}:#{window_name}|#{pane_current_command}|#{pane_current_path}' 2>/dev/null |
while IFS='|' read -r id name cmd path; do
  [ "$path" = "$here" ] || [ "$path" = "$PWD" ] || continue
  echo "@@pane $name $cmd"
  tmux capture-pane -p -t "$id" 2>/dev/null | tail -n 40 | sed 's/^@@/ @@/'
done
echo "@@tasks"; "$TOLI" task list --json 2>/dev/null
echo "@@runs"; "$TOLI" runs --json --active 2>/dev/null
echo "@@agents"
awk 'FNR == 1 { if (NR > 1) print ""; n = FILENAME; sub(/.*\\//, "", n); sub(/\\.json$/, "", n); printf "%s\\t", n } { printf "%s", $0 } END { if (NR > 0) print "" }' state/agents/*.json 2>/dev/null
echo "@@git"
# One background job per clone (a busy machine has dozens); each prints its one line in a single write.
for d in projects/*/; do
  d=\${d%/}; [ -e "$d/.git" ] || continue
  (
    b=$(git -C "$d" symbolic-ref --quiet --short HEAD) || exit 0
    up="refs/remotes/origin/$b"
    git -C "$d" rev-parse --quiet --verify "$up" >/dev/null || up='@{u}'
    ahead=$(git -C "$d" rev-list --count "$up..HEAD" 2>/dev/null) || ahead=
    pushed=$(git -C "$d" log -g -n 200 --format='%ct %gs' "refs/remotes/origin/$b" 2>/dev/null | grep -m 1 'update by push' | cut -d' ' -f1)
    tip=$(git -C "$d" log -1 --format=%ct "$up" 2>/dev/null)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "\${d#projects/}" "$b" "$ahead" "$pushed" "$tip"
  ) &
done
wait
`;

/** The lead: its interactive session (pid from `lead status`, tmux pane and status line) and its service. */
export type Lead = {
    interactivePid: number | null;
    /** `<session>:<window> <command>` of each tmux pane running a harness in the toli root. */
    panes: string[];
    /** What the harness's status line says it is doing. */
    activity: string | null;
    service: string | null;
};

/** A jawan running now: a `bin/toli spawn` run, or a native subagent recorded on an active task. */
export type Jawan = {
    task: string | null;
    project: string | null;
    title: string;
    kind: "spawn" | "subagent";
    id: string;
    status: string;
    since: string | null;
};

/** One project on the machine: its open tasks, and its clone's branch when it has one. */
export type ProjectWork = {
    project: string;
    queued: number;
    held: number;
    active: number;
    branch: string | null;
    /** Commits not on origin's branch of the same name (else its upstream); null when neither exists. */
    ahead: number | null;
    /** When this clone last pushed the branch (its remote-tracking reflog), and the upstream tip's commit time. */
    pushedAt: string | null;
    upstreamAt: string | null;
};

export type MachineWork = {
    machine: string;
    local: boolean;
    reachable: boolean;
    reason?: string;
    lead?: Lead;
    jawans?: Jawan[];
    /** Why the task list could not be read, when it could not. */
    tasksError?: string;
    projects?: ProjectWork[];
};

const PRIVATE_USE = /[\uE000-\uF8FF]|[\u{F0000}-\u{FFFFD}]/gu;

/**
 * The harness's current activity from the bottom of its tmux pane: the last line above its status bar (a long rule
 * of `─`) that is not tree drawing, without icon glyphs and right-aligned extras.
 */
export function paneActivity(text: string): string | null {
    const lines = text.split("\n");
    let bar = -1;
    lines.forEach((line, index) => {
        if (/─{8,}/.test(line)) bar = index;
    });
    for (let index = bar - 1; index >= 0; index -= 1) {
        const line = (lines[index] ?? "").replace(PRIVATE_USE, "").trim();
        if (line === "" || /^[├└│╰╭─]/.test(line)) continue;
        return line.split(/\s{3,}/)[0] ?? null;
    }
    return null;
}

/** `lead status`: the interactive pid and the service line. */
function parseLeadStatus(text: string): Pick<Lead, "interactivePid" | "service"> {
    const pid = /^interactive: pid (\d+)/m.exec(text);
    const service = /^service: (.*)$/m.exec(text);
    return { interactivePid: pid === null ? null : Number(pid[1]), service: service?.[1]?.trim() ?? null };
}

function parseJsonArray(text: string | null): unknown[] | null {
    if (text === null || text.trim() === "") return null;
    try {
        const value: unknown = JSON.parse(text);
        return Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}

/** The tasks of a `task list --json`, keeping only entries with the fields read here. */
export function parseTasks(text: string | null): Task[] | null {
    const values = parseJsonArray(text);
    if (values === null) return null;
    return values.filter(
        (value): value is Task =>
            isJsonObject(value) &&
            typeof value.id === "string" &&
            typeof value.project === "string" &&
            typeof value.title === "string" &&
            typeof value.status === "string",
    );
}

type AgentReport = { pid?: number; at: string; endedAt?: string };

/** `state/agents/<id>.json` lines (`<id>\t<json>`) by agent id. */
function parseAgentReports(text: string): Map<string, AgentReport> {
    const reports = new Map<string, AgentReport>();
    for (const line of text.split("\n")) {
        const tab = line.indexOf("\t");
        if (tab <= 0) continue;
        try {
            const value: unknown = JSON.parse(line.slice(tab + 1));
            if (isJsonObject(value) && typeof value.at === "string")
                reports.set(line.slice(0, tab), value as AgentReport);
        } catch {
            // A report half-written at the moment it was read: that agent counts as unreported.
        }
    }
    return reports;
}

/**
 * Whether a native subagent recorded on `task` runs, by the rule of src/records/agents.ts read from afar (no pid
 * check): its report says running and is fresh (a beat within 3 minutes, a hook report within the grace minutes),
 * or it never reported and was recorded within the grace minutes.
 */
export function subagentRunning(task: Task, report: AgentReport | undefined, at: number): boolean {
    const recorded = Date.parse(task.dispatchedAt ?? task.startedAt ?? task.createdAt);
    const grace = DEFAULT_STALE_TASK_MINUTES * 60_000;
    if (report !== undefined && Date.parse(report.at) >= recorded) {
        if (report.endedAt !== undefined) return false;
        return at - Date.parse(report.at) <= (report.pid === undefined ? grace : AGENT_REPORT_TIMEOUT_MS);
    }
    return at - recorded < grace;
}

/** The jawans running now: spawn runs holding or waiting for a slot, then live native subagents. */
export function runningJawans(tasks: Task[], runs: unknown[], reports: Map<string, AgentReport>, at: number): Jawan[] {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const spawned = runs.filter(
        (run): run is JawanRun => isJsonObject(run) && typeof run.id === "string" && typeof run.status === "string",
    );
    const worked = new Set(spawned.flatMap((run) => (run.task === null ? [] : [run.task])));
    const spawns = spawned.map(
        (run): Jawan => ({
            task: run.task,
            project: run.project,
            title: (run.task === null ? undefined : byId.get(run.task)?.title) ?? "(no task)",
            kind: "spawn",
            id: run.id,
            status: run.status,
            since: run.startedAt,
        }),
    );
    const subagents = tasks.flatMap((task): Jawan[] => {
        const agent = task.agent;
        if (task.status !== "active" || agent === undefined || worked.has(task.id) || task.waitingOn !== undefined)
            return [];
        // Not a subagent: a spawn run id, a remote run, a label (`<machine> coordinates ...`) or work delegated away.
        if (agent.startsWith("j-") || agent.startsWith("remote:") || /\s/.test(agent)) return [];
        if (liveDelegations(task).length > 0 || !subagentRunning(task, reports.get(agent), at)) return [];
        return [
            {
                task: task.id,
                project: task.project,
                title: task.title,
                kind: "subagent",
                id: agent,
                status: "running",
                since: task.dispatchedAt ?? task.startedAt ?? null,
            },
        ];
    });
    return [...spawns, ...subagents];
}

/** Each project with open tasks or unpushed commits, by name. */
export function projectWork(tasks: Task[], gitText: string): ProjectWork[] {
    const projects = new Map<string, ProjectWork>();
    const entry = (project: string): ProjectWork => {
        const known = projects.get(project);
        if (known !== undefined) return known;
        const fresh: ProjectWork = {
            project,
            queued: 0,
            held: 0,
            active: 0,
            branch: null,
            ahead: null,
            pushedAt: null,
            upstreamAt: null,
        };
        projects.set(project, fresh);
        return fresh;
    };
    for (const task of tasks)
        if (task.status === "queued" || task.status === "held" || task.status === "active")
            entry(task.project)[task.status] += 1;
    const epoch = (text: string | undefined): string | null =>
        text === undefined || !/^\d+$/.test(text) ? null : new Date(Number(text) * 1000).toISOString();
    for (const line of gitText.split("\n")) {
        const [project, branch, ahead, pushed, tip] = line.split("\t");
        if (project === undefined || project === "" || branch === undefined) continue;
        const count = ahead === undefined || !/^\d+$/.test(ahead) ? null : Number(ahead);
        if (!projects.has(project) && (count ?? 0) === 0) continue;
        Object.assign(entry(project), { branch, ahead: count, pushedAt: epoch(pushed), upstreamAt: epoch(tip) });
    }
    return [...projects.values()].sort((a, b) => a.project.localeCompare(b.project));
}

/** One machine's work from the sections WORK_SCRIPT printed; `at` is now on this machine (clocks are synced). */
export function parseWork(machine: string, local: boolean, sections: Section[], at: number): MachineWork {
    const panes = sections.filter(
        (entry) =>
            entry.name === "pane" && (HARNESSES as readonly string[]).includes(entry.arg.split(" ").at(-1) ?? ""),
    );
    const lead: Lead = {
        ...parseLeadStatus(section(sections, "lead") ?? ""),
        panes: panes.map((entry) => entry.arg),
        activity: panes.map((entry) => paneActivity(entry.body)).find((text) => text !== null) ?? null,
    };
    const tasks = parseTasks(section(sections, "tasks"));
    const runs = parseJsonArray(section(sections, "runs")) ?? [];
    const reports = parseAgentReports(section(sections, "agents") ?? "");
    return {
        machine,
        local,
        reachable: true,
        lead,
        jawans: runningJawans(tasks ?? [], runs, reports, at),
        ...(tasks === null ? { tasksError: "task list --json gave no list" } : {}),
        projects: projectWork(tasks ?? [], section(sections, "git") ?? ""),
    };
}

function machineWork(outcome: ScriptOutcome, at: number): MachineWork {
    if (!outcome.ok)
        return { machine: outcome.machine, local: outcome.local, reachable: false, reason: outcome.reason };
    return parseWork(outcome.machine, outcome.local, outcome.sections, at);
}

/** Every fleet machine's work, this machine first. */
export async function fleetWork(): Promise<MachineWork[]> {
    const at = now().getTime();
    return (await runOnFleet(WORK_SCRIPT)).map((outcome) => machineWork(outcome, at));
}

function ago(iso: string | null, at: number): string | null {
    return iso === null ? null : `${waited(at - Date.parse(iso))} ago`;
}

function leadLine(lead: Lead): string {
    const session =
        lead.panes.length > 0
            ? `${lead.panes.join(", ")} in tmux`
            : lead.interactivePid === null
              ? "no interactive session"
              : `interactive pid ${lead.interactivePid}`;
    return `lead: ${session}; service ${lead.service ?? "unknown"}${lead.activity === null ? "" : `\n    now: ${lead.activity}`}`;
}

function projectLine(project: ProjectWork, at: number): string {
    const tasks = `${project.queued} queued, ${project.held} held, ${project.active} active`;
    if (project.branch === null) return `${project.project}: ${tasks}`;
    const pushed = ago(project.pushedAt, at);
    const tip = ago(project.upstreamAt, at);
    const git = [
        project.ahead === null ? "no upstream" : `${project.ahead} ahead`,
        ...(pushed === null ? [] : [`pushed from here ${pushed}`]),
        ...(tip === null ? [] : [`upstream tip ${tip}`]),
    ].join(", ");
    return `${project.project}: ${tasks}; ${project.branch}: ${git}`;
}

/** The report: one block per machine. */
export function workText(machines: MachineWork[], at: number = now().getTime()): string {
    const blocks = machines.map((machine) => {
        const name = `${machine.machine}${machine.local ? " (this machine)" : ""}`;
        if (!machine.reachable) return `${name}: unreachable: ${machine.reason ?? "no answer"}`;
        const jawans = machine.jawans ?? [];
        const lines = [
            `${name}`,
            `  ${leadLine(machine.lead ?? { interactivePid: null, panes: [], activity: null, service: null })}`,
        ];
        lines.push(`  jawans running: ${jawans.length === 0 ? "none" : jawans.length}`);
        for (const jawan of jawans) {
            const since = ago(jawan.since, at);
            const label = jawan.task === null ? jawan.id : `${jawan.task} (${jawan.project ?? "?"})`;
            lines.push(
                `    ${label}: ${jawan.title} [${jawan.kind} ${jawan.id}${jawan.status === "running" ? "" : `, ${jawan.status}`}${since === null ? "" : `, ${since}`}]`,
            );
        }
        if (machine.tasksError !== undefined) lines.push(`  tasks: unreadable (${machine.tasksError})`);
        const projects = machine.projects ?? [];
        lines.push(`  projects: ${projects.length === 0 ? "no open tasks, nothing unpushed" : ""}`.trimEnd());
        for (const project of projects) lines.push(`    ${projectLine(project, at)}`);
        return lines.join("\n");
    });
    return blocks.join("\n\n");
}

/** `toli fleet work [--json]`. */
export async function workCommand(argv: string[]): Promise<void> {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const machines = await fleetWork();
    if (args.bool("json")) printJson(machines);
    else out(workText(machines));
}
