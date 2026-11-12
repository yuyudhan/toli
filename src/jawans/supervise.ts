// `bin/toli run supervise <runId>`: the detached process that starts each jawan run (src/jawans/launch.ts). It counts
// the run as load (state/runs/<runId>.json), runs the harness's headless command in the jawan's cwd with
// TOLI_ROLE=jawan (its own process group, output streamed to output.log), records the outcome, and posts it to the
// inbox, from where `bin/toli wake` (omp extension tick, Claude Code UserPromptSubmit hook) brings it into the lead's
// chat. A run has no wall-clock limit unless given `--max-time`; one that stalls (no progress for
// capacity.stallMinutes, src/jawans/progress.ts), hits its explicit limit without a report, or stops on a rate/usage
// limit is resumed: the same omp session continues (`omp --resume`), up to capacity.autoResume times per chain. When
// a harness exits, the automation browsers its run left open are closed (src/jawans/browsers.ts). The freed slot
// starts the oldest queued run.
import { spawn as spawnChild } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { availableParallelism, constants } from "node:os";
import { relative } from "node:path";
import { loadMachine, type Machine } from "../core/config.ts";
import { adoptLoginEnv } from "../core/login-env.ts";
import { paths } from "../core/paths.ts";
import { now, ToliError, warn } from "../core/util.ts";
import { capacityFor, DEFAULT_STALL_MINUTES, registerRun, removeRun } from "../fleet/resources.ts";
import { harnessConfig, headlessCommand } from "../harness/harness.ts";
import { hitLimit, limitPlan, limitReset, parseUsage } from "../harness/models.ts";
import { isLiveStack } from "../projects/projects.ts";
import { loadBacklog } from "../records/backlog.ts";
import { addInboxItem } from "../records/inbox.ts";
import { runTaskEnd } from "../records/task-end.ts";
import { watchBrowsers } from "./browsers.ts";
import { autoResume } from "./continue.ts";
import { jawanEnv } from "./env.ts";
import { startQueued } from "./launch.ts";
import { deadlineSection, hasReport, onlyHarnessErrors, usedTimeLimit } from "./limits.ts";
import { stallText, watchStall } from "./progress.ts";
import { type JawanRun, loadRun, modelText, runMinuteMs, updateRun } from "./runs.ts";
import { HARNESS_STOP_GRACE_MS, stopTree } from "./stop.ts";

/** Grace after the harness's own time limit before the supervisor kills the process group. */
export const KILL_GRACE_MINUTES = 10;
const OUTPUT_TAIL = 4000;

function tail(path: string, limit: number): string {
    if (!existsSync(path)) return "";
    const text = readFileSync(path, "utf8").trimEnd();
    return text.length <= limit ? text : `[... earlier output in ${path}]\n${text.slice(-limit)}`;
}

function durationText(run: JawanRun): string {
    if (run.endedAt === null) return "";
    const seconds = Math.max(0, Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000));
    return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

/**
 * How a killed run's harness ended, as the signal toli sent: a shell harness whose foreground command dies by signal n
 * exits 128 + n instead of dying by it, so `exit 143` from a killed run is SIGTERM.
 */
export function killedExit(exit: ChildExit): ChildExit {
    const code = exit.code;
    if (exit.signal !== null || code === null || code <= 128) return exit;
    const name = Object.entries(constants.signals).find(([, number]) => number === code - 128)?.[0];
    return name === undefined ? exit : { ...exit, code: null, signal: name };
}

/** The inbox title and body for a finished run. */
export function outcomeMessage(run: JawanRun, output: string): { title: string; body: string } {
    const where = [run.task, run.project === null ? null : `(${run.project})`].filter(Boolean).join(" ");
    const title = `jawan ${run.id} ${run.status}: ${run.harness}${where === "" ? "" : ` ${where}`}`;
    const exit =
        run.exitCode === null ? (run.signal === null ? "" : ` (signal ${run.signal})`) : ` (exit ${run.exitCode})`;
    const lines = [
        `- run: ${run.id}`,
        `- harness: ${modelText(run)}${run.modelSource === undefined ? "" : ` (model from ${run.modelSource})`}`,
        ...(run.fallback === undefined
            ? []
            : [
                  `- limit fallback: ${run.fallback.from ?? "default"} -> ${run.fallback.to ?? "no retry"} (${run.fallback.reason})`,
              ]),
        ...(run.task === null ? [] : [`- task: ${run.task}`]),
        ...(run.project === null ? [] : [`- project: ${run.project}`]),
        `- status: ${run.status}${exit}${run.error === null ? "" : `: ${run.error}`}`,
        ...(run.resumeOf === undefined
            ? []
            : [
                  `- continues: ${run.resumeOf} (continuation ${run.resumeCount ?? 1}${run.resumeReason === undefined ? "" : `, ${run.resumeReason}`}${run.resumeSession === undefined ? ", fresh run" : ", same session resumed"})`,
              ]),
        ...(run.resumedBy === undefined
            ? []
            : [`- continued by: ${run.resumedBy} (started automatically, or queued for a free slot)`]),
        ...(run.replaces === undefined ? [] : [`- replaces: ${run.replaces.join(", ")} (spawn --replace)`]),
        ...(run.replacedBy === undefined ? [] : [`- replaced by: ${run.replacedBy} (spawn --replace)`]),
        `- started: ${run.startedAt}, took ${durationText(run)}`,
        `- log: ${relative(paths.root(), run.logPath)}`,
        `- brief: ${relative(paths.root(), run.briefPath)}`,
        "",
        "## Final output",
        "",
        "```text",
        output === "" ? "(no output)" : output,
        "```",
    ];
    return { title, body: lines.join("\n") };
}

/** Jawans report only to their own machine's lead (docs/sardars.md): the outcome goes to this machine's inbox. */
function postOutcome(machine: Machine, run: JawanRun): void {
    const { title, body } = outcomeMessage(run, tail(run.logPath, OUTPUT_TAIL));
    const inbox = addInboxItem(machine.name, title, body);
    updateRun(run.id, (record) => {
        record.inbox = inbox;
    });
}

/**
 * Start queued runs into free slots; one that cannot start has its failure posted. Returns one note per run.
 * `diskKept`: the caller has seen to the disk already (the minute tick), so no inline keeper runs first.
 */
export function drainQueue(options: { diskKept?: boolean } = {}): string[] {
    const machine = loadMachine();
    const { started, failed } = startQueued(options);
    for (const { run } of failed) postOutcome(machine, run);
    return [
        ...started.map((run) => `jawan ${run.id}: started from the queue`),
        ...failed.map(({ run, error }) => `jawan ${run.id}: could not start from the queue: ${error}`),
    ];
}

type ChildExit = { code: number | null; signal: string | null; error: string | null };

type Attempt = { exit: ChildExit; timedOut: boolean; stalled: boolean; elapsedMs: number; output: string };

/** How often a supervisor waiting out a limit checks whether the run was killed meanwhile. */
const WAIT_POLL_MS = 5000;

/**
 * Run the harness once for the run as recorded now (its model, its brief or resume prompt, its session) and wait for
 * it. The process group is killed when the run stalls (no progress for its stallMinutes, src/jawans/progress.ts) or,
 * only with an explicit `--max-time`, `KILL_GRACE_MINUTES` past that limit. `output` is this attempt's part of the log.
 */
async function runAttempt(id: string, env: NodeJS.ProcessEnv, logFd: number, minuteMs: number): Promise<Attempt> {
    const run = loadRun(id);
    const command = headlessCommand(run.harness, {
        brief: readFileSync(run.briefPath, "utf8"),
        cwd: run.cwd,
        root: paths.root(),
        model: run.model ?? undefined,
        maxMinutes: run.maxMinutes,
        ...(run.sessionDir === undefined ? {} : { session: { dir: run.sessionDir, resume: run.resumeSession } }),
    });
    const [program, ...programArgs] = command.argv;
    if (program === undefined) throw new ToliError("empty harness command");
    const offset = fstatSync(logFd).size;
    const launchedAt = Date.now();
    const child = spawnChild(program, programArgs, {
        cwd: run.cwd,
        detached: true,
        env,
        stdio: [command.stdin === null ? "ignore" : "pipe", logFd, logFd],
    });
    const spawnedAtMs = Date.now();
    const { promise: exited, resolve: done } = Promise.withResolvers<ChildExit>();
    child.once("error", (error) => done({ code: null, signal: null, error: error.message }));
    child.once("exit", (code, signal) => done({ code, signal, error: null }));
    if (command.stdin !== null) child.stdin?.end(command.stdin);
    const childPid = child.pid ?? null;
    if (childPid !== null)
        updateRun(id, (record) => {
            if (record.status === "starting") record.status = "running";
            record.pid = childPid;
        });
    const browsers = childPid === null ? null : watchBrowsers({ pid: childPid, spawnedAtMs }, id, minuteMs);
    let timedOut = false;
    let stalled = false;
    const stopping: Promise<number[]>[] = [];
    const stop = (): void => {
        // A reaped harness's pid may already be someone else's: only a live (or unreaped) one is stopped.
        if (childPid === null || stopping.length > 0 || child.exitCode !== null || child.signalCode !== null) return;
        stopping.push(stopTree({ pid: childPid, spawnedAtMs }, HARNESS_STOP_GRACE_MS));
    };
    const timer =
        run.maxMinutes === null
            ? undefined
            : setTimeout(
                  () => {
                      timedOut = true;
                      stop();
                  },
                  (run.maxMinutes + KILL_GRACE_MINUTES) * minuteMs,
              );
    const stopWatch = watchStall(
        () => ({ pid: childPid, logPath: run.logPath, sessionDir: run.sessionDir ?? null, cwd: run.cwd }),
        run.stallMinutes ?? DEFAULT_STALL_MINUTES,
        minuteMs,
        () => {
            stalled = true;
            writeSync(logFd, `\n[toli] ${stallText(run.stallMinutes ?? DEFAULT_STALL_MINUTES)}: stopping the run\n`);
            stop();
        },
    );
    const exit = await exited;
    clearTimeout(timer);
    stopWatch();
    // A harness that exits on SIGTERM can leave children that ignore it: the attempt ends once all of them are gone.
    const survivors = (await Promise.all(stopping)).flat();
    if (survivors.length > 0) writeSync(logFd, `\n[toli] pid ${survivors.join(", ")} outlived SIGKILL\n`);
    await browsers?.finish(logFd);
    const elapsedMs = Date.now() - launchedAt;
    const output = existsSync(run.logPath) ? readFileSync(run.logPath).subarray(offset).toString("utf8") : "";
    return { exit, timedOut, stalled, elapsedMs, output };
}

/** Wait `minutes` run-minutes, returning false early when the run is killed meanwhile. */
async function waitUnlessKilled(id: string, minutes: number, minuteMs: number): Promise<boolean> {
    const until = Date.now() + minutes * minuteMs;
    while (Date.now() < until) {
        if (loadRun(id).status === "killed") return false;
        await Bun.sleep(Math.min(WAIT_POLL_MS, minuteMs, until - Date.now()));
    }
    return loadRun(id).status !== "killed";
}

/** The brief with its Deadline section replaced by one starting now, for the retry after a limit. */
function refreshDeadline(briefPath: string, maxMinutes: number | null, minuteMs: number): void {
    if (maxMinutes === null) return;
    const brief = readFileSync(briefPath, "utf8");
    const cut = brief.indexOf("\n## Deadline (auto)");
    const base = cut === -1 ? brief : brief.slice(0, cut);
    writeFileSync(briefPath, `${base.trimEnd()}\n${deadlineSection(now(), maxMinutes, minuteMs)}`);
}

/**
 * After an attempt that stopped on a rate or usage limit, retry once per limitPlan (src/harness/models.ts): on the
 * configured alternative or the next allowed lower tier, or on the same model after the reset. The decision goes into
 * the log and the run record. Returns the retry's attempt, or null when there is none.
 */
async function retryAfterLimit(
    id: string,
    first: Attempt,
    env: NodeJS.ProcessEnv,
    logFd: number,
    minuteMs: number,
): Promise<Attempt | null> {
    const run = loadRun(id);
    if (run.status === "killed" || first.timedOut || first.stalled || first.exit.error !== null) return null;
    if (!hitLimit(first.output, first.exit.code)) return null;
    const at = now();
    const plan = limitPlan(
        { harness: run.harness, model: run.model, tier: run.tier ?? null, work: run.work },
        limitReset(first.output, at),
        at,
        harnessConfig(),
    );
    const from = run.model ?? "the harness default";
    if (plan.kind === "none") {
        writeSync(logFd, `\n[toli] ${from} hit a rate/usage limit; no retry: ${plan.reason}\n`);
        updateRun(id, (record) => {
            record.fallback = {
                at: at.toISOString(),
                from: run.model,
                to: null,
                tier: null,
                waitedMinutes: 0,
                reason: plan.reason,
            };
        });
        return null;
    }
    const waitMinutes = plan.kind === "wait" ? plan.waitMinutes : 0;
    const to = plan.model ?? "the harness default";
    const note = `${from} hit a rate/usage limit; retrying once on ${to}${waitMinutes > 0 ? ` after ${waitMinutes} minutes` : ""} (${plan.reason})`;
    writeSync(logFd, `\n[toli] ${note}\n`);
    warn(`${id}: ${note}`);
    updateRun(id, (record) => {
        record.fallback = {
            at: at.toISOString(),
            from: run.model,
            to: plan.model,
            tier: plan.tier,
            waitedMinutes: waitMinutes,
            reason: plan.reason,
        };
        record.model = plan.model;
        record.tier = plan.tier;
    });
    if (waitMinutes > 0 && !(await waitUnlessKilled(id, waitMinutes, minuteMs))) return null;
    refreshDeadline(run.briefPath, run.maxMinutes, minuteMs);
    return await runAttempt(id, env, logFd, minuteMs);
}

/** A run that ends on a task already done or dropped (the jawan closed it itself) runs the task-end hook once more. */
function endTaskOfRun(run: JawanRun): void {
    if (run.task === null) return;
    try {
        const task = loadBacklog().tasks.find((entry) => entry.id === run.task);
        if (task !== undefined) runTaskEnd(task);
    } catch (error) {
        warn(`task-end hook after ${run.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function superviseRun(id: string): Promise<void> {
    const machine = loadMachine();
    const initial = loadRun(id);
    // Killed between its launch and this start: record it and never run the harness.
    if (initial.status === "killed") {
        postOutcome(
            machine,
            updateRun(id, (run) => {
                run.endedAt = now().toISOString();
            }),
        );
        return;
    }
    registerRun({
        runId: id,
        pid: process.pid,
        from: machine.name,
        task: initial.task,
        startedAt: initial.startedAt,
        title: `jawan ${initial.harness}${initial.task === null ? "" : ` ${initial.task}`}`,
    });
    // Started by the lead service or the tick, the harness would lack the profile's provider keys.
    adoptLoginEnv();
    const env = jawanEnv(
        process.env,
        id,
        capacityFor(machine, availableParallelism()).cargoJobs,
        isLiveStack(initial.project),
    );
    const logFd = openSync(initial.logPath, "a");
    const minuteMs = runMinuteMs();
    try {
        const first = await runAttempt(id, env, logFd, minuteMs);
        let last = first;
        try {
            last = (await retryAfterLimit(id, first, env, logFd, minuteMs)) ?? first;
        } catch (error) {
            warn(`limit fallback of ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const result = last.exit;
        const timedOut = last.timedOut;
        const output = existsSync(initial.logPath) ? readFileSync(initial.logPath, "utf8") : "";
        const reported = hasReport(output);
        const usage = parseUsage(last.output);
        let finished = updateRun(id, (run) => {
            const exit = run.status === "killed" ? killedExit(result) : result;
            run.exitCode = exit.code;
            run.signal = exit.signal;
            run.endedAt = now().toISOString();
            if (usage !== null) run.usage = usage;
            if (run.status === "killed") return;
            if (result.error === null && last.stalled && !reported) {
                run.status = "stalled";
                run.error = `stopped: ${stallText(run.stallMinutes ?? DEFAULT_STALL_MINUTES)}, without a report`;
                return;
            }
            if (
                result.error === null &&
                run.maxMinutes !== null &&
                usedTimeLimit(last.elapsedMs, run.maxMinutes, minuteMs, timedOut) &&
                !reported
            ) {
                run.status = "time-limit";
                run.error = `stopped by its ${run.maxMinutes}-minute time limit without a report`;
                return;
            }
            // A run that reported and then stalled (waiting on nothing) delivered its work; one that printed only
            // harness errors (a 429, an API error) did not, whatever its exit code.
            const errorOnly = onlyHarnessErrors(output);
            run.status =
                (result.code === 0 && !timedOut && !errorOnly) || (last.stalled && reported) ? "done" : "failed";
            if (result.error !== null) run.error = result.error;
            else if (timedOut) run.error = `timed out after ${(run.maxMinutes ?? 0) + KILL_GRACE_MINUTES} minutes`;
            else if (run.status === "failed" && hitLimit(last.output, result.code))
                run.error = "stopped on a rate/usage limit";
            else if (errorOnly) run.error = "the harness printed only errors, no report";
        });
        const stopped =
            finished.status === "stalled"
                ? { reason: "stalled", text: `stalled (${stallText(finished.stallMinutes ?? DEFAULT_STALL_MINUTES)})` }
                : finished.status === "time-limit"
                  ? { reason: "time-limit", text: `hit its ${finished.maxMinutes}-minute time limit` }
                  : null;
        if (stopped !== null) {
            try {
                finished = autoResume(machine, finished, stopped.reason, stopped.text);
            } catch (error) {
                warn(`auto-resume of ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        postOutcome(machine, finished);
        endTaskOfRun(finished);
    } finally {
        closeSync(logFd);
        removeRun(id);
    }
    // The finished run freed a slot.
    try {
        for (const note of drainQueue()) warn(note);
    } catch (error) {
        warn(`starting queued runs failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}
