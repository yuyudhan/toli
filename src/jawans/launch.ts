// Starting spawned jawan runs within the machine's jawan slots (config/machine.json capacity.maxRuns), which native
// subagent jawans share. A new run is recorded, then started at once when a slot is free (or with `spawn --now`),
// otherwise left `queued`; queued runs start oldest first as slots free, from the supervisor of each finishing run and
// from the minute tick. Before any start, the disk keeper frees build output when the disk is low (src/fleet/disk.ts):
// low disk never holds a run.
import { spawn as spawnChild } from "node:child_process";
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { cpus } from "node:os";
import { join, resolve } from "node:path";
import { loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, ToliError, withLock, writeJsonAtomic } from "../core/util.ts";
import { keepDiskBeforeWork } from "../fleet/disk.ts";
import { refuseHeadlessDispatch } from "../fleet/dispatch.ts";
import { LEAD_TURN_ENV } from "../fleet/full.ts";
import { subagentJawans } from "../fleet/queue.ts";
import { capacityFor, stallMinutes } from "../fleet/resources.ts";
import { type Harness, headlessCommand, type WorkType } from "../harness/harness.ts";
import type { ModelSource, Tier } from "../harness/models.ts";
import { loadBacklog, updateTask } from "../records/backlog.ts";
import { deadlineSection } from "./limits.ts";
import { type JawanRun, listRuns, loadRun, RUNNING, runMinuteMs, updateRun } from "./runs.ts";
import { inSupervisorScope } from "./scope.ts";

/** This checkout's CLI (not paths.toliBin(): TOLI_ROOT may point the data elsewhere, as in tests). */
const TOLI_SCRIPT = resolve(import.meta.dir, "..", "..", "bin", "toli");
/** The brief as given (with its Workspace block), before generated sections; continuations start from it. */
const BASE_BRIEF = "brief.base.md";

export type NewRun = {
    harness: Harness;
    task: string | null;
    project: string | null;
    work: WorkType | null;
    model: string | null;
    tier: Tier | null;
    modelSource: ModelSource;
    cwd: string;
    /** Wall-clock limit, only when asked for (`--max-time`); null runs until done or stalled. */
    maxMinutes: number | null;
    /** The brief before generated sections. */
    baseBrief: string;
    /** Sections to add after it (a fresh continuation's RESUME); a Deadline section is added at launch with a limit. */
    extra: string;
    resumeOf?: string | undefined;
    resumeCount?: number | undefined;
    resumeReason?: string | undefined;
    /** omp: the chain's session dir (a new chain gets `<runDir>/session`) and the session file this run resumes. */
    sessionDir?: string | undefined;
    resumeSession?: string | undefined;
    /** What the harness is sent instead of the brief (the prompt that resumes a session). */
    prompt?: string | undefined;
    /** The live runs of the same task this one supersedes (`spawn --replace`). */
    replaces?: string[] | undefined;
};

function newRunId(at: Date): string {
    const compact = at.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    return `j-${compact}-${crypto.randomUUID().slice(0, 4)}`;
}

/** The machine's jawan slots: capacity.maxRuns. */
export function jawanSlots(): number {
    return capacityFor(loadMachine(), Math.max(1, cpus().length)).maxRuns;
}

/** Serializes slot checks with starts, so concurrent spawns and drains never overfill the machine. */
const SLOTS_LOCK = "jawan-slots";

/**
 * Jawan slots in use, the count both startOrQueue and startQueued check against jawanSlots: running spawn runs plus
 * the native subagent jawans working on this machine's tasks (src/fleet/queue.ts subagentJawans), so a lead's
 * subagents and its spawned runs share the one cap.
 */
function busySlots(): number {
    const runs = listRuns();
    return runs.filter((run) => RUNNING.includes(run.status)).length + subagentJawans(loadBacklog().tasks, runs);
}

/** The base brief of an earlier run; runs from before base briefs were kept fall back to the brief they ran. */
export function baseBriefOf(run: JawanRun): string {
    try {
        return readFileSync(join(run.runDir, BASE_BRIEF), "utf8");
    } catch {
        return readFileSync(run.briefPath, "utf8");
    }
}

/** The newest omp session file in `dir`, or null when the run left none (it never started, or another harness). */
export function sessionFile(dir: string | undefined): string | null {
    if (dir === undefined || !existsSync(dir)) return null;
    const files = readdirSync(dir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => join(dir, name))
        .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.path ?? null;
}

/** A run started by its own caller rather than a supervisor: the process recording it and the argv it runs. */
export type AttachedStart = { argv: string[]; ownerPid: number };

/**
 * Write the run dir, its briefs and its record: status `queued`, nothing started; or, with `attached`, status
 * `running` under the calling process (`bin/toli exec`), which records the outcome itself (src/fleet/remote.ts).
 */
export function recordRun(input: NewRun, attached?: AttachedStart): JawanRun {
    const createdAt = now();
    const id = newRunId(createdAt);
    const runDir = input.project === null ? join(paths.jawansDir(), id) : join(paths.projectRunsDir(input.project), id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, BASE_BRIEF), input.baseBrief);
    const brief = input.prompt ?? `${input.baseBrief.trimEnd()}\n${input.extra}`;
    const briefPath = join(runDir, "brief.md");
    writeFileSync(briefPath, brief);
    const sessionDir = input.harness === "omp" ? (input.sessionDir ?? join(runDir, "session")) : undefined;
    if (sessionDir !== undefined) mkdirSync(sessionDir, { recursive: true });
    const command =
        attached === undefined
            ? headlessCommand(input.harness, {
                  brief,
                  cwd: input.cwd,
                  root: paths.root(),
                  model: input.model ?? undefined,
                  maxMinutes: input.maxMinutes,
                  ...(sessionDir === undefined ? {} : { session: { dir: sessionDir, resume: input.resumeSession } }),
              })
            : { argv: attached.argv, stdin: null };
    const run: JawanRun = {
        id,
        harness: input.harness,
        task: input.task,
        project: input.project,
        work: input.work,
        model: input.model,
        tier: input.tier,
        modelSource: input.modelSource,
        cwd: input.cwd,
        runDir,
        briefPath,
        logPath: join(runDir, "output.log"),
        command: [
            ...command.argv.map((word) => (word === brief ? "<brief>" : word)),
            ...(command.stdin === null ? [] : ["< brief"]),
        ].join(" "),
        maxMinutes: input.maxMinutes,
        stallMinutes: stallMinutes(loadMachine()),
        ...(sessionDir === undefined ? {} : { sessionDir }),
        ...(input.resumeSession === undefined ? {} : { resumeSession: input.resumeSession }),
        status: attached === undefined ? "queued" : "running",
        supervisorPid: attached?.ownerPid ?? null,
        pid: null,
        exitCode: null,
        signal: null,
        startedAt: createdAt.toISOString(),
        endedAt: null,
        inbox: null,
        error: null,
        ...(input.resumeOf === undefined ? {} : { resumeOf: input.resumeOf }),
        ...(input.resumeCount === undefined ? {} : { resumeCount: input.resumeCount }),
        ...(input.resumeReason === undefined ? {} : { resumeReason: input.resumeReason }),
        ...(input.replaces === undefined ? {} : { replaces: input.replaces }),
    };
    mkdirSync(paths.jawansDir(), { recursive: true });
    writeJsonAtomic(paths.jawanRecord(id), run);
    return run;
}

/**
 * Start a queued run's detached supervisor: the brief gains its Deadline section and the record moves to `starting`.
 * A run no longer queued (killed meanwhile) is returned unchanged.
 */
function launch(id: string): JawanRun {
    const startedAt = now();
    let claimed = false;
    const run = updateRun(id, (record) => {
        if (record.status !== "queued") return;
        claimed = true;
        record.status = "starting";
        record.startedAt = startedAt.toISOString();
    });
    if (!claimed) return run;
    try {
        if (run.maxMinutes !== null) {
            const brief = readFileSync(run.briefPath, "utf8");
            writeFileSync(
                run.briefPath,
                `${brief.trimEnd()}\n${deadlineSection(startedAt, run.maxMinutes, runMinuteMs())}`,
            );
        }
        const supervisorLog = openSync(join(run.runDir, "supervisor.log"), "a");
        let pid: number | undefined;
        try {
            // On Linux the supervisor gets its own systemd scope, outside the lead service's cgroup and apart from
            // its harness's scope, so an OOM kill takes one jawan and its supervisor records it (src/jawans/scope.ts).
            const scoped = inSupervisorScope(id, [process.execPath, TOLI_SCRIPT, "run", "supervise", id]);
            const [command, ...args] = scoped.argv;
            // The supervisor is not the headless lead turn that may have started it: its queued starts and resumes
            // must never inherit that turn's refusals.
            const { [LEAD_TURN_ENV]: _turn, ...env } = process.env;
            const supervisor = spawnChild(command, args, {
                cwd: paths.root(),
                detached: true,
                stdio: ["ignore", supervisorLog, supervisorLog],
                env: { ...env, ...scoped.env },
            });
            supervisor.unref();
            pid = supervisor.pid;
        } finally {
            closeSync(supervisorLog);
        }
        if (pid === undefined) throw new ToliError(`could not start the supervisor for ${id}`);
        const supervisorPid = pid;
        return updateRun(id, (record) => {
            record.supervisorPid = supervisorPid;
        });
    } catch (error) {
        updateRun(id, (record) => {
            record.status = "failed";
            record.endedAt = now().toISOString();
            record.error = `could not start: ${error instanceof Error ? error.message : String(error)}`;
        });
        throw error;
    }
}

/**
 * Record a new run, name it as its task's agent, and start it if a jawan slot is free (always with `now`); otherwise
 * it stays `queued`.
 */
export function startOrQueue(input: NewRun, options: { now: boolean }): JawanRun {
    keepDiskBeforeWork();
    return withLock(paths.lock(SLOTS_LOCK), () => {
        const run = recordRun(input);
        const task = run.task;
        // The task names its jawan, so the digest can flag active tasks nobody is working on (queued runs count).
        if (task !== null && loadBacklog().tasks.some((entry) => entry.id === task))
            updateTask(task, (entry) => {
                if (entry.status === "queued" || entry.status === "active") {
                    entry.status = "active";
                    entry.startedAt ??= run.startedAt;
                    entry.agent = run.id;
                    entry.dispatchedAt = run.startedAt;
                    delete entry.waitingOn;
                }
            });
        if (options.now || busySlots() < jawanSlots()) return launch(run.id);
        return updateRun(run.id, (record) => {
            record.queuedAt = record.startedAt;
        });
    });
}

export type DrainResult = { started: JawanRun[]; failed: { run: JawanRun; error: string }[] };

/**
 * Start queued runs, oldest first, while jawan slots are free. A run that cannot start is recorded failed.
 * `diskKept`: the caller has seen to the disk already (the minute tick starts the keeper detached). A headless lead
 * turn under `lead.dispatch: "subagents"` is refused and starts none.
 */
export function startQueued(options: { diskKept?: boolean } = {}): DrainResult {
    refuseHeadlessDispatch("start queued runs");
    if (options.diskKept !== true) keepDiskBeforeWork();
    return withLock(paths.lock(SLOTS_LOCK), () => {
        const result: DrainResult = { started: [], failed: [] };
        const queued = listRuns()
            .filter((run) => run.status === "queued")
            .sort(
                (a, b) =>
                    (a.queuedAt ?? a.startedAt).localeCompare(b.queuedAt ?? b.startedAt) || a.id.localeCompare(b.id),
            );
        let free = jawanSlots() - busySlots();
        for (const run of queued) {
            if (free <= 0) break;
            try {
                const started = launch(run.id);
                if (!RUNNING.includes(started.status)) continue;
                result.started.push(started);
                free -= 1;
            } catch (error) {
                result.failed.push({
                    run: loadRun(run.id),
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return result;
    });
}
