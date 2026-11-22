// One supervised run of a gate's recipe (src/forge/gate.ts): in its own process group, its output appended to the
// gate's log, stopped when it makes no progress for the stall minutes (the jawan stall check,
// src/jawans/progress.ts), when it runs away (over RUNAWAY_FACTOR times its estimate, or printing failures for
// FAILING_MINUTES: a red gate on an overloaded machine can take hours to finish failing), or when its runner gets
// SIGTERM/SIGINT.
import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { now } from "../core/util.ts";
import { watchStall } from "../jawans/progress.ts";
import { runMinuteMs } from "../jawans/runs.ts";
import type { Argv } from "../jawans/scope.ts";
import { stopTree } from "../jawans/stop.ts";
import { type GateRecord, type GateStatus, logDecision, short, updateRecord } from "./gate-record.ts";

/** After SIGTERM, how long a stopped gate's processes get before SIGKILL. */
export const STOP_GRACE_MS = 10_000;
/** A gate running this many times its estimate (GateRecord.estimateMs) is stopped as a runaway. */
export const RUNAWAY_FACTOR = 3;
/** A gate printing failure lines for this many minutes, none more than FAILURE_GAP_MINUTES apart, is a runaway. */
export const FAILING_MINUTES = 30;
const FAILURE_GAP_MINUTES = 10;

/** How a recipe run ended: its exit code or signal, or why it could not start. */
export type RecipeEnd = { code: number | null; signal: NodeJS.Signals | null; error?: string };

/**
 * One supervised recipe run: how it ended, why the runner stopped it (null: it ended by itself), what outlived it and
 * how long it ran (ms).
 */
export type RecipeRun = {
    end: RecipeEnd;
    stopped: { status: GateStatus; reason: string } | null;
    survivors: number[];
    elapsedMs: number;
};

/** Terminal color and style sequences, which test runners put around their FAIL marks. */
const ANSI_STYLE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * Whether a log line reports a failure, in the shapes common test runners and compilers print: `FAIL`/`FAILED` or a
 * cross mark leading the line (Vitest, Jest, nextest), `... FAILED` (cargo test), `(fail)` (bun test), a nonzero
 * `<n> failed` count, `error[E<n>]:` (rustc) and `error TS<n>:` (tsc). A bare `error:` or a panic message is not one:
 * passing suites print those from tests of error paths.
 */
export function failureLine(line: string): boolean {
    const text = line.replace(ANSI_STYLE, "");
    return (
        /^\s*(?:FAIL|FAILED)\b/.test(text) ||
        /^\s*[✗×✘]\s/.test(text) ||
        /\.\.\. FAILED\b/.test(text) ||
        /\(fail\)/.test(text) ||
        /(?<![\d.])[1-9]\d* (?:failed|failing)\b/.test(text) ||
        /\berror\[E\d+\]:/.test(text) ||
        /\berror TS\d+:/.test(text)
    );
}

/** A run of failure lines: when the first was seen, and the latest. */
export type FailureStreak = { since: number; last: number };

/** The streak after a failure line seen at `at`: a gap over `gapMs` since the last one starts a new streak. */
export function extendStreak(streak: FailureStreak | null, at: number, gapMs: number): FailureStreak {
    return streak === null || at - streak.last > gapMs ? { since: at, last: at } : { since: streak.since, last: at };
}

function minutesText(ms: number, minuteMs: number): string {
    return `${Math.round((ms / minuteMs) * 10) / 10} minutes`;
}

/**
 * Run `argv` (the recipe, or systemd-run starting it in its scope) for the gate recorded in `file`, in its own process
 * group with `env`, output appended to the gate's log; stop it only when it stops making progress, runs away or the
 * runner gets SIGTERM/SIGINT.
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
    const decoder = new TextDecoder();
    let size = statSync(record.log).size;
    let partial = "";
    let failing: FailureStreak | null = null;
    const estimateMs = record.estimateMs;
    const failingMs = FAILING_MINUTES * minuteMs;
    const runaway = (reason: string): void => {
        if (stopped !== null) return;
        logDecision(record, "runaway", `${record.recipe} at ${short(record.sha)}: ${reason}`);
        stop("runaway", reason);
    };
    const output = setInterval(() => {
        const at = Date.now();
        if (estimateMs !== undefined && at - spawnedAtMs > Math.max(RUNAWAY_FACTOR * estimateMs, minuteMs))
            runaway(
                `ran ${minutesText(at - spawnedAtMs, minuteMs)}, over ${RUNAWAY_FACTOR} times its estimate of ` +
                    `${minutesText(estimateMs, minuteMs)} (the median of its recent passes); stopped it`,
            );
        const current = statSync(record.log).size;
        if (current === size) return;
        const text = readFrom(record.log, size, current);
        size = current;
        updateRecord(file, (entry) => {
            entry.lastOutputAt = now().toISOString();
        });
        const lines = (partial + decoder.decode(text, { stream: true })).split("\n");
        partial = lines.pop() ?? "";
        if (!lines.some(failureLine)) return;
        failing = extendStreak(failing, at, FAILURE_GAP_MINUTES * minuteMs);
        if (at - failing.since >= failingMs)
            runaway(
                `printed failures for ${minutesText(at - failing.since, minuteMs)} (since ` +
                    `${new Date(failing.since).toISOString()}); stopped it rather than let a red gate finish`,
            );
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
        return { end, stopped, survivors, elapsedMs: Date.now() - spawnedAtMs };
    } finally {
        clearInterval(output);
        stopWatch();
        for (const [signal, handler] of handlers) process.off(signal, handler);
    }
}

/** The bytes of `path` from `start` up to `end`. */
function readFrom(path: string, start: number, end: number): Uint8Array {
    const buffer = new Uint8Array(Math.max(0, end - start));
    const fd = openSync(path, "r");
    try {
        const read = readSync(fd, buffer, 0, buffer.length, start);
        return buffer.subarray(0, read);
    } finally {
        closeSync(fd);
    }
}
