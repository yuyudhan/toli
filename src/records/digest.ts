import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Args } from "../core/args.ts";
import { hasMachine, loadMachine, otherFleetMachines, remoteToliCommand, sshArgs } from "../core/config.ts";
import { isGitRepo, type RepoStatus, repoStatus } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { personaLine } from "../core/persona.ts";
import { now, out, printJson, run, ToliError } from "../core/util.ts";
import { fleetStatus } from "../fleet/pick.ts";
import { type FleetEntry as AvailabilityEntry, availabilityLine } from "../fleet/resources.ts";
import { configuredHarnesses, harnessPath } from "../harness/harness.ts";
import { activeRuns, type JawanRun, runLine } from "../jawans/runs.ts";
import { type JobResult, listResults, loadJobState } from "../jobs/jobs.ts";
import { brokenLink } from "../projects/link.ts";
import { loadProjects, type Mode } from "../projects/projects.ts";
import { projectsNeedingSetup } from "../projects/setup.ts";
import { takeUpdateNotice } from "../release/update-check.ts";
import { type SetupItem, setupChecklist } from "../setup/checklist.ts";
import { setupSnoozed, takeSetupNotice } from "../setup/setup.ts";
import { loadBacklog, type Task } from "./backlog.ts";
import { type InboxItem, listInbox } from "./inbox.ts";
import { type Needs, needsQueue, renderNeeds, takeStaleHolds } from "./needs.ts";
import { type NextAction, nextActions } from "./next.ts";

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

export type Digest = {
    machine: string;
    role: string;
    /** Which names this installation uses (user, lead, workers). */
    persona?: string;
    generatedAt: string;
    projects: ProjectDigest[];
    backlog: { inFlight: Task[]; waiting: Task[]; queued: Task[] };
    /** The Needs-you queue: every held task, grouped by project, most urgent first (src/records/needs.ts). */
    needs?: Needs;
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

/** `setupItems`: this machine's install-level setup checklist; its missing steps head the Next block's setup action. */
export function buildDigest(setupItems: SetupItem[] = setupChecklist()): Digest {
    // A fresh clone has no config/machine.json yet; the digest still works and the setup notice says what to do.
    const machine = hasMachine() ? loadMachine() : { name: "(unnamed)", role: "not initialized" };
    const projects = loadProjects().map((project): ProjectDigest => {
        const dir = paths.projectDir(project.name);
        const branch = project.branch ?? null;
        const base = { name: project.name, mode: project.mode, path: dir, branch };
        const broken = brokenLink(project);
        if (broken !== null) return { ...base, cloned: false, status: null, branchMismatch: false, error: broken };
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
    const needs = needsQueue(tasks);
    return {
        machine: machine.name,
        role: machine.role,
        persona: personaLine(),
        generatedAt: now().toISOString(),
        projects,
        backlog,
        needs,
        runningJobs,
        jobResults,
        inbox,
        reports: recentReports(),
        jawanRuns: runs,
        next: nextActions({
            projects,
            backlog,
            needs,
            unseenResults: jobResults.length + inbox.length,
            urls,
            setup: projectsNeedingSetup(),
            setupSteps: setupItems.filter((item) => item.status === "missing").map((item) => item.title),
            setupSnoozed: setupSnoozed(setupItems),
            missingHarnesses,
            unattended: backlog.inFlight.filter(
                (task) => task.agent === undefined || (task.agent.startsWith("j-") && !live.has(task.agent)),
            ),
        }),
    };
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
        return project.error === undefined
            ? `  ${project.name}: registered but not cloned here (bin/toli project ensure ${project.name} <url>)`
            : `  ${project.name}: ${project.error}`;
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
    const agent = task.status === "active" && task.agent ? ` [jawan ${task.agent}]` : "";
    return `  ${task.id} ${task.project}: ${task.title}${agent}`;
}

/**
 * `notices`: the told-once setup and update notices for this machine's own digest; never set for fleet digests.
 * `resurface`: stale holds to raise once more (src/records/needs.ts takeStaleHolds).
 */
function render(digest: Digest, notices: readonly string[] = [], resurface: ReadonlySet<string> = new Set()): string {
    const lines = [`machine ${digest.machine} (${digest.role}) at ${digest.generatedAt}`];
    if (digest.persona) lines.push(digest.persona);
    lines.push(...notices);
    lines.push("");
    // Fleet digests from machines on an older toli lack `needs`; their held tasks still form the queue.
    lines.push(
        ...renderNeeds(digest.needs ?? needsQueue(digest.backlog.waiting, new Date(digest.generatedAt)), resurface),
    );
    lines.push("", `projects (${digest.projects.length}):`);
    lines.push(...(digest.projects.length === 0 ? ["  none"] : digest.projects.map(projectLine)));
    const sections: [string, Task[]][] = [
        ["in flight", digest.backlog.inFlight],
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
    const setupItems = setupChecklist();
    const digest = buildDigest(setupItems);
    if (args.bool("fleet") && digest.role !== "coordinator")
        throw new ToliError("--fleet runs on the coordinator only");
    if (!args.bool("fleet")) {
        if (args.bool("json")) printJson(digest);
        else out(ownRender(digest, setupItems));
        return;
    }
    const availability: AvailabilityEntry[] = await fleetStatus();
    const fleet = fleetDigests();
    if (args.bool("json")) {
        printJson({ ...digest, availability, fleet });
        return;
    }
    out(ownRender(digest, setupItems));
    out("");
    out(`fleet availability (${availability.length}):`);
    for (const entry of availability) out(`  ${availabilityLine(entry)}`);
    for (const entry of fleet) {
        out("");
        out(`===== ${entry.machine} =====`);
        out(entry.ok && entry.digest ? render(entry.digest) : `unreachable: ${entry.error ?? "unknown error"}`);
    }
}

/** The told-once update notice; a failure there becomes one line and never breaks the digest. */
function updateNotice(): string | null {
    try {
        return takeUpdateNotice();
    } catch (error) {
        return `Update check: notice failed (${error instanceof Error ? error.message : String(error)}); see bin/toli update status`;
    }
}

/** This machine's digest as text: consumes the told-once setup and update notices and stale-hold re-surfacing. */
function ownRender(digest: Digest, setupItems: SetupItem[]): string {
    const resurface = digest.needs === undefined ? new Set<string>() : takeStaleHolds(digest.needs);
    const notices = [takeSetupNotice(setupItems), updateNotice()].filter((notice): notice is string => notice !== null);
    return render(digest, notices, resurface);
}
