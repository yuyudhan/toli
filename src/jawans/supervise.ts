// `bin/toli run supervise <runId>`: the detached process that starts each jawan run (src/jawans/launch.ts). It counts
// the run as load (state/runs/<runId>.json), runs the harness's headless command in the jawan's cwd with
// TOLI_ROLE=jawan (its own process group, output streamed to output.log), records the outcome, and posts it to the
// inbox, from where `bin/toli wake` (omp extension tick, Claude Code UserPromptSubmit hook) brings it into the lead's
// chat. A run stopped by its time limit without a report is continued automatically (up to capacity.autoResume per
// chain), and the freed slot starts the oldest queued run.
import { spawn as spawnChild } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { relative } from "node:path";
import { loadMachine, type Machine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, ToliError, warn } from "../core/util.ts";
import { autoResumeLimit, capacityFor, registerRun, removeRun } from "../fleet/resources.ts";
import { headlessCommand } from "../harness/harness.ts";
import { deliverOutbox, queueOutbox } from "../jobs/jobs.ts";
import { addInboxItem } from "../records/inbox.ts";
import { jawanEnv } from "./env.ts";
import { baseBriefOf, startOrQueue, startQueued } from "./launch.ts";
import { hasReport, resumeSection, usedTimeLimit } from "./limits.ts";
import { type JawanRun, killGroup, loadRun, runMinuteMs, updateRun } from "./runs.ts";

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
        `- harness: ${run.harness}${run.model === null ? "" : ` (model ${run.model})`}`,
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
    const command = headlessCommand(initial.harness, {
        brief: readFileSync(initial.briefPath, "utf8"),
        cwd: initial.cwd,
        root: paths.root(),
        model: initial.model ?? undefined,
        maxMinutes: initial.maxMinutes,
    });
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
    let timedOut = false;
    try {
        const [program, ...programArgs] = command.argv;
        if (program === undefined) throw new ToliError("empty harness command");
        const launchedAt = Date.now();
        const child = spawnChild(program, programArgs, {
            cwd: initial.cwd,
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
            updateRun(id, (run) => {
                if (run.status === "starting") run.status = "running";
                run.pid = childPid;
            });
        const timer = setTimeout(
            () => {
                timedOut = true;
                if (childPid !== null) killGroup(childPid, "SIGTERM");
            },
            (initial.maxMinutes + KILL_GRACE_MINUTES) * minuteMs,
        );
        const result = await exited;
        clearTimeout(timer);
        const elapsedMs = Date.now() - launchedAt;
        const output = existsSync(initial.logPath) ? readFileSync(initial.logPath, "utf8") : "";
        let finished = updateRun(id, (run) => {
            run.exitCode = result.code;
            run.signal = result.signal;
            run.endedAt = now().toISOString();
            if (run.status === "killed") return;
            if (
                result.error === null &&
                usedTimeLimit(elapsedMs, run.maxMinutes, minuteMs, timedOut) &&
                !hasReport(output)
            ) {
                run.status = "time-limit";
                run.error = `stopped by its ${run.maxMinutes}-minute time limit without a report`;
                return;
            }
            run.status = result.code === 0 && !timedOut ? "done" : "failed";
            if (result.error !== null) run.error = result.error;
            else if (timedOut) run.error = `timed out after ${run.maxMinutes + KILL_GRACE_MINUTES} minutes`;
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
