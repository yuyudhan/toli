import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Args } from "./args.ts";
import { loadBacklog, type Task } from "./backlog.ts";
import { loadMachine, otherFleetMachines, sshArgs } from "./config.ts";
import { isGitRepo, type RepoStatus, repoStatus } from "./git.ts";
import { type InboxItem, listInbox } from "./inbox.ts";
import { type JobResult, listResults, loadJobState } from "./jobs.ts";
import { paths } from "./paths.ts";
import { fleetStatus } from "./pick.ts";
import { loadProjects, type Mode } from "./projects.ts";
import { type FleetEntry as AvailabilityEntry, availabilityLine } from "./resources.ts";
import { MateError, now, out, printJson, run, shellQuote } from "./util.ts";

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
    generatedAt: string;
    projects: ProjectDigest[];
    backlog: { inFlight: Task[]; waiting: Task[]; queued: Task[] };
    runningJobs: { name: string; runId: string; via: string; startedAt: string }[];
    jobResults: JobResult[];
    inbox: InboxItem[];
    reports: ReportEntry[];
};

export type FleetEntry = { machine: string; ok: boolean; digest?: Digest; error?: string };

const RECENT_REPORTS = 5;

function recentReports(): ReportEntry[] {
    const entries: ReportEntry[] = [];
    for (const dir of [paths.reportsDir(), paths.remoteDir()]) {
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
    return {
        machine: machine.name,
        role: machine.role,
        generatedAt: now().toISOString(),
        projects,
        backlog: {
            inFlight: tasks.filter((task) => task.status === "active"),
            waiting: tasks.filter((task) => task.status === "held"),
            queued: tasks.filter((task) => task.status === "queued"),
        },
        runningJobs,
        jobResults: listResults().filter((result) => result.unseen),
        inbox: listInbox().filter((item) => item.unseen),
        reports: recentReports(),
    };
}

function fleetDigests(): FleetEntry[] {
    return otherFleetMachines().map((machine): FleetEntry => {
        const result = run([...sshArgs(machine.ssh, 15), `cd ${shellQuote(machine.root)} && bin/mate digest --json`], {
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
        return `  ${project.name}: registered but not cloned here (bin/mate project ensure ${project.name} <url>)`;
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
    return `  ${task.id} ${task.project}: ${task.title}${question}`;
}

function render(digest: Digest): string {
    const lines = [`machine ${digest.machine} (${digest.role}) at ${digest.generatedAt}`, ""];
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
    return lines.join("\n");
}

export async function digestCommand(argv: string[]): Promise<void> {
    const args = new Args(argv, { booleans: ["json", "fleet"] });
    args.maxPositional(0);
    const digest = buildDigest();
    if (args.bool("fleet") && digest.role !== "coordinator")
        throw new MateError("--fleet runs on the coordinator only");
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
