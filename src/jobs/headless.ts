// A scheduled job's headless run (`job tick`, `job run`): one omp on the job's tier's model, registered as load while it
// runs, stopped at the job's deadline (`maxMinutes` in config/jobs.json) or when it stalls, and its result recorded
// when the agent never called `job finish`. Details: docs/jobs.md.
import { rmSync } from "node:fs";
import { loadMachine } from "../core/config.ts";
import { adoptLoginEnv } from "../core/login-env.ts";
import { paths } from "../core/paths.ts";
import { now, runCombined, ToliError, warn } from "../core/util.ts";
import { registerRun, removeRun, stallMinutes } from "../fleet/resources.ts";
import { choiceText } from "../harness/models.ts";
import { headlessOmpArgs } from "../harness/omp-args.ts";
import { sessionFile } from "../jawans/launch.ts";
import { briefStallMinutes, stallText, watchStall } from "../jawans/progress.ts";
import { runMinuteMs } from "../jawans/runs.ts";
import { HARNESS_STOP_GRACE_MS, type StopRoot, stopTree } from "../jawans/stop.ts";
import { loadRetention } from "../records/prune.ts";
import { type BegunRun, finishJob, type JobConfig, loadJobState } from "./jobs.ts";
import { attemptWithinLimits, jobModel, type Outcome } from "./limit-pause.ts";

/** A headless run's deadline when its job in config/jobs.json sets no `maxMinutes`. */
export const DEFAULT_JOB_MAX_MINUTES = 30;

/** The job's headless deadline in minutes (null: none); a hand-edited value that is no whole minute count is refused. */
export function jobMaxMinutes(job: JobConfig): number | null {
    const value = job.maxMinutes;
    if (value === undefined) return DEFAULT_JOB_MAX_MINUTES;
    if (value === null || (Number.isInteger(value) && value >= 1)) return value;
    throw new ToliError(
        `job ${job.name}: maxMinutes in config/jobs.json must be a whole number of minutes (at least 1) or null, got ${JSON.stringify(value)}`,
    );
}

/**
 * Run a claimed job in headless omp on its tier's model, counted as load (a run record) while it runs. It is stopped
 * at its job's deadline (`maxMinutes` in config/jobs.json, DEFAULT_JOB_MAX_MINUTES when unset, none when null), its
 * result then `timed-out`, and sooner when it shows no progress for capacity.stallMinutes, or the minutes of its
 * prompt's `Stall:` header line (src/jawans/progress.ts).
 * A run stopped by a rate or usage limit retries once on a lower allowed tier (never waiting: the tick runs every
 * minute) within the same deadline; a limit that names a later reset also pauses the model's due jobs until then
 * (limitPauseFor). If the agent never called `job finish`, record its captured output.
 */
export async function runHeadless(job: JobConfig, begun: BegunRun): Promise<string> {
    const name = job.name;
    // The prompt's Stall: line replaces capacity.stallMinutes; a malformed one fails before the run is registered,
    // as does a malformed maxMinutes.
    const stall = briefStallMinutes(begun.prompt) ?? stallMinutes(loadMachine());
    const maxMinutes = jobMaxMinutes(job);
    const deadlineAt = maxMinutes === null ? null : Date.now() + maxMinutes * runMinuteMs();
    registerRun({
        runId: begun.runId,
        pid: process.pid,
        from: loadMachine().name,
        task: null,
        startedAt: now().toISOString(),
        title: `job ${name}`,
    });
    // The tick starts toli with PATH alone; omp needs the login profile's provider keys.
    adoptLoginEnv();
    const choice = jobModel(job);
    let model: string | null;
    let fallback: string;
    let result: Outcome;
    const sessionDir = paths.jobSessionDir(begun.runId);
    let stalled = false;
    let timedOut = false;
    try {
        const attempt = async (chosen: string | null): Promise<Outcome> => {
            let root: StopRoot | null = null;
            const stopping: Promise<number[]>[] = [];
            const stop = (): void => {
                if (root !== null) stopping.push(stopTree(root, HARNESS_STOP_GRACE_MS));
            };
            const left = deadlineAt === null ? null : deadlineAt - Date.now();
            if (left !== null && left <= 0) {
                timedOut = true;
                return { code: 124, output: "" };
            }
            const deadline =
                left === null
                    ? null
                    : setTimeout(() => {
                          timedOut = true;
                          stop();
                      }, left);
            const stopWatch = watchStall(
                () => ({ pid: root?.pid ?? null, logPath: null, sessionDir, cwd: paths.root() }),
                stall,
                runMinuteMs(),
                () => {
                    stalled = true;
                    stop();
                },
            );
            try {
                return await runCombined(
                    headlessOmpArgs(begun.prompt, paths.root(), null, chosen, { dir: sessionDir }),
                    {
                        cwd: paths.root(),
                        onStart: (started) => {
                            root = { pid: started, spawnedAtMs: Date.now() };
                            if (timedOut) stop();
                        },
                    },
                );
            } finally {
                if (deadline !== null) clearTimeout(deadline);
                stopWatch();
                // omp's children that ignore SIGTERM end with it: the attempt is over once none is left.
                const survivors = (await Promise.all(stopping)).flat();
                if (survivors.length > 0) warn(`job ${name}: pid ${survivors.join(", ")} outlived SIGKILL`);
            }
        };
        ({ result, model, fallback } = await attemptWithinLimits(job, choice, attempt));
    } finally {
        removeRun(begun.runId);
    }
    if (timedOut) fallback += `; stopped: timed out after ${maxMinutes} min (maxMinutes in config/jobs.json)`;
    else if (stalled) fallback += `; stopped: ${stallText(stall)}`;
    const ran = `omp ${choiceText({ ...choice, model })}${fallback}`;
    const stillRunning = loadJobState()[name]?.running?.runId === begun.runId;
    const failed =
        timedOut || stalled || result.code !== 0 || (!stillRunning && loadJobState()[name]?.lastStatus === "failed");
    // A failed run's session stays for the resume command omp printed; `bin/toli prune` removes it later.
    const session = failed ? sessionFile(sessionDir) : null;
    if (session === null) rmSync(sessionDir, { recursive: true, force: true });
    const resume =
        session === null
            ? []
            : [
                  "",
                  `Session kept: resume it with \`omp --cwd ${paths.root()} --session-dir ${sessionDir} --resume ${session}\` (\`bin/toli prune\` removes it after ${loadRetention().jobResultsDays} days).`,
              ];
    if (!stillRunning)
        return `job ${name} ${begun.runId}: finished by the agent (${ran}, exit ${result.code})${session === null ? "" : `; session kept in ${sessionDir}`}`;
    const lead = timedOut
        ? `Timed out: omp was still running at this job's deadline of ${maxMinutes} min (maxMinutes in config/jobs.json) and was stopped without calling \`bin/toli job finish\`; captured output follows.`
        : `omp exited ${result.code} without calling \`bin/toli job finish\`; captured output follows.`;
    const body = [lead, `Model: ${ran}.`, "", "```text", result.output.trimEnd(), "```", ...resume].join("\n");
    const status = timedOut ? "timed-out" : result.code === 0 ? "ok" : "failed";
    const path = finishJob(name, begun.runId, body, status);
    return `job ${name} ${begun.runId}: ${ran}, ${timedOut ? "timed out" : `exit ${result.code}`}, result ${path}`;
}
