// One supervised run of a gate's recipe (src/forge/gate.ts): in its own process group, its output appended to the
// gate's log, stopped when it makes no progress for the stall minutes (the jawan stall check,
// src/jawans/progress.ts), when it runs away (over RUNAWAY_FACTOR times its estimate, not counting time its heavy step
// waits in line for a heavy-build slot, or printing failures for FAILING_MINUTES: a red gate on an overloaded machine
// can take hours to finish failing), or when its runner gets SIGTERM/SIGINT.
import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { now } from "../core/util.ts";
import { busySlots } from "../fleet/build-queue.ts";
import { DEFERRED_SLOT_ENV, slotRequestFile } from "../fleet/heavy-step-slot.ts";
import { watchStall } from "../jawans/progress.ts";
import { runMinuteMs } from "../jawans/runs.ts";
import type { Argv } from "../jawans/scope.ts";
import { stopTree } from "../jawans/stop.ts";
import { type GateRecord, type GateStatus, logDecision, short, updateRecord } from "./gate-record.ts";

/** After SIGTERM, how long a stopped gate's processes get before SIGKILL. */
export const STOP_GRACE_MS = 10_000;
/**
 * A gate running this many times its estimate (GateRecord.estimateMs) is stopped as a runaway once it has also printed
 * nothing for RUNAWAY_QUIET_MINUTES: a recipe that grew but keeps printing runs on, passes, and moves its estimate.
 */
export const RUNAWAY_FACTOR = 3;
export const RUNAWAY_QUIET_MINUTES = 5;
/** A gate printing failure lines for this many minutes, none more than FAILURE_GAP_MINUTES apart, is a runaway. */
export const FAILING_MINUTES = 30;
const FAILURE_GAP_MINUTES = 10;

/** How a recipe run ended: its exit code or signal, or why it could not start. */
export type RecipeEnd = { code: number | null; signal: NodeJS.Signals | null; error?: string };

/**
 * One supervised recipe run: how it ended, why the runner stopped it (null: it ended by itself), what outlived it, how
 * long it ran (ms, not counting its slot wait) and how long its heavy step waited in line for a heavy-build slot (ms).
 */
export type RecipeRun = {
    end: RecipeEnd;
    stopped: { status: GateStatus; reason: string } | null;
    survivors: number[];
    elapsedMs: number;
    slotWaitMs: number;
};

/** Terminal color and style sequences, which test runners put around their FAIL marks. */
const ANSI_STYLE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * The failure lines runners print, each anchored where the runner puts it: a per-test failure (Vitest/Jest `FAIL <file>`
 * and `× <test>`, nextest `FAIL [<time>] <test>`, cargo `test <name> ... FAILED`, pytest `FAILED <file>::<test>`, bun
 * `(fail) <test>`), a final summary with a nonzero count (cargo `test result: FAILED.`, Vitest `Tests  <n> failed`,
 * Jest `Tests: <n> failed`, pytest `=== <n> failed ... ===`, Playwright `<n> failed` alone on its line), and compile
 * errors (rustc `error[E<n>]:`, tsc `<file>(<line>,<col>): error TS<n>:`).
 */
const FAILURE_LINES = [
    /^\s*FAIL\s+[[\w./]/,
    /^\s*[×✕✗]\s/,
    /^test \S+ \.\.\. FAILED\s*$/,
    /^FAILED \S+::/,
    /^\(fail\) /,
    /^test result: FAILED\b/,
    /^\s*Tests:?\s+[1-9]\d* failed\b/,
    /^=+ .*\b[1-9]\d* failed\b.* =+\s*$/,
    /^\s*[1-9]\d* failed\s*$/,
    /^error\[E\d+\]:/,
    /^\S+\(\d+,\d+\): error TS\d+:/,
];

/**
 * Whether a log line is a failure some runner reports (FAILURE_LINES). Anything less certain is not: a retried attempt
 * (`(retry`, nextest `TRY <n> FAIL` and `FLAKY`), an expected failure (pytest `XFAIL`/`xfailed`), a `should panic`
 * test, `FAIL` inside a word (`FAIL-FAST`, `FAILED_PRECONDITION`), `(fail)` mid-line or a count in free text (`1 failed
 * attempt`). Without a confident match the failure rule never fires; only the time rule applies.
 */
export function failureLine(line: string): boolean {
    const text = line.replace(ANSI_STYLE, "");
    return !text.includes("(retry") && FAILURE_LINES.some((shape) => shape.test(text));
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
    const quietMs = RUNAWAY_QUIET_MINUTES * minuteMs;
    const waitingForSlot = slotWaitProbe(env);
    let slotWaitMs = 0;
    let lastPoll = spawnedAtMs;
    let lastOutputMs = spawnedAtMs;
    const runaway = (reason: string): void => {
        if (stopped !== null) return;
        logDecision(record, "runaway", `${record.recipe} at ${short(record.sha)}: ${reason}`);
        stop("runaway", reason);
    };
    const overrun = (at: number): void => {
        const ranMs = at - spawnedAtMs - slotWaitMs;
        if (estimateMs === undefined || ranMs <= Math.max(RUNAWAY_FACTOR * estimateMs, minuteMs)) return;
        if (at - lastOutputMs < quietMs) return;
        const queued =
            slotWaitMs === 0
                ? ""
                : ` (not counting ${minutesText(slotWaitMs, minuteMs)} waiting for a heavy-build slot)`;
        runaway(
            `ran ${minutesText(ranMs, minuteMs)}${queued}, over ${RUNAWAY_FACTOR} times its estimate of ` +
                `${minutesText(estimateMs, minuteMs)} (the median of its recent passes), with no new output for ` +
                `${RUNAWAY_QUIET_MINUTES} minutes; stopped it`,
        );
    };
    const output = setInterval(() => {
        const at = Date.now();
        // Time spent waiting in line for a heavy-build slot is the machine's queue, not the recipe running away.
        if (waitingForSlot()) slotWaitMs += at - lastPoll;
        lastPoll = at;
        const current = statSync(record.log).size;
        if (current === size) {
            overrun(at);
            return;
        }
        const text = readFrom(record.log, size, current);
        size = current;
        lastOutputMs = at;
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
        return { end, stopped, survivors, elapsedMs: Date.now() - spawnedAtMs - slotWaitMs, slotWaitMs };
    } finally {
        clearInterval(output);
        stopWatch();
        for (const [signal, handler] of handlers) process.off(signal, handler);
    }
}

/**
 * Whether the recipe's heavy step is waiting in line for a heavy-build slot now: for a check that takes its slot at
 * its first heavy step (src/fleet/heavy-step-slot.ts), the run serving its slot (TOLI_DEFERRED_SLOT in `env`) has a
 * slot request and holds no slot yet. A recipe without one held its slot before it started: never waiting.
 */
function slotWaitProbe(env: NodeJS.ProcessEnv): () => boolean {
    const run = Number(env[DEFERRED_SLOT_ENV] ?? "");
    if (!Number.isInteger(run) || run <= 0) return () => false;
    return () => existsSync(slotRequestFile(run)) && !busySlots().some((slot) => slot.pid === run);
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
