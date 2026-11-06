// `bin/toli run supervise <runId>`: the detached process that starts each jawan run (src/jawans/launch.ts). It counts
// the run as load (state/runs/<runId>.json), runs the harness's headless command in the jawan's cwd with
// TOLI_ROLE=jawan (its own process group, output streamed to output.log), records the outcome, and posts it to the
// inbox, from where `bin/toli wake` (omp extension tick, Claude Code UserPromptSubmit hook) brings it into the lead's
// chat. A run stopped by its time limit without a report is continued automatically (up to capacity.autoResume per
// chain), and the freed slot starts the oldest queued run.
import { spawn as spawnChild } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { availableParallelism } from "node:os";
import { relative } from "node:path";
import { loadMachine, type Machine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, ToliError, warn } from "../core/util.ts";
import { autoResumeLimit, capacityFor, registerRun, removeRun } from "../fleet/resources.ts";
import { harnessConfig, headlessCommand } from "../harness/harness.ts";
import { hitLimit, limitPlan, limitReset, parseUsage } from "../harness/models.ts";
import { deliverOutbox, queueOutbox } from "../jobs/outbox.ts";
import { addInboxItem } from "../records/inbox.ts";
import { jawanEnv } from "./env.ts";
import { baseBriefOf, startOrQueue, startQueued } from "./launch.ts";
import { deadlineSection, hasReport, resumeSection, usedTimeLimit } from "./limits.ts";
import { type JawanRun, killGroup, loadRun, modelText, runMinuteMs, updateRun } from "./runs.ts";

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
            : [`- continues: ${run.resumeOf} (automatic continuation ${run.resumeCount ?? 1})`]),
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

/** Post one item to this machine's inbox and, on a worker, forward it to the coordinator. Returns the inbox path. */
function notify(machine: Machine, title: string, body: string, outboxId: string): string {
    const inbox = addInboxItem(machine.name, title, body);
    if (machine.role === "worker") {
        queueOutbox(machine, title, body, outboxId);
        for (const error of deliverOutbox(machine).errors) warn(`outbox: ${error}`);
    }
    return inbox;
}

function postOutcome(machine: Machine, run: JawanRun): void {
    const { title, body } = outcomeMessage(run, tail(run.logPath, OUTPUT_TAIL));
    const inbox = notify(machine, title, body, run.id);
    updateRun(run.id, (record) => {
        record.inbox = inbox;
    });
}

/**
 * Continue a run stopped by its time limit without a report: same brief, task, project, cwd, harness, model and limit,
 * plus a RESUME section; queued like any spawn when every slot is busy. Past capacity.autoResume continuations in the
 * chain, an inbox item says the chain stopped instead.
 */
function autoResume(machine: Machine, run: JawanRun): JawanRun {
    const cap = autoResumeLimit(machine);
    const number = (run.resumeCount ?? 0) + 1;
    if (number > cap) {
        const where = [run.task, run.project === null ? null : `(${run.project})`].filter(Boolean).join(" ");
        const body = [
            `- run: ${run.id}${where === "" ? "" : ` ${where}`}`,
            `- log: ${relative(paths.root(), run.logPath)}`,
            `- brief: ${relative(paths.root(), run.briefPath)}`,
            "",
            cap === 0
                ? "It hit its time limit without a report, and auto-resume is off (config/machine.json capacity.autoResume is 0)."
                : `It hit its time limit without a report after ${cap} automatic continuations (config/machine.json capacity.autoResume), so no further run was started.`,
            `Its edits are uncommitted in ${run.cwd}. Look at the work, then relaunch with a narrower brief or a longer --max-time, or finish it by hand.`,
        ].join("\n");
        const title = `jawan ${run.id} not resumed: auto-resume limit reached${where === "" ? "" : ` for ${where}`}`;
        notify(machine, title, body, `${run.id}-resume-cap`);
        return run;
    }
    const next = startOrQueue(
        {
            harness: run.harness,
            task: run.task,
            project: run.project,
            work: run.work,
            model: run.model,
            tier: run.tier ?? null,
            modelSource: run.modelSource ?? "harness default",
            cwd: run.cwd,
            maxMinutes: run.maxMinutes,
            baseBrief: baseBriefOf(run),
            extra: resumeSection({
                number,
                cap,
                previousRun: run.id,
                maxMinutes: run.maxMinutes,
                cwd: run.cwd,
                previousLog: run.logPath,
            }),
            resumeOf: run.id,
            resumeCount: number,
        },
        { now: false },
    );
    return updateRun(run.id, (record) => {
        record.resumedBy = next.id;
    });
}

/** Start queued runs into free slots; one that cannot start has its failure posted. Returns one note per run. */
export function drainQueue(): string[] {
    const machine = loadMachine();
    const { started, failed } = startQueued();
    for (const { run } of failed) postOutcome(machine, run);
    return [
        ...started.map((run) => `jawan ${run.id}: started from the queue`),
        ...failed.map(({ run, error }) => `jawan ${run.id}: could not start from the queue: ${error}`),
    ];
}

type ChildExit = { code: number | null; signal: string | null; error: string | null };

type Attempt = { exit: ChildExit; timedOut: boolean; elapsedMs: number; output: string };

/** How often a supervisor waiting out a limit checks whether the run was killed meanwhile. */
const WAIT_POLL_MS = 5000;

/**
 * Run the harness once for the run as recorded now (its model, its brief) and wait for it. The supervisor kills the
 * process group `KILL_GRACE_MINUTES` past the run's limit. `output` is this attempt's part of the log only.
 */
async function runAttempt(id: string, env: NodeJS.ProcessEnv, logFd: number, minuteMs: number): Promise<Attempt> {
    const run = loadRun(id);
    const command = headlessCommand(run.harness, {
        brief: readFileSync(run.briefPath, "utf8"),
        cwd: run.cwd,
        root: paths.root(),
        model: run.model ?? undefined,
        maxMinutes: run.maxMinutes,
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
    let timedOut = false;
    const timer = setTimeout(
        () => {
            timedOut = true;
            if (childPid !== null) killGroup(childPid, "SIGTERM");
        },
        (run.maxMinutes + KILL_GRACE_MINUTES) * minuteMs,
    );
    const exit = await exited;
    clearTimeout(timer);
    const elapsedMs = Date.now() - launchedAt;
    const output = existsSync(run.logPath) ? readFileSync(run.logPath).subarray(offset).toString("utf8") : "";
    return { exit, timedOut, elapsedMs, output };
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
function refreshDeadline(briefPath: string, maxMinutes: number, minuteMs: number): void {
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
    if (run.status === "killed" || first.timedOut || first.exit.error !== null) return null;
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
    const env = jawanEnv(process.env, id, capacityFor(machine, availableParallelism()).cargoJobs);
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
        const usage = parseUsage(last.output);
        let finished = updateRun(id, (run) => {
            run.exitCode = result.code;
            run.signal = result.signal;
            run.endedAt = now().toISOString();
            if (usage !== null) run.usage = usage;
            if (run.status === "killed") return;
            if (
                result.error === null &&
                usedTimeLimit(last.elapsedMs, run.maxMinutes, minuteMs, timedOut) &&
                !hasReport(output)
            ) {
                run.status = "time-limit";
                run.error = `stopped by its ${run.maxMinutes}-minute time limit without a report`;
                return;
            }
            run.status = result.code === 0 && !timedOut ? "done" : "failed";
            if (result.error !== null) run.error = result.error;
            else if (timedOut) run.error = `timed out after ${run.maxMinutes + KILL_GRACE_MINUTES} minutes`;
            else if (run.status === "failed" && hitLimit(last.output, result.code))
                run.error = "stopped on a rate/usage limit";
        });
        if (finished.status === "time-limit") {
            try {
                finished = autoResume(machine, finished);
            } catch (error) {
                warn(`auto-resume of ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        postOutcome(machine, finished);
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
