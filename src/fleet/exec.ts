// `bin/toli exec`: the target's side of `bin/toli remote`. Runs the stdin prompt in headless omp here, recorded as a
// jawan run on the model this machine's tiers pick, with no time limit unless one was asked for; a run that stalls is
// stopped and its own omp session resumed.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Args, parseMinutes } from "../core/args.ts";
import { loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, readStdin, requireName, runTee, stamp, type TeeResult, ToliError, warn } from "../core/util.ts";
import { harnessConfig, parseWork, type WorkType } from "../harness/harness.ts";
import {
    briefTier,
    choiceText,
    hitLimit,
    limitPlan,
    limitReset,
    parseOptionalTier,
    parseUsage,
    resolveModel,
    type Tier,
    type Usage,
} from "../harness/models.ts";
import { headlessOmpArgs } from "../harness/omp-args.ts";
import { recordRun, sessionFile } from "../jawans/launch.ts";
import { continuePrompt, hasReport, usedTimeLimit } from "../jawans/limits.ts";
import { stallText, watchStall } from "../jawans/progress.ts";
import { loadRun, runMinuteMs, updateRun } from "../jawans/runs.ts";
import { HARNESS_STOP_GRACE_MS, stopTree } from "../jawans/stop.ts";
import { ISSUED_BY_ENV, ISSUED_TASK_ENV } from "../records/push-log.ts";
import { keepDiskBeforeWork } from "./disk.ts";
import {
    EXEC_MAX_MINUTES_ENV,
    EXEC_PROJECT_ENV,
    EXEC_TASK_TIER_ENV,
    EXEC_TIER_ENV,
    EXEC_WORK_ENV,
    execKillMs,
    KILL_MARGIN_MINUTES,
    REMOTE_HEADER,
} from "./remote.ts";
import { autoResumeLimit, localStartRefusal, registerRun, removeRun, stallMinutes } from "./resources.ts";

/** Run-record title: the request's first line, skipping the remote-dispatch header block. */
function runTitle(prompt: string): string {
    const body = prompt.startsWith(REMOTE_HEADER) ? prompt.slice(prompt.indexOf("\n\n") + 2) : prompt;
    const line =
        body
            .split("\n")
            .find((entry) => entry.trim() !== "")
            ?.trim() ?? "";
    return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

/** A limit retry needs at least this much of an explicit exec limit left. */
const MIN_RETRY_MINUTES = 5;

/** The exec's tier and work type from `remote`'s variables; empty or absent is none. */
function execRequest(): { tier: Tier | null; taskTier: Tier | null; work: WorkType | null } {
    const tier = process.env[EXEC_TIER_ENV] ?? "";
    const taskTier = process.env[EXEC_TASK_TIER_ENV] ?? "";
    const work = process.env[EXEC_WORK_ENV] ?? "";
    return {
        tier: parseOptionalTier(tier === "" ? undefined : tier, EXEC_TIER_ENV) ?? null,
        taskTier: parseOptionalTier(taskTier === "" ? undefined : taskTier, EXEC_TASK_TIER_ENV) ?? null,
        work: work === "" ? null : parseWork(work, EXEC_WORK_ENV),
    };
}

/**
 * `toli exec`: run the stdin prompt in headless omp here. It is recorded as a jawan run (state/jawans/, so `runs`,
 * `digest` and the jawan slots see it) and counted as load (state/runs/) for its lifetime; its output streams back
 * to the caller and into the run's output.log, and the run ends done or failed with omp's exit. The run carries the
 * issuing machine and task in its environment, so a `bin/toli push` in it is logged as theirs. There is no wall-clock
 * limit unless `bin/toli remote --max-time` set `TOLI_EXEC_MAX_MINUTES`; a run that shows no progress for
 * capacity.stallMinutes is stopped, and a stalled or limited run without a report resumes its own omp session (up to
 * capacity.autoResume times). The model comes from this machine's tiers (`TOLI_EXEC_TIER`, the prompt's Tier: line,
 * `TOLI_EXEC_WORK`); a run stopped by a rate or usage limit retries once on a fallback model, never waiting for a reset.
 */
export async function execCommand(argv: string[]): Promise<number> {
    const args = new Args(argv, { values: ["from", "task"] });
    args.maxPositional(0);
    const prompt = readStdin();
    if (prompt.trim() === "") throw new ToliError("exec needs the prompt on stdin");
    const machine = loadMachine();
    const maxMinutes = parseMinutes(process.env[EXEC_MAX_MINUTES_ENV]) ?? null;
    const from = requireName("machine", args.str("from") ?? machine.name);
    const task = args.str("task") ?? null;
    if (task !== null) requireName("task", task);
    const projectEnv = process.env[EXEC_PROJECT_ENV];
    const project = projectEnv === undefined || projectEnv === "" ? null : requireName("project", projectEnv);
    const request = execRequest();
    const config = harnessConfig();
    const choice = resolveModel(
        "omp",
        { tier: request.tier, briefTier: briefTier(prompt), taskTier: request.taskTier, work: request.work },
        config,
    );
    const refusal = localStartRefusal();
    if (refusal.length > 0) {
        throw new ToliError(`exec: ${machine.name} is full (${refusal.join("; ")}); not starting this run here`);
    }
    keepDiskBeforeWork();
    const jawan = recordRun(
        {
            harness: "omp",
            task,
            project,
            work: request.work,
            model: choice.model,
            tier: choice.tier,
            modelSource: choice.source,
            cwd: paths.root(),
            maxMinutes,
            baseBrief: prompt,
            extra: "",
        },
        {
            argv: headlessOmpArgs("<brief>", paths.root(), maxMinutes === null ? null : `${maxMinutes}m`, choice.model),
            ownerPid: process.pid,
        },
    );
    warn(`exec: recorded as run ${jawan.id} on ${machine.name} (from ${from}), omp ${choiceText(choice)}`);
    const runId = `exec-${stamp()}-${process.pid}`;
    registerRun({
        runId,
        pid: process.pid,
        from,
        task,
        startedAt: now().toISOString(),
        title: runTitle(prompt),
    });
    const startedMs = Date.now();
    const stall = stallMinutes(machine);
    const sessionDir = jawan.sessionDir ?? join(jawan.runDir, "session");
    type ExecAttempt = TeeResult & { output: string; stalled: boolean; elapsedMs: number };
    const attempt = async (
        model: string | null,
        minutes: number | null,
        text: string,
        resume: string | undefined,
    ): Promise<ExecAttempt> => {
        const offset = existsSync(jawan.logPath) ? statSync(jawan.logPath).size : 0;
        const launched = Date.now();
        let pid: number | null = null;
        let stalled = false;
        const stopping: Promise<number[]>[] = [];
        const stopWatch = watchStall(
            () => ({ pid, logPath: jawan.logPath, sessionDir, cwd: paths.root() }),
            stall,
            runMinuteMs(),
            () => {
                stalled = true;
                warn(`exec: ${stallText(stall)}; stopping omp`);
                if (pid !== null) stopping.push(stopTree(pid, HARNESS_STOP_GRACE_MS));
            },
        );
        try {
            const timeoutMs = execKillMs(minutes);
            const result = await runTee(
                headlessOmpArgs(text, paths.root(), minutes === null ? null : `${minutes}m`, model, {
                    dir: sessionDir,
                    resume,
                }),
                jawan.logPath,
                {
                    cwd: paths.root(),
                    ...(timeoutMs === undefined ? {} : { timeoutMs }),
                    env: { [ISSUED_BY_ENV]: from, [ISSUED_TASK_ENV]: task ?? undefined },
                    onStart: (started) => {
                        pid = started;
                        updateRun(jawan.id, (record) => {
                            record.pid = started;
                        });
                    },
                },
            );
            const output = readFileSync(jawan.logPath).subarray(offset).toString("utf8");
            return { ...result, output, stalled, elapsedMs: Date.now() - launched };
        } finally {
            stopWatch();
            // omp's children that ignore SIGTERM end with it: the attempt is over once none is left.
            const survivors = (await Promise.all(stopping)).flat();
            if (survivors.length > 0) warn(`exec: pid ${survivors.join(", ")} outlived SIGKILL`);
        }
    };
    /** How the attempt stopped without a report, in words; null when it finished or reported. */
    const stoppedText = (result: ExecAttempt, minutes: number | null): string | null => {
        if (hasReport(result.output)) return null;
        if (result.stalled) return `stalled (${stallText(stall)})`;
        if (minutes !== null && usedTimeLimit(result.elapsedMs, minutes, 60_000, result.timedOut))
            return `hit its ${minutes}-minute time limit`;
        return null;
    };
    let code = 1;
    let timedOut = false;
    let error: string | null = null;
    let usage: Usage | null = null;
    let stopped: string | null = null;
    try {
        let model = choice.model;
        let result = await attempt(model, maxMinutes, prompt, undefined);
        const left = maxMinutes === null ? null : maxMinutes - Math.ceil((Date.now() - startedMs) / 60_000);
        if (
            !result.timedOut &&
            !result.stalled &&
            hitLimit(result.output, result.code) &&
            loadRun(jawan.id).status !== "killed"
        ) {
            const at = now();
            const plan = limitPlan(
                { harness: "omp", model: choice.model, tier: choice.tier, work: request.work },
                limitReset(result.output, at),
                at,
                config,
            );
            const retry = plan.kind === "switch" && (left === null || left >= MIN_RETRY_MINUTES);
            const reason = retry
                ? plan.reason
                : plan.kind === "switch"
                  ? `only ${left} minutes of the limit left`
                  : `exec never waits for a reset (${plan.reason})`;
            const to = plan.kind === "switch" ? plan.model : null;
            const note = `${choice.model ?? "the omp default"} hit a rate/usage limit; ${retry ? `retrying once on ${to}` : "no retry"} (${reason})`;
            warn(`exec: ${note}`);
            updateRun(jawan.id, (record) => {
                record.fallback = {
                    at: at.toISOString(),
                    from: choice.model,
                    to: retry ? to : null,
                    tier: retry && plan.kind === "switch" ? plan.tier : null,
                    waitedMinutes: 0,
                    reason,
                };
                if (retry && plan.kind === "switch") {
                    record.model = plan.model;
                    record.tier = plan.tier;
                }
            });
            if (retry && plan.kind === "switch") {
                model = plan.model;
                result = await attempt(model, left, prompt, undefined);
            }
        }
        const cap = autoResumeLimit(machine);
        let resumes = 0;
        stopped = stoppedText(result, maxMinutes);
        while (stopped !== null && resumes < cap && loadRun(jawan.id).status !== "killed") {
            const session = sessionFile(sessionDir);
            if (session === null) break;
            resumes += 1;
            const facts = {
                number: resumes,
                cap,
                previousRun: jawan.id,
                stopped,
                cwd: paths.root(),
                previousLog: jawan.logPath,
            };
            warn(`exec: run ${jawan.id} ${stopped}; resuming its session (${resumes} of at most ${cap})`);
            updateRun(jawan.id, (record) => {
                record.resumeCount = resumes;
                record.resumeReason = result.stalled ? "stalled" : "time-limit";
                record.resumeSession = session;
            });
            result = await attempt(model, maxMinutes, continuePrompt(facts), session);
            stopped = stoppedText(result, maxMinutes);
        }
        ({ code, timedOut } = result);
        usage = parseUsage(result.output);
        return code;
    } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        throw caught;
    } finally {
        removeRun(runId);
        updateRun(jawan.id, (record) => {
            record.exitCode = code;
            record.endedAt = now().toISOString();
            if (usage !== null) record.usage = usage;
            if (record.status === "killed") return;
            if (error === null && stopped !== null) {
                record.status = stopped.startsWith("stalled") ? "stalled" : "time-limit";
                record.error = `${stopped} without a report`;
                return;
            }
            record.status = code === 0 && !timedOut && error === null ? "done" : "failed";
            if (error !== null) record.error = error;
            else if (timedOut) record.error = `timed out after ${(maxMinutes ?? 0) + KILL_MARGIN_MINUTES} minutes`;
        });
    }
}
