import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ackedThrough, ackThrough } from "./acks.ts";
import { Args } from "./args.ts";
import { loadMachine, type Machine, sshArgs } from "./config.ts";
import { cronFiredBetween, parseCron } from "./cron.ts";
import { paths } from "./paths.ts";
import { findProject } from "./projects.ts";
import {
    MateError,
    now,
    out,
    printJson,
    readJson,
    readStdin,
    requireName,
    run,
    shellQuote,
    stamp,
    withLock,
    writeJsonAtomic,
    writeTextAtomic,
} from "./util.ts";

export type JobShape = "scout" | "ship";
export type Via = "session" | "headless";
export type RunStatus = "ok" | "failed";

export type JobConfig = {
    name: string;
    cron: string;
    prompt: string;
    project?: string;
    machine?: string;
    shape: JobShape;
    enabled: boolean;
    createdAt: string;
};

export type RunningRun = { runId: string; via: Via; startedAt: string };

export type JobState = {
    lastRun?: string;
    running?: RunningRun;
    lastStatus?: RunStatus;
    lastFinished?: string;
    lastResult?: string;
};

type JobsFile = { jobs: JobConfig[] };
type JobStateFile = { jobs: Record<string, JobState> };

export type BegunRun = { runId: string; prompt: string };

export type JobResult = { job: string; file: string; path: string; stamp: string; status: string; unseen: boolean };

/** A run still marked running after this long is treated as dead and recorded as failed. */
export const STALE_RUN_MS = 3 * 60 * 60 * 1000;

const STAMP_LENGTH = stamp(new Date(0)).length;

export function loadJobs(): JobConfig[] {
    return readJson<JobsFile>(paths.jobsConfig(), { jobs: [] }).jobs;
}

function updateJobs<T>(fn: (jobs: JobConfig[]) => T): T {
    return withLock(paths.lock("jobs-config"), () => {
        const jobs = loadJobs();
        const result = fn(jobs);
        writeJsonAtomic(paths.jobsConfig(), { jobs });
        return result;
    });
}

export function loadJobState(): Record<string, JobState> {
    return readJson<JobStateFile>(paths.jobsState(), { jobs: {} }).jobs;
}

/** Read-modify-write of state/jobs.json under one lock, so concurrent ticks never double-claim a run. */
export function updateJobState<T>(fn: (state: Record<string, JobState>) => T): T {
    return withLock(paths.lock("jobs-state"), () => {
        const state = loadJobState();
        const result = fn(state);
        writeJsonAtomic(paths.jobsState(), { jobs: state });
        return result;
    });
}

export function findJob(name: string): JobConfig {
    const job = loadJobs().find((entry) => entry.name === name);
    if (!job) throw new MateError(`unknown job "${name}" (see \`bin/mate job list\`)`);
    return job;
}

/**
 * Jobs whose schedule matched a minute since their last run (or creation): enabled, meant for this
 * machine, and not already running. A window missed while asleep yields a single catch-up run.
 */
export function dueJobs(at: Date, machine: Machine): JobConfig[] {
    const state = loadJobState();
    return loadJobs().filter((job) => {
        if (!job.enabled) return false;
        if (job.machine && job.machine !== machine.name) return false;
        const jobState = state[job.name];
        if (jobState?.running) return false;
        const since = new Date(jobState?.lastRun ?? job.createdAt);
        return cronFiredBetween(parseCron(job.cron), since, at);
    });
}

function newRunId(at: Date): string {
    const compact = at
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z$/, "Z");
    return `${compact}-${crypto.randomUUID().slice(0, 6)}`;
}

export function buildPrompt(job: JobConfig, runId: string, via: Via, machine: Machine): string {
    const lines = [
        `[mate job ${job.name} ${runId}]`,
        `Scheduled mate job "${job.name}" on machine ${machine.name} (run ${runId}, via ${via}).`,
        "",
        "Rules for scheduled runs:",
        "- Never push, merge, or open a PR. Never ask questions: nobody is watching this run.",
        "- Put anything that needs the user's decision into the result instead of asking.",
        job.shape === "scout"
            ? "- This is a scout job: read and report only; do not edit files."
            : '- If the work needs a commit, use `bin/mate commit <project> -m "..." -- <paths>` on the current branch only.',
    ];
    if (job.project) lines.push("", `Project: ${job.project} at ${paths.projectDir(job.project)}`);
    lines.push(
        "",
        "Job:",
        job.prompt,
        "",
        `When done, pipe the final result (outcome, evidence, anything needing a decision) from ${paths.root()} into:`,
        `bin/mate job finish ${job.name} ${runId} <<'EOF'`,
        "<result>",
        "EOF",
    );
    return lines.join("\n");
}

/** Claim a run: marks it running with a fresh runId and consumes the current schedule window. */
export function beginJob(name: string, via: Via): BegunRun {
    const job = findJob(name);
    const machine = loadMachine();
    const at = now();
    const runId = updateJobState((state) => {
        const jobState = state[name] ?? {};
        state[name] = jobState;
        if (jobState.running) {
            throw new MateError(
                `job ${name} is already running (run ${jobState.running.runId} since ${jobState.running.startedAt})`,
            );
        }
        const id = newRunId(at);
        jobState.running = { runId: id, via, startedAt: at.toISOString() };
        jobState.lastRun = at.toISOString();
        return id;
    });
    return { runId, prompt: buildPrompt(job, runId, via, machine) };
}

/** Record a run's result in data/jobs/<name>/<stamp>.md, clear running, and forward it to the coordinator on a worker. */
export function finishJob(name: string, runId: string, body: string, status: RunStatus): string {
    const machine = loadMachine();
    const at = now();
    const { path, run: finished } = updateJobState((state) => {
        const jobState = state[name];
        const running = jobState?.running;
        if (!jobState || !running || running.runId !== runId) {
            throw new MateError(
                `job ${name} has no running run ${runId}${running ? ` (running: ${running.runId})` : ""}`,
            );
        }
        let resultPath = join(paths.jobResultsDir(name), `${stamp(at)}.md`);
        for (let bump = 1; existsSync(resultPath); bump++) {
            resultPath = join(paths.jobResultsDir(name), `${stamp(new Date(at.getTime() + bump))}.md`);
        }
        const header = [
            `# job ${name}`,
            "",
            `- job: ${name}`,
            `- runId: ${runId}`,
            `- machine: ${machine.name}`,
            `- via: ${running.via}`,
            `- started: ${running.startedAt}`,
            `- finished: ${at.toISOString()}`,
            `- status: ${status}`,
        ].join("\n");
        writeTextAtomic(resultPath, `${header}\n\n${body.trimEnd()}\n`);
        delete jobState.running;
        jobState.lastStatus = status;
        jobState.lastFinished = at.toISOString();
        jobState.lastResult = resultPath;
        return { path: resultPath, run: running };
    });
    if (machine.role === "worker" && machine.coordinator) {
        queueOutbox(machine, `job ${name}`, readFileSync(path, "utf8"), `${stamp(at)}-${name}-${finished.runId}`);
        deliverOutbox(machine);
    }
    return path;
}

type OutboxItem = { from: string; title: string; body: string };

function queueOutbox(machine: Machine, title: string, body: string, id: string): void {
    writeJsonAtomic(join(paths.outboxDir(), `${id}.json`), { from: machine.name, title, body } satisfies OutboxItem);
}

const SENDING_STALE_MS = 10 * 60 * 1000;

/**
 * Deliver every queued outbox item to the coordinator's inbox over ssh. Each item is claimed by an atomic
 * rename first, so overlapping ticks never send the same item twice; failures go back to the queue.
 */
export function deliverOutbox(machine: Machine): { delivered: number; pending: number; errors: string[] } {
    const dir = paths.outboxDir();
    const result = { delivered: 0, pending: 0, errors: [] as string[] };
    if (!existsSync(dir) || machine.role !== "worker" || !machine.coordinator) return result;
    const coordinator = machine.coordinator;
    for (const file of readdirSync(dir)) {
        const sending = /^(.*\.json)\.sending-\d+$/.exec(file);
        if (sending && Date.now() - statSync(join(dir, file)).mtimeMs > SENDING_STALE_MS) {
            renameSync(join(dir, file), join(dir, sending[1] as string));
        }
    }
    for (const file of readdirSync(dir)
        .filter((entry) => entry.endsWith(".json"))
        .sort()) {
        const queued = join(dir, file);
        const claimed = `${queued}.sending-${process.pid}`;
        try {
            renameSync(queued, claimed);
        } catch {
            continue;
        }
        const item = readJson<OutboxItem>(claimed, { from: machine.name, title: file, body: "" });
        const remote = [
            `cd ${shellQuote(coordinator.root)}`,
            `bin/mate inbox add --from ${shellQuote(item.from)} --title ${shellQuote(item.title)}`,
        ].join(" && ");
        const sent = run([...sshArgs(coordinator.ssh), remote], { stdin: item.body, timeoutMs: 120_000 });
        if (sent.code === 0) {
            rmSync(claimed, { force: true });
            result.delivered += 1;
        } else {
            renameSync(claimed, queued);
            result.pending += 1;
            result.errors.push(
                `${file}: ssh ${coordinator.ssh} exited ${sent.code}: ${(sent.stderr || sent.stdout).trim()}`,
            );
        }
    }
    return result;
}

export function listResults(): JobResult[] {
    const base = paths.jobResultsDir();
    if (!existsSync(base)) return [];
    const acked = ackedThrough("jobs");
    const results: JobResult[] = [];
    for (const job of readdirSync(base)) {
        const dir = join(base, job);
        if (!statSync(dir).isDirectory()) continue;
        for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
            const path = join(dir, file);
            const resultStamp = file.slice(0, STAMP_LENGTH);
            const status = /^- status: (\S+)$/m.exec(readFileSync(path, "utf8"))?.[1] ?? "unknown";
            results.push({ job, file, path, stamp: resultStamp, status, unseen: resultStamp > acked });
        }
    }
    return results.sort((a, b) => a.stamp.localeCompare(b.stamp) || a.job.localeCompare(b.job));
}

function add(argv: string[]): void {
    const args = new Args(argv, { values: ["cron", "prompt", "project", "machine", "shape"] });
    args.maxPositional(1);
    const name = requireName("job", args.positional[0]);
    const cron = args.str("cron");
    const prompt = args.str("prompt");
    if (!cron) throw new MateError('job add needs --cron "<m h dom mon dow>"');
    if (!prompt) throw new MateError('job add needs --prompt "<text>"');
    parseCron(cron);
    const shape = args.str("shape") ?? "scout";
    if (shape !== "scout" && shape !== "ship") throw new MateError("--shape must be scout or ship");
    const project = args.str("project");
    if (project !== undefined) findProject(project);
    const machineName = args.str("machine");
    if (machineName !== undefined) requireName("machine", machineName);
    updateJobs((jobs) => {
        if (jobs.some((entry) => entry.name === name)) throw new MateError(`job "${name}" already exists`);
        jobs.push({
            name,
            cron,
            prompt,
            ...(project === undefined ? {} : { project }),
            ...(machineName === undefined ? {} : { machine: machineName }),
            shape,
            enabled: true,
            createdAt: now().toISOString(),
        });
    });
    out(`added job ${name} (${cron})`);
}

function list(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const state = loadJobState();
    const jobs = loadJobs().map((job) => ({ ...job, state: state[job.name] ?? {} }));
    if (args.bool("json")) {
        printJson(jobs);
        return;
    }
    if (jobs.length === 0) {
        out("no jobs");
        return;
    }
    for (const job of jobs) {
        const parts = [
            job.name,
            job.enabled ? "active" : "paused",
            job.cron,
            job.shape,
            job.project ? `project=${job.project}` : "",
            job.machine ? `machine=${job.machine}` : "",
            job.state.running ? `running since ${job.state.running.startedAt}` : "",
            job.state.lastStatus ? `last=${job.state.lastStatus} ${job.state.lastFinished ?? ""}` : "",
        ];
        out(parts.filter((part) => part !== "").join("\t"));
    }
}

function setEnabled(argv: string[], enabled: boolean): void {
    const args = new Args(argv);
    args.maxPositional(1);
    const name = args.pos(0, "name");
    updateJobs((jobs) => {
        const job = jobs.find((entry) => entry.name === name);
        if (!job) throw new MateError(`unknown job "${name}"`);
        job.enabled = enabled;
    });
    out(`${enabled ? "resumed" : "paused"} job ${name}`);
}

function remove(argv: string[]): void {
    const args = new Args(argv);
    args.maxPositional(1);
    const name = args.pos(0, "name");
    updateJobs((jobs) => {
        const index = jobs.findIndex((entry) => entry.name === name);
        if (index === -1) throw new MateError(`unknown job "${name}"`);
        jobs.splice(index, 1);
    });
    updateJobState((state) => {
        delete state[name];
    });
    out(`removed job ${name} (past results kept in data/jobs/${name}/)`);
}

function due(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const jobs = dueJobs(now(), loadMachine());
    if (args.bool("json")) {
        printJson(jobs);
        return;
    }
    if (jobs.length === 0) {
        out("nothing due");
        return;
    }
    for (const job of jobs) out(`${job.name}\t${job.cron}`);
}

function parseVia(value: string | undefined): Via {
    if (value !== "session" && value !== "headless") throw new MateError("--via must be session or headless");
    return value;
}

function begin(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json"], values: ["via"] });
    args.maxPositional(1);
    const begun = beginJob(args.pos(0, "name"), parseVia(args.str("via")));
    if (args.bool("json")) printJson(begun);
    else out(begun.prompt);
}

function finish(argv: string[]): void {
    const args = new Args(argv, { values: ["status"] });
    args.maxPositional(2);
    const status = args.str("status") ?? "ok";
    if (status !== "ok" && status !== "failed") throw new MateError("--status must be ok or failed");
    const body = readStdin();
    if (body.trim() === "") throw new MateError("job finish needs the result on stdin");
    out(finishJob(args.pos(0, "name"), args.pos(1, "runId"), body, status));
}

function results(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json", "unseen"], values: ["job"] });
    args.maxPositional(0);
    const job = args.str("job");
    const items = listResults().filter(
        (item) => (!args.bool("unseen") || item.unseen) && (job === undefined || item.job === job),
    );
    if (args.bool("json")) {
        printJson(items);
        return;
    }
    if (items.length === 0) {
        out(args.bool("unseen") ? "no unseen job results" : "no job results");
        return;
    }
    for (const item of items)
        out(`${item.unseen ? "*" : " "} ${item.stamp}\t${item.job}\t${item.status}\t${item.path}`);
}

function ack(argv: string[]): void {
    new Args(argv).maxPositional(0);
    const items = listResults();
    // listResults is sorted by stamp, so the last item holds the newest one.
    const last = items.at(-1)?.stamp ?? "";
    const unseen = items.filter((item) => item.unseen).length;
    if (last !== "") ackThrough("jobs", last);
    out(`acknowledged ${unseen} job result${unseen === 1 ? "" : "s"}`);
}

export const jobSubcommands = { add, list, setEnabled, remove, due, begin, finish, results, ack };
