import { appendFileSync, mkdirSync } from "node:fs";
import { Args } from "./args.ts";
import { loadMachine } from "./config.ts";
import {
    type BegunRun,
    beginJob,
    deliverOutbox,
    dueJobs,
    findJob,
    finishJob,
    jobSubcommands,
    loadJobState,
    STALE_RUN_MS,
} from "./jobs.ts";
import { paths } from "./paths.ts";
import { weeklyPruneReport } from "./prune.ts";
import { registerRun, removeRun } from "./resources.ts";
import { liveSession } from "./session.ts";
import { now, out, runCombined, ToliError } from "./util.ts";

/** Hard ceiling for omp's own --max-time, so a wedged process is still reaped. */
const HEADLESS_MAX_TIME = "45m";
const HEADLESS_KILL_MS = 50 * 60 * 1000;

function log(line: string): void {
    mkdirSync(paths.logsDir(), { recursive: true });
    appendFileSync(paths.tickLog(), `${now().toISOString()} ${line}\n`);
}

/** The argv for one headless omp run of `prompt` in this repo. */
export function headlessOmpArgs(prompt: string, maxTime: string = HEADLESS_MAX_TIME): string[] {
    return ["omp", "-p", "--cwd", paths.root(), "--no-title", "--approval-mode", "yolo", "--max-time", maxTime, prompt];
}

/**
 * Run a claimed job in headless omp, counted as load (a run record) while it runs; if the agent never called
 * `job finish`, record its captured output.
 */
async function runHeadless(name: string, begun: BegunRun): Promise<string> {
    registerRun({
        runId: begun.runId,
        pid: process.pid,
        from: loadMachine().name,
        task: null,
        startedAt: now().toISOString(),
        title: `job ${name}`,
    });
    let result: { code: number; output: string };
    try {
        result = await runCombined(headlessOmpArgs(begun.prompt), {
            cwd: paths.root(),
            timeoutMs: HEADLESS_KILL_MS,
        });
    } finally {
        removeRun(begun.runId);
    }
    const stillRunning = loadJobState()[name]?.running?.runId === begun.runId;
    if (!stillRunning) return `job ${name} ${begun.runId}: finished by the agent (omp exit ${result.code})`;
    const body = [
        `omp exited ${result.code} without calling \`bin/toli job finish\`; captured output follows.`,
        "",
        "```text",
        result.output.trimEnd(),
        "```",
    ].join("\n");
    const path = finishJob(name, begun.runId, body, result.code === 0 ? "ok" : "failed");
    return `job ${name} ${begun.runId}: omp exit ${result.code}, result ${path}`;
}

/** Record runs stuck in "running" past the stale limit as failed so their schedule resumes. */
function failStaleRuns(): string[] {
    const cutoff = now().getTime() - STALE_RUN_MS;
    const stale = Object.entries(loadJobState()).filter(
        ([, state]) => state.running && new Date(state.running.startedAt).getTime() < cutoff,
    );
    const notes: string[] = [];
    for (const [name, state] of stale) {
        const running = state.running;
        if (!running) continue;
        try {
            const body = `Run ${running.runId} (via ${running.via}) started ${running.startedAt} and never reported a result within 3h; marked failed by the ticker.`;
            notes.push(
                `job ${name} ${running.runId}: stale, marked failed (${finishJob(name, running.runId, body, "failed")})`,
            );
        } catch (error) {
            notes.push(
                `job ${name}: could not mark stale run failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
    return notes;
}

/**
 * Claim and run every job due on this machine, each in its own headless omp, and wait for all of them.
 * Claiming goes through beginJob's lock, so a job another runner already claimed is skipped, never run twice.
 */
async function runDueJobs(origin: string): Promise<void> {
    const runs = dueJobs(now(), loadMachine()).map(async (job) => {
        let begun: BegunRun;
        try {
            begun = beginJob(job.name, "headless");
        } catch (error) {
            // Another runner claimed it between our due check and begin.
            log(`job ${job.name}: not started: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        log(`job ${job.name} ${begun.runId}: started headless (${origin})`);
        try {
            log(await runHeadless(job.name, begun));
        } catch (error) {
            log(`job ${job.name} ${begun.runId}: run error: ${error instanceof Error ? error.message : String(error)}`);
        }
    });
    await Promise.all(runs);
}

export async function tick(): Promise<void> {
    const machine = loadMachine();
    try {
        const report = weeklyPruneReport(machine);
        if (report) log(report);
    } catch (error) {
        log(`prune report failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const outbox = deliverOutbox(machine);
    if (outbox.delivered > 0) log(`outbox: delivered ${outbox.delivered}`);
    for (const error of outbox.errors) log(`outbox: pending ${error}`);
    for (const note of failStaleRuns()) log(note);
    const session = liveSession();
    if (session) {
        log(`live session pid ${session.pid}: due jobs left to it`);
        return;
    }
    await runDueJobs("ticker");
}

/** `toli job run <name>`: run a job once, now, headless, regardless of its schedule. */
async function runNow(argv: string[]): Promise<void> {
    const args = new Args(argv);
    args.maxPositional(1);
    const name = args.pos(0, "name");
    findJob(name);
    const begun = beginJob(name, "headless");
    out(`job ${name} ${begun.runId}: running headless omp (up to ${HEADLESS_MAX_TIME})`);
    const summary = await runHeadless(name, begun);
    log(summary);
    out(summary);
    const result = loadJobState()[name]?.lastResult;
    if (result) out(result);
}

export async function jobCommand(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;
    switch (sub) {
        case "add":
            return jobSubcommands.add(rest);
        case "list":
            return jobSubcommands.list(rest);
        case "pause":
            return jobSubcommands.setEnabled(rest, false);
        case "resume":
            return jobSubcommands.setEnabled(rest, true);
        case "remove":
            return jobSubcommands.remove(rest);
        case "due":
            return jobSubcommands.due(rest);
        case "begin":
            return jobSubcommands.begin(rest);
        case "finish":
            return jobSubcommands.finish(rest);
        case "results":
            return jobSubcommands.results(rest);
        case "ack":
            return jobSubcommands.ack(rest);
        case "run":
            return runNow(rest);
        case "run-due":
            // The live session's extension starts this in the background; the OS ticker defers to it.
            new Args(rest).maxPositional(0);
            return runDueJobs("session");
        case "tick":
            new Args(rest).maxPositional(0);
            return tick();
        default:
            throw new ToliError(
                "usage: toli job add|list|pause|resume|remove|due|begin|finish|run|run-due|tick|results|ack",
            );
    }
}
