import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { Args } from "../core/args.ts";
import { loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, out, pidAlive, readJson, runCombined, ToliError, warn } from "../core/util.ts";
import { keepDiskBeforeWork } from "../fleet/disk.ts";
import { type RunRecord, registerRun, removeRun, stallMinutes } from "../fleet/resources.ts";
import { harnessConfig } from "../harness/harness.ts";
import { choiceText, hitLimit, limitPlan, limitReset, type ModelChoice, resolveModel } from "../harness/models.ts";
import { headlessOmpArgs } from "../harness/omp-args.ts";
import { liveSession } from "../harness/session.ts";
import { runHook } from "../helpers/local.ts";
import { stallText, watchStall } from "../jawans/progress.ts";
import { runMinuteMs } from "../jawans/runs.ts";
import { HARNESS_STOP_GRACE_MS, stopTree } from "../jawans/stop.ts";
import { drainQueue } from "../jawans/supervise.ts";
import { weeklyPruneReport } from "../records/prune.ts";
import { startDueUpdateCheck } from "../release/update-check.ts";
import {
    type BegunRun,
    beginJob,
    dueJobs,
    findJob,
    finishJob,
    type JobConfig,
    jobSubcommands,
    loadJobState,
    STALE_RUN_MS,
} from "./jobs.ts";
import { deliverOutbox } from "./outbox.ts";

function log(line: string): void {
    mkdirSync(paths.logsDir(), { recursive: true });
    appendFileSync(paths.tickLog(), `${now().toISOString()} ${line}\n`);
}

/** The model a job runs on: its own tier, else its shape's work type, on this machine's omp tiers. */
export function jobModel(job: Pick<JobConfig, "tier" | "shape">): ModelChoice {
    return resolveModel("omp", { tier: job.tier ?? null, work: job.shape }, harnessConfig());
}

/**
 * Run a claimed job in headless omp on its tier's model, counted as load (a run record) while it runs. It has no
 * wall-clock limit: omp is stopped only when it shows no progress for capacity.stallMinutes (src/jawans/progress.ts).
 * A run stopped by a rate or usage limit retries once on a lower allowed tier (never waiting: the tick runs every
 * minute). If the agent never called `job finish`, record its captured output.
 */
async function runHeadless(job: JobConfig, begun: BegunRun): Promise<string> {
    const name = job.name;
    registerRun({
        runId: begun.runId,
        pid: process.pid,
        from: loadMachine().name,
        task: null,
        startedAt: now().toISOString(),
        title: `job ${name}`,
    });
    const choice = jobModel(job);
    let model = choice.model;
    let fallback = "";
    let result: { code: number; output: string };
    const stall = stallMinutes(loadMachine());
    const sessionDir = paths.jobSessionDir(begun.runId);
    let stalled = false;
    try {
        const attempt = async (chosen: string | null): Promise<{ code: number; output: string }> => {
            let pid: number | null = null;
            const stopping: Promise<number[]>[] = [];
            const stopWatch = watchStall(
                () => ({ pid, logPath: null, sessionDir, cwd: paths.root() }),
                stall,
                runMinuteMs(),
                () => {
                    stalled = true;
                    if (pid !== null) stopping.push(stopTree(pid, HARNESS_STOP_GRACE_MS));
                },
            );
            try {
                return await runCombined(
                    headlessOmpArgs(begun.prompt, paths.root(), null, chosen, { dir: sessionDir }),
                    {
                        cwd: paths.root(),
                        onStart: (started) => {
                            pid = started;
                        },
                    },
                );
            } finally {
                stopWatch();
                // omp's children that ignore SIGTERM end with it: the attempt is over once none is left.
                const survivors = (await Promise.all(stopping)).flat();
                if (survivors.length > 0) warn(`job ${name}: pid ${survivors.join(", ")} outlived SIGKILL`);
            }
        };
        result = await attempt(model);
        if (hitLimit(result.output, result.code)) {
            const at = now();
            const plan = limitPlan(
                { harness: "omp", model, tier: choice.tier, work: job.shape },
                limitReset(result.output, at),
                at,
                harnessConfig(),
            );
            if (plan.kind === "switch") {
                fallback = `; limit fallback ${model ?? "default"} -> ${plan.model} (${plan.reason})`;
                model = plan.model;
                result = await attempt(model);
            } else fallback = `; hit a rate/usage limit, no retry (${plan.reason})`;
        }
    } finally {
        removeRun(begun.runId);
        rmSync(sessionDir, { recursive: true, force: true });
    }
    if (stalled) fallback += `; stopped: ${stallText(stall)}`;
    const ran = `omp ${choiceText({ ...choice, model })}${fallback}`;
    const stillRunning = loadJobState()[name]?.running?.runId === begun.runId;
    if (!stillRunning) return `job ${name} ${begun.runId}: finished by the agent (${ran}, exit ${result.code})`;
    const body = [
        `omp exited ${result.code} without calling \`bin/toli job finish\`; captured output follows.`,
        `Model: ${ran}.`,
        "",
        "```text",
        result.output.trimEnd(),
        "```",
    ].join("\n");
    const path = finishJob(name, begun.runId, body, result.code === 0 ? "ok" : "failed");
    return `job ${name} ${begun.runId}: ${ran}, exit ${result.code}, result ${path}`;
}

/**
 * Record runs stuck in "running" past the stale limit as failed so their schedule resumes. A headless run whose omp
 * is still alive (its load record names a live pid) is not stale: it has no time limit and stops only when it stalls.
 */
function failStaleRuns(): string[] {
    const cutoff = now().getTime() - STALE_RUN_MS;
    const stale = Object.entries(loadJobState()).filter(([, state]) => {
        if (!state.running || new Date(state.running.startedAt).getTime() >= cutoff) return false;
        const load = readJson<RunRecord | null>(paths.runRecord(state.running.runId), null);
        return load === null || !pidAlive(load.pid);
    });
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
            log(await runHeadless(job, begun));
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
    try {
        // Detached: the tick never waits on the network.
        const started = startDueUpdateCheck();
        if (started) log(started);
    } catch (error) {
        log(`update check failed to start: ${error instanceof Error ? error.message : String(error)}`);
    }
    const outbox = deliverOutbox(machine);
    if (outbox.delivered > 0) log(`outbox: delivered ${outbox.delivered}`);
    for (const error of outbox.errors) log(`outbox: pending ${error}`);
    for (const note of failStaleRuns()) log(note);
    // Low disk never stops work: under the floor the tick starts the disk keeper detached (src/fleet/disk.ts) and goes
    // on, so a keeper slowed by a starved disk never holds up a tick. The queue drain below leaves the disk to it.
    const disk = keepDiskBeforeWork("detached");
    if (disk) log(disk);
    // Queued jawan runs start as slots free; the finishing run's supervisor does this too, this catches the rest.
    try {
        for (const note of drainQueue({ diskKept: true })) log(note);
    } catch (error) {
        log(`queued jawan runs not started: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    const job = findJob(name);
    const begun = beginJob(name, "headless");
    out(
        `job ${name} ${begun.runId}: running headless omp ${choiceText(jobModel(job))} (no time limit; stopped if it stalls)`,
    );
    const summary = await runHeadless(job, begun);
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
            runHook("pre-tick");
            try {
                return await tick();
            } finally {
                runHook("post-tick");
            }
        default:
            throw new ToliError(
                "usage: toli job add|list|pause|resume|remove|due|begin|finish|run|run-due|tick|results|ack",
            );
    }
}
