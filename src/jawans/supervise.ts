// `bin/toli run supervise <runId>`: the detached process `bin/toli spawn` starts for each jawan. It counts the run
// as load (state/runs/<runId>.json), runs the harness's headless command in the jawan's cwd with TOLI_ROLE=jawan
// (its own process group, output streamed to output.log), records the outcome, and posts it to the inbox, from
// where `bin/toli wake` (omp extension tick, Claude Code UserPromptSubmit hook) brings it into the lead's chat.
import { spawn as spawnChild } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, ToliError, warn } from "../core/util.ts";
import { registerRun, removeRun } from "../fleet/resources.ts";
import { headlessCommand } from "../harness/harness.ts";
import { deliverOutbox, queueOutbox } from "../jobs/jobs.ts";
import { addInboxItem } from "../records/inbox.ts";
import { type JawanRun, killGroup, loadRun, updateRun } from "./runs.ts";

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

function postOutcome(run: JawanRun): void {
    const machine = loadMachine();
    const { title, body } = outcomeMessage(run, tail(run.logPath, OUTPUT_TAIL));
    const inbox = addInboxItem(machine.name, title, body);
    updateRun(run.id, (record) => {
        record.inbox = inbox;
    });
    if (machine.role === "worker") {
        queueOutbox(machine, title, body, run.id);
        for (const error of deliverOutbox(machine).errors) warn(`outbox: ${error}`);
    }
}

type ChildExit = { code: number | null; signal: string | null; error: string | null };

export async function superviseRun(id: string): Promise<void> {
    const machine = loadMachine();
    const initial = loadRun(id);
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
    const env: Record<string, string | undefined> = { ...process.env, TOLI_ROLE: "jawan", TOLI_RUN_ID: id };
    // A Claude Code lead exports these; a nested `claude -p` must start as its own top-level session.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const logFd = openSync(initial.logPath, "a");
    let timedOut = false;
    try {
        const [program, ...programArgs] = command.argv;
        if (program === undefined) throw new ToliError("empty harness command");
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
            (initial.maxMinutes + KILL_GRACE_MINUTES) * 60_000,
        );
        const result = await exited;
        clearTimeout(timer);
        const finished = updateRun(id, (run) => {
            run.exitCode = result.code;
            run.signal = result.signal;
            run.endedAt = now().toISOString();
            if (run.status === "killed") return;
            run.status = result.code === 0 && !timedOut ? "done" : "failed";
            if (result.error !== null) run.error = result.error;
            else if (timedOut) run.error = `timed out after ${run.maxMinutes + KILL_GRACE_MINUTES} minutes`;
        });
        postOutcome(finished);
    } finally {
        closeSync(logFd);
        removeRun(id);
    }
}
