import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Args } from "./args.ts";
import { loadBacklog, type Task } from "./backlog.ts";
import { loadMachine, otherFleetMachines, remoteToliCommand, sshArgs } from "./config.ts";
import { isGitRepo, type RepoStatus, repoStatus } from "./git.ts";
import { configuredHarnesses, type Harness, harnessPath, SPECS } from "./harness.ts";
import { type InboxItem, listInbox } from "./inbox.ts";
import { type JobResult, listResults, loadJobState } from "./jobs.ts";
import { paths } from "./paths.ts";
import { personaLine } from "./persona.ts";
import { fleetStatus } from "./pick.ts";
import { projectsNeedingSetup } from "./project-setup.ts";
import { loadProjects, type Mode } from "./projects.ts";
import { type FleetEntry as AvailabilityEntry, availabilityLine } from "./resources.ts";
import { activeRuns, type JawanRun, runLine } from "./runs.ts";
import { now, out, printJson, run, ToliError } from "./util.ts";

export type ProjectDigest = {
    name: string;
    mode: Mode;
    path: string;
    cloned: boolean;
    status: RepoStatus | null;
    /** The configured fixed working branch, if any. */
    branch: string | null;
    /** The clone is not on `branch` (always false when no branch is configured). */
    branchMismatch: boolean;
    error?: string;
};

export type ReportEntry = { path: string; modified: string };

export type NextAction = { action: string; command: string };

export type Digest = {
    machine: string;
    role: string;
    /** Which names this installation uses (user, lead, workers). */
    persona?: string;
    generatedAt: string;
    projects: ProjectDigest[];
    backlog: { inFlight: Task[]; waiting: Task[]; queued: Task[] };
    runningJobs: { name: string; runId: string; via: string; startedAt: string }[];
    jobResults: JobResult[];
    inbox: InboxItem[];
    reports: ReportEntry[];
    /** Jawans started with `bin/toli spawn` that are still running. */
    jawanRuns?: JawanRun[];
    /** Recommended next actions for the lead, most urgent first. */
    next?: NextAction[];
};

export type FleetEntry = { machine: string; ok: boolean; digest?: Digest; error?: string };

const RECENT_REPORTS = 5;

/** Toli-wide and project-less dirs plus every `data/projects/<p>/reports` and `runs`. */
function reportDirs(): string[] {
    const base = paths.projectsDataDir();
    const projects = existsSync(base)
        ? readdirSync(base, { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .map((entry) => entry.name)
        : [];
    return [
        paths.reportsDir(),
        paths.remoteDir(),
        ...projects.flatMap((project) => [paths.projectReportsDir(project), paths.projectRunsDir(project)]),
    ];
}

function recentReports(): ReportEntry[] {
    const entries: ReportEntry[] = [];
    for (const dir of reportDirs()) {
        if (!existsSync(dir)) continue;
        for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
            const path = join(dir, file);
            entries.push({ path, modified: statSync(path).mtime.toISOString() });
        }
    }
    return entries.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, RECENT_REPORTS);
}

export function buildDigest(): Digest {
    const machine = loadMachine();
    const projects = loadProjects().map((project): ProjectDigest => {
        const dir = paths.projectDir(project.name);
        const branch = project.branch ?? null;
        const base = { name: project.name, mode: project.mode, path: dir, branch };
        if (!isGitRepo(dir)) return { ...base, cloned: false, status: null, branchMismatch: false };
        try {
            const status = repoStatus(dir);
            return { ...base, cloned: true, status, branchMismatch: branch !== null && status.branch !== branch };
        } catch (error) {
            return {
                ...base,
                cloned: true,
                status: null,
                branchMismatch: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    });
    const tasks = loadBacklog().tasks;
    const runningJobs = Object.entries(loadJobState()).flatMap(([name, state]) =>
        state.running ? [{ name, ...state.running }] : [],
    );
    const backlog = {
        inFlight: tasks.filter((task) => task.status === "active"),
        waiting: tasks.filter((task) => task.status === "held"),
        queued: tasks.filter((task) => task.status === "queued"),
    };
    const jobResults = listResults().filter((result) => result.unseen);
    const inbox = listInbox().filter((item) => item.unseen);
    const urls = new Map(loadProjects().map((project) => [project.name, project.url]));
    const missingHarnesses = configuredHarnesses().filter((harness) => harnessPath(harness) === null);
    const runs = activeRuns();
    const live = new Set(runs.map((entry) => entry.id));
    return {
        machine: machine.name,
        role: machine.role,
        persona: personaLine(),
        generatedAt: now().toISOString(),
        projects,
        backlog,
        runningJobs,
        jobResults,
        inbox,
        reports: recentReports(),
        jawanRuns: runs,
        next: nextActions({
            projects,
            backlog,
            unseenResults: jobResults.length + inbox.length,
            urls,
            setup: projectsNeedingSetup(),
            missingHarnesses,
            unattended: backlog.inFlight.filter(
                (task) => task.agent === undefined || (task.agent.startsWith("j-") && !live.has(task.agent)),
            ),
        }),
    };
}

export type NextInput = {
    projects: ProjectDigest[];
    backlog: Digest["backlog"];
    unseenResults: number;
    urls: Map<string, string>;
    setup: { name: string; missing: string[] }[];
    missingHarnesses: Harness[];
    /** Active tasks with no recorded jawan, or whose `bin/toli spawn` run has ended. */
    unattended: Task[];
};

const NEXT_LIST_LIMIT = 5;

/** Concrete recommended actions for the lead, most urgent first, each naming the exact skill or command. */
export function nextActions(input: NextInput): NextAction[] {
    const actions: NextAction[] = [];
    for (const task of input.backlog.waiting.slice(0, NEXT_LIST_LIMIT))
        actions.push({
            action: `Ask the user about ${task.id} (${task.project})${task.question ? `: ${task.question}` : ""}`,
            command: `bin/toli task answer ${task.id} "<answer>" (several questions: /ahoy, the toli-ahoy skill)`,
        });
    if (input.unseenResults > 0)
        actions.push({
            action: `Relay ${input.unseenResults} new result${input.unseenResults === 1 ? "" : "s"} to the user in plain words`,
            command: "then bin/toli inbox ack / bin/toli job ack (follow-up work goes to a jawan)",
        });
    for (const project of input.projects.filter((entry) => entry.branchMismatch))
        actions.push({
            action: `Tell the user ${project.name} is off its working branch ${project.branch} (on ${project.status?.branch ?? "?"})`,
            command: "never switch it yourself; the user may switch back or change it with bin/toli project set",
        });
    for (const task of input.unattended.slice(0, NEXT_LIST_LIMIT))
        actions.push({
            action: `${task.id} (${task.project}) is active but no running jawan is recorded on it${task.agent ? ` (last: ${task.agent})` : ""}`,
            command: `dispatch one and record it (bin/toli task start ${task.id} --agent <id>, or bin/toli spawn --task ${task.id} --brief <file>), or hold/drop it`,
        });
    for (const task of input.backlog.queued.slice(0, NEXT_LIST_LIMIT))
        actions.push({
            action: `Dispatch ${task.id} (${task.project}, ${task.shape}): ${task.title}`,
            command: `load the toli-dispatch skill, then a background jawan recorded on the task (bin/toli task start ${task.id} --agent <id>, or bin/toli spawn --task ${task.id} --brief <file>)`,
        });
    for (const project of input.projects.filter((entry) => !entry.cloned))
        actions.push({
            action: `Clone ${project.name} on this machine`,
            command: `dispatch a jawan to run bin/toli project ensure ${project.name} ${input.urls.get(project.name) ?? "<git-url>"}`,
        });
    if (input.setup.length > 0)
        actions.push({
            action: `${input.setup.length} project${input.setup.length === 1 ? " needs" : "s need"} setup (${input.setup
                .slice(0, NEXT_LIST_LIMIT)
                .map((entry) => `${entry.name}: ${entry.missing.join(", ")}`)
                .join("; ")})`,
            command: `/setup-project ${input.setup[0]?.name ?? "<name>"} (the toli-projects skill; bin/toli project setup --all)`,
        });
    for (const harness of input.missingHarnesses)
        actions.push({
            action: `Install ${SPECS[harness].label}: config/machine.json routes jawans to it`,
            command: `${SPECS[harness].install}; then ${SPECS[harness].login} (docs/harnesses.md), or change harness in config/machine.json`,
        });
    if (actions.length === 0)
        actions.push({ action: "Nothing pending", command: "greet the user and wait for a request" });
    return actions;
}

function fleetDigests(): FleetEntry[] {
    return otherFleetMachines().map((machine): FleetEntry => {
        const result = run([...sshArgs(machine.ssh, 15), remoteToliCommand(machine.root, "digest --json")], {
            timeoutMs: 90_000,
        });
        if (result.code !== 0) {
            return {
                machine: machine.name,
                ok: false,
                error: `ssh ${machine.ssh} exited ${result.code}: ${(result.stderr || result.stdout).trim()}`,
            };
        }
        try {
            return { machine: machine.name, ok: true, digest: JSON.parse(result.stdout) as Digest };
        } catch {
            return { machine: machine.name, ok: false, error: `unparseable digest from ${machine.ssh}` };
        }
    });
}

function projectLine(project: ProjectDigest): string {
    if (!project.cloned)
        return `  ${project.name}: registered but not cloned here (bin/toli project ensure ${project.name} <url>)`;
    if (!project.status) return `  ${project.name}: ${project.error ?? "status unavailable"}`;
    const status = project.status;
    const sync =
        status.upstream === null
            ? "no upstream"
            : `ahead ${status.ahead}, behind ${status.behind} of ${status.upstream}`;
    const mismatch = project.branchMismatch ? `, BRANCH MISMATCH: working branch is ${project.branch}` : "";
    return `  ${project.name}: ${status.branch}, ${status.dirty ? "dirty" : "clean"}, ${sync} (${project.mode})${mismatch}`;
}

function taskLine(task: Task): string {
    const question = task.status === "held" && task.question ? ` (question: ${task.question})` : "";
    const agent = task.status === "active" && task.agent ? ` [jawan ${task.agent}]` : "";
    return `  ${task.id} ${task.project}: ${task.title}${question}${agent}`;
}

function render(digest: Digest): string {
    const lines = [`machine ${digest.machine} (${digest.role}) at ${digest.generatedAt}`];
    if (digest.persona) lines.push(digest.persona);
    lines.push("");
    lines.push(`projects (${digest.projects.length}):`);
    lines.push(...(digest.projects.length === 0 ? ["  none"] : digest.projects.map(projectLine)));
    const sections: [string, Task[]][] = [
        ["in flight", digest.backlog.inFlight],
        ["waiting on answer", digest.backlog.waiting],
        ["queued", digest.backlog.queued],
    ];
    for (const [label, tasks] of sections) {
        lines.push("", `${label} (${tasks.length}):`, ...(tasks.length === 0 ? ["  none"] : tasks.map(taskLine)));
    }
    lines.push("", `running jobs (${digest.runningJobs.length}):`);
    lines.push(
        ...(digest.runningJobs.length === 0
            ? ["  none"]
            : digest.runningJobs.map((job) => `  ${job.name} ${job.runId} via ${job.via} since ${job.startedAt}`)),
    );
    lines.push("", `unseen job results (${digest.jobResults.length}):`);
    lines.push(
        ...(digest.jobResults.length === 0
            ? ["  none"]
            : digest.jobResults.map((result) => `  ${result.job} ${result.status} ${result.path}`)),
    );
    lines.push("", `unseen inbox (${digest.inbox.length}):`);
    lines.push(
        ...(digest.inbox.length === 0
            ? ["  none"]
            : digest.inbox.map((item) => `  ${item.from}: ${item.title} ${item.path}`)),
    );
    lines.push("", `recent reports (${digest.reports.length}):`);
    lines.push(
        ...(digest.reports.length === 0
            ? ["  none"]
            : digest.reports.map((report) => `  ${report.modified} ${report.path}`)),
    );
    // Fleet digests from machines on an older toli lack the fields below.
    const runs = digest.jawanRuns ?? [];
    lines.push(
        "",
        `jawan runs (${runs.length}):`,
        ...(runs.length === 0 ? ["  none"] : runs.map((entry) => `  ${runLine(entry)}`)),
    );
    const next = digest.next ?? [];
    lines.push("", `Next (${next.length}):`, ...next.map((action) => `  - ${action.action}: ${action.command}`));
    return lines.join("\n");
}

export async function digestCommand(argv: string[]): Promise<void> {
    const args = new Args(argv, { booleans: ["json", "fleet"] });
    args.maxPositional(0);
    const digest = buildDigest();
    if (args.bool("fleet") && digest.role !== "coordinator")
        throw new ToliError("--fleet runs on the coordinator only");
    if (!args.bool("fleet")) {
        if (args.bool("json")) printJson(digest);
        else out(render(digest));
        return;
    }
    const availability: AvailabilityEntry[] = await fleetStatus();
    const fleet = fleetDigests();
    if (args.bool("json")) {
        printJson({ ...digest, availability, fleet });
        return;
    }
    out(render(digest));
    out("");
    out(`fleet availability (${availability.length}):`);
    for (const entry of availability) out(`  ${availabilityLine(entry)}`);
    for (const entry of fleet) {
        out("");
        out(`===== ${entry.machine} =====`);
        out(entry.ok && entry.digest ? render(entry.digest) : `unreachable: ${entry.error ?? "unknown error"}`);
    }
}
