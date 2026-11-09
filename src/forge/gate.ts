// Gates: a project's long verification command (e.g. `just verify all`) run at most once per commit. A record per
// HEAD sha and recipe lives in state/gates/<project>/; a passed one is never run again, a running one is attached to,
// never started twice. The gate itself runs under a detached runner (`bin/toli gate runner <record>`) that outlives
// its caller (a jawan ending, a hook timing out, ssh dropping) and has no time limit: it only stops a gate that made no
// progress for the stall minutes (config/machine.json capacity.gateStallMinutes): its log did not grow, its checkout
// did not change and its process tree burned almost no CPU (the jawan stall check, src/jawans/progress.ts). A build
// that links silently for a long time keeps its gate alive through its CPU use.
import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Args } from "../core/args.ts";
import { type Machine, machineSettings } from "../core/config.ts";
import { checkoutDirty, git, headSha } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { now, out, pidAlive, printJson, ToliError, warn, withLock, writeJsonAtomic } from "../core/util.ts";
import { watchStall } from "../jawans/progress.ts";
import { killGroup, runMinuteMs } from "../jawans/runs.ts";
import { toliSelfCheckout } from "../projects/projects.ts";
import { workDir } from "../projects/workspace.ts";
import {
    type GateRecord,
    type GateStatus,
    logDecision,
    outcomeText,
    readRecord,
    reconcile,
    recordFile,
    short,
    updateRecord,
} from "./gate-record.ts";

/** This checkout's CLI (not paths.toliBin(): TOLI_ROOT may point the data elsewhere, as in tests). */
const TOLI_SCRIPT = resolve(import.meta.dir, "..", "..", "bin", "toli");
const TASK_FLAG = "task";
const DEFAULT_STALL_MINUTES = 30;
/** After SIGTERM, how long a stopped gate's process group gets before SIGKILL. */
const STOP_GRACE_MS = 10_000;
/** How often an attached caller re-reads the record and the log. */
const FOLLOW_POLL_MS = 250;

/** `capacity.gateStallMinutes`: minutes without gate progress (output, file change or CPU use) before it is stopped. */
function gateStallMinutes(machine: Partial<Machine>): number {
    const raw = machine.capacity?.gateStallMinutes;
    if (raw === undefined) return DEFAULT_STALL_MINUTES;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)
        throw new ToliError("config/machine.json capacity.gateStallMinutes must be a positive number");
    return raw;
}

/** `--stall <minutes>`; undefined when absent (the gate then uses capacity.gateStallMinutes). */
function parseStall(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes <= 0) throw new ToliError("--stall must be a positive number of minutes");
    return minutes;
}

function requireRecipe(args: Args): string {
    const recipe = args.str("recipe");
    if (recipe === undefined || recipe.trim() === "") throw new ToliError('missing --recipe "<shell command>"');
    return recipe;
}

/** Copy the log's complete new lines (all of it once the gate ended) to stdout; returns the new offset. */
function printLog(log: string, offset: number, final: boolean): number {
    if (!existsSync(log)) return offset;
    const size = statSync(log).size;
    if (size <= offset) return offset;
    const buffer = Buffer.alloc(size - offset);
    const fd = openSync(log, "r");
    try {
        readSync(fd, buffer, 0, buffer.length, offset);
    } finally {
        closeSync(fd);
    }
    const end = final ? buffer.length : buffer.lastIndexOf(0x0a) + 1;
    if (end > 0) out(buffer.subarray(0, end).toString("utf8"));
    return offset + end;
}

/** Wait for a running gate to end, following its log (`stream`), and return its final record. */
async function follow(file: string, stream: boolean): Promise<GateRecord> {
    let offset = 0;
    for (;;) {
        const record = reconcile(file);
        if (record === null) throw new ToliError(`gate record ${file} is gone`);
        const ended = record.status !== "running";
        if (stream) offset = printLog(record.log, offset, ended);
        if (ended) return record;
        await Bun.sleep(FOLLOW_POLL_MS);
    }
}

/** Start the detached runner of a fresh `running` record and record its pid. */
function startRunner(file: string, record: GateRecord): GateRecord {
    mkdirSync(paths.gatesDir(record.project), { recursive: true });
    writeJsonAtomic(file, record);
    const logFd = openSync(record.log, "w");
    let pid: number | undefined;
    try {
        const runner = spawnChild(process.execPath, [TOLI_SCRIPT, "gate", "runner", file], {
            cwd: paths.root(),
            detached: true,
            stdio: ["ignore", logFd, logFd],
        });
        runner.unref();
        pid = runner.pid;
    } finally {
        closeSync(logFd);
    }
    if (pid === undefined) {
        record.status = "failed";
        record.endedAt = now().toISOString();
        record.reason = "could not start its runner";
        writeJsonAtomic(file, record);
        return record;
    }
    record.pid = pid;
    writeJsonAtomic(file, record);
    return record;
}

/** `stallMinutes` left out: config/machine.json capacity.gateStallMinutes (default 30). */
export type GateRun = {
    project: string;
    dir: string;
    recipe: string;
    stallMinutes?: number | undefined;
    json: boolean;
};

/**
 * How the checkout differs from its HEAD commit, or null when it is exactly HEAD (changed tracked files and untracked,
 * not ignored ones: either can change what a gate sees). Whether it differs comes from git exit statuses
 * (checkoutDirty); the `git status --porcelain` lines only name the changes, and may be empty if git's output was lost.
 */
function checkoutChanges(dir: string): string[] | null {
    if (!checkoutDirty(dir)) return null;
    const status = git(dir, ["status", "--porcelain"]);
    if (status.code !== 0) throw new ToliError(`git status failed in ${dir}: ${status.stderr.trim()}`);
    return status.stdout.split("\n").filter((line) => line.trim() !== "");
}

/** At most five changed paths, then how many more. */
function changesText(changes: string[]): string {
    if (changes.length === 0) return "changes git status did not list";
    const shown = changes.slice(0, 5).map((line) => line.slice(3));
    return changes.length > shown.length
        ? `${shown.join(", ")} and ${changes.length - shown.length} more`
        : shown.join(", ");
}

/**
 * Run a gate at the checkout's HEAD, cached: skip it when it already passed there, attach when it is running, else
 * start it under a detached runner and attach. Resolves to the gate's final record.
 */
export async function runGate(input: GateRun): Promise<GateRecord> {
    const say = input.json ? warn : out;
    const changes = checkoutChanges(input.dir);
    if (changes !== null)
        throw new ToliError(
            `refusing to run the gate: ${input.dir} differs from its HEAD commit (${changesText(changes)}), so the ` +
                "result would not belong to any commit and could not be reused; commit them (or set them aside) first",
        );
    const sha = headSha(input.dir);
    const file = recordFile(input.project, sha, input.recipe);
    const decided = withLock(`${file}.lock`, (): { record: GateRecord; action: "skip" | "attach" | "start" } => {
        const existing = readRecord(file);
        if (existing?.status === "passed") return { record: existing, action: "skip" };
        if (existing?.status === "running" && existing.pid !== null && pidAlive(existing.pid))
            return { record: existing, action: "attach" };
        const record = startRunner(file, {
            project: input.project,
            sha,
            recipe: input.recipe,
            dir: input.dir,
            status: "running",
            pid: null,
            startedAt: now().toISOString(),
            endedAt: null,
            lastOutputAt: null,
            exitCode: null,
            log: file.replace(/\.json$/, ".log"),
            stallMinutes: input.stallMinutes ?? gateStallMinutes(machineSettings()),
        });
        const gone =
            existing?.status === "running" ? `the last runner (pid ${existing.pid ?? "unknown"}) is gone; ` : "";
        if (record.status !== "running") return { record, action: "start" };
        const message =
            `${gone}starting ${input.recipe} at ${short(sha)} in ${input.dir} under runner pid ${record.pid}, ` +
            `stopped only after ${record.stallMinutes} minutes without output, log ${record.log}`;
        logDecision(record, "start", message);
        say(`gate: ${message}`);
        return { record, action: "start" };
    });
    const { record, action } = decided;
    if (action === "skip") {
        const message = `${record.recipe} already passed at ${short(sha)} (${record.endedAt}), log ${record.log}; skipping the re-run`;
        logDecision(record, "skip", message);
        say(`gate: ${message}`);
        return record;
    }
    if (action === "attach") {
        const message =
            `attaching to ${record.recipe} at ${short(sha)}, running under runner pid ${record.pid} since ` +
            `${record.startedAt}; not starting a second copy, log ${record.log}`;
        logDecision(record, "attach", message);
        say(`gate: ${message}`);
    }
    if (record.status !== "running") return record;
    const final = await follow(file, !input.json);
    if (final.status === "passed") say(`gate: ${outcomeText(final)}`);
    return final;
}

/** The detached runner: run the recipe in its own process group, stop it only when it stops making progress. */
async function runGateProcess(file: string): Promise<void> {
    const record = readRecord(file);
    if (record === null) throw new ToliError(`gate record ${file} is gone`);
    // A closed terminal or dropped ssh session never stops a gate; only silence (or SIGTERM/SIGINT) does.
    process.on("SIGHUP", () => {});
    const minuteMs = runMinuteMs();
    const pollMs = Math.max(50, Math.min(1000, (record.stallMinutes * minuteMs) / 10));
    const logFd = openSync(record.log, "a");
    let child: ChildProcess;
    try {
        child = spawnChild("sh", ["-c", record.recipe], {
            cwd: record.dir,
            detached: true,
            stdio: ["ignore", logFd, logFd],
        });
    } finally {
        closeSync(logFd);
    }
    const { promise: exited, resolve: done } = Promise.withResolvers<{
        code: number | null;
        signal: NodeJS.Signals | null;
        error?: string;
    }>();
    child.on("exit", (code, signal) => done({ code, signal }));
    child.on("error", (error) => done({ code: 127, signal: null, error: error.message }));
    let stopped: { status: GateStatus; reason: string } | null = null;
    let forceTimer: NodeJS.Timeout | undefined;
    const stop = (status: GateStatus, reason: string): void => {
        if (stopped !== null || child.pid === undefined) return;
        stopped = { status, reason };
        const group = child.pid;
        killGroup(group, "SIGTERM");
        forceTimer = setTimeout(() => killGroup(group, "SIGKILL"), STOP_GRACE_MS);
    };
    for (const signal of ["SIGTERM", "SIGINT"] as const)
        process.on(signal, () => stop("killed", `its runner got ${signal}`));
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
    const result = await exited;
    clearInterval(output);
    stopWatch();
    clearTimeout(forceTimer);
    const final = updateRecord(file, (entry) => {
        entry.endedAt = now().toISOString();
        entry.exitCode = result.code;
        if (stopped !== null) {
            entry.status = stopped.status;
            entry.reason = stopped.reason;
        } else if (result.error !== undefined) {
            entry.status = "failed";
            entry.reason = `could not run it: ${result.error}`;
        } else if (result.signal !== null) {
            entry.status = "killed";
            entry.reason = `it was killed by ${result.signal}`;
        } else if (result.code !== 0) {
            entry.status = "failed";
        } else {
            // A pass counts only if the checkout still was exactly the commit when the gate ended.
            const head = headSha(entry.dir);
            const changes = checkoutChanges(entry.dir);
            if (head !== entry.sha) {
                entry.status = "failed";
                entry.reason = `HEAD moved to ${short(head)} while it ran, so the pass may not hold for ${short(entry.sha)}`;
            } else if (changes !== null) {
                entry.status = "failed";
                entry.reason = `the checkout changed while it ran (${changesText(changes)}), so the pass may not hold for ${short(entry.sha)}`;
            } else {
                entry.status = "passed";
            }
        }
    });
    logDecision(final, final.status, outcomeText(final));
}

async function gateRun(argv: string[]): Promise<number> {
    const args = new Args(argv, { booleans: ["json"], values: [TASK_FLAG, "recipe", "stall"] });
    args.maxPositional(1);
    const project = args.pos(0, "project");
    const recipe = requireRecipe(args);
    const stallMinutes = parseStall(args.str("stall"));
    const dir = toliSelfCheckout(project) ?? workDir(project, args.str(TASK_FLAG)).dir;
    const json = args.bool("json");
    const record = await runGate({ project, dir, recipe, stallMinutes, json });
    if (json) printJson(record);
    if (record.status === "passed") return 0;
    warn(`toli: gate ${outcomeText(record)}`);
    return 1;
}

function gateCheck(argv: string[]): number {
    const args = new Args(argv, { booleans: ["json"], values: [TASK_FLAG, "recipe", "sha"] });
    args.maxPositional(1);
    const project = args.pos(0, "project");
    const recipe = requireRecipe(args);
    const dir = toliSelfCheckout(project) ?? workDir(project, args.str(TASK_FLAG)).dir;
    const sha = headSha(dir, args.str("sha") ?? "HEAD");
    const record = reconcile(recordFile(project, sha, recipe));
    if (record?.status !== "passed") {
        const last = record === null ? "" : `; its last run is ${record.status}, log ${record.log}`;
        warn(`gate: ${recipe} has not passed at ${short(sha)}${last}`);
        return 1;
    }
    if (args.bool("json")) printJson(record);
    else out(`gate: ${recipe} passed at ${short(sha)} (${record.endedAt}), log ${record.log}`);
    return 0;
}

function gateStatus(argv: string[]): number {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(1);
    const project = args.pos(0, "project");
    const dir = paths.gatesDir(project);
    const records = existsSync(dir)
        ? readdirSync(dir)
              .filter((name) => name.endsWith(".json"))
              .map((name) => reconcile(join(dir, name)))
              .filter((record): record is GateRecord => record !== null)
              .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        : [];
    if (args.bool("json")) {
        printJson(records);
        return 0;
    }
    if (records.length === 0) {
        out(`no gates recorded for ${project}`);
        return 0;
    }
    for (const record of records)
        out(
            [record.status, short(record.sha), record.startedAt, record.endedAt ?? "-", record.recipe, record.log].join(
                "\t",
            ),
        );
    return 0;
}

/** `bin/toli gate run|check|status`; `gate runner <record>` is the detached runner `gate run` starts. */
export async function gateCommand(argv: string[]): Promise<number> {
    const [sub, ...rest] = argv;
    switch (sub) {
        case "run":
            return await gateRun(rest);
        case "check":
            return gateCheck(rest);
        case "status":
            return gateStatus(rest);
        case "runner": {
            const args = new Args(rest);
            args.maxPositional(1);
            await runGateProcess(args.pos(0, "record"));
            return 0;
        }
        default:
            throw new ToliError("usage: bin/toli gate run|check|status <project> ...");
    }
}
