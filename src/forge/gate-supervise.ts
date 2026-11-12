// One supervised run of a gate's recipe (src/forge/gate.ts): in its own process group, its output appended to the
// gate's log, stopped only when it makes no progress for the stall minutes (the jawan stall check,
// src/jawans/progress.ts) or its runner gets SIGTERM/SIGINT.
import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import { closeSync, openSync, statSync } from "node:fs";
import { now } from "../core/util.ts";
import { watchStall } from "../jawans/progress.ts";
import { runMinuteMs } from "../jawans/runs.ts";
import type { Argv } from "../jawans/scope.ts";
import { stopTree } from "../jawans/stop.ts";
import { type GateRecord, type GateStatus, logDecision, short, updateRecord } from "./gate-record.ts";

/** After SIGTERM, how long a stopped gate's processes get before SIGKILL. */
const STOP_GRACE_MS = 10_000;

/** How a recipe run ended: its exit code or signal, or why it could not start. */
export type RecipeEnd = { code: number | null; signal: NodeJS.Signals | null; error?: string };

/** One supervised recipe run: how it ended, why the runner stopped it (null: it ended by itself) and what outlived it. */
export type RecipeRun = { end: RecipeEnd; stopped: { status: GateStatus; reason: string } | null; survivors: number[] };

/**
 * Run `argv` (the recipe, or systemd-run starting it in its scope) for the gate recorded in `file`, in its own process
 * group with `env`, output appended to the gate's log; stop it only when it stops making progress or the runner gets
 * SIGTERM/SIGINT.
 */
export async function superviseRecipe(
    file: string,
    record: GateRecord,
    argv: Argv,
    env: NodeJS.ProcessEnv,
): Promise<RecipeRun> {
    const minuteMs = runMinuteMs();
    const pollMs = Math.max(50, Math.min(1000, (record.stallMinutes * minuteMs) / 10));
    const logFd = openSync(record.log, "a");
    let child: ChildProcess;
    try {
        child = spawnChild(argv[0], argv.slice(1), {
            cwd: record.dir,
            detached: true,
            env,
            stdio: ["ignore", logFd, logFd],
        });
    } finally {
        closeSync(logFd);
    }
    const spawnedAtMs = Date.now();
    const { promise: exited, resolve: done } = Promise.withResolvers<RecipeEnd>();
    child.on("exit", (code, signal) => done({ code, signal }));
    child.on("error", (error) => done({ code: 127, signal: null, error: error.message }));
    let stopped: RecipeRun["stopped"] = null;
    const stopping: Promise<number[]>[] = [];
    const stop = (status: GateStatus, reason: string): void => {
        if (stopped !== null || child.pid === undefined) return;
        stopped = { status, reason };
        // A reaped root's pid may already be someone else's: only a live (or unreaped) gate is stopped.
        if (child.exitCode === null && child.signalCode === null)
            stopping.push(stopTree({ pid: child.pid, spawnedAtMs }, STOP_GRACE_MS));
    };
    const handlers = (["SIGTERM", "SIGINT"] as const).map(
        (signal) => [signal, () => stop("killed", `its runner got ${signal}`)] as const,
    );
    for (const [signal, handler] of handlers) process.on(signal, handler);
    let size = statSync(record.log).size;
    const output = setInterval(() => {
        const current = statSync(record.log).size;
        if (current === size) return;
        size = current;
        updateRecord(file, (entry) => {
            entry.lastOutputAt = now().toISOString();
        });
    }, pollMs);
    const stopWatch = watchStall(
        () => ({ pid: child.pid ?? null, logPath: record.log, sessionDir: null, cwd: record.dir }),
        record.stallMinutes,
        minuteMs,
        () => {
            const reason = `no new output, file change or CPU use for ${record.stallMinutes} minutes; stopped it`;
            logDecision(record, "stall", `${record.recipe} at ${short(record.sha)}: ${reason}`);
            stop("stalled", reason);
        },
    );
    try {
        const end = await exited;
        // The recipe's shell may die on SIGTERM while a child that ignores it runs on: the record waits until all are gone.
        const survivors = (await Promise.all(stopping)).flat();
        return { end, stopped, survivors };
    } finally {
        clearInterval(output);
        stopWatch();
        for (const [signal, handler] of handlers) process.off(signal, handler);
    }
}
