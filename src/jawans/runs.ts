// Records of jawans started with `bin/toli spawn`: one JSON file per run in state/jawans/<runId>.json.
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { paths } from "../core/paths.ts";
import { now, pidAlive, readJson, ToliError, withLock, writeJsonAtomic } from "../core/util.ts";
import type { Harness, WorkType } from "../harness/harness.ts";

/**
 * `queued`: waiting for a free jawan slot (config/machine.json capacity.maxRuns). `time-limit`: stopped by its time
 * limit without a report (src/jawans/limits.ts), which starts an automatic continuation.
 */
export type RunStatus = "queued" | "starting" | "running" | "done" | "failed" | "killed" | "time-limit";

export type JawanRun = {
    id: string;
    harness: Harness;
    task: string | null;
    project: string | null;
    work: WorkType | null;
    model: string | null;
    cwd: string;
    runDir: string;
    briefPath: string;
    logPath: string;
    /** The harness command with the brief elided, for humans. */
    command: string;
    maxMinutes: number;
    status: RunStatus;
    supervisorPid: number | null;
    pid: number | null;
    exitCode: number | null;
    signal: string | null;
    startedAt: string;
    endedAt: string | null;
    /** Inbox item holding the outcome, once posted. */
    inbox: string | null;
    error: string | null;
    /** When the run was queued for a free slot; absent when it started at once. */
    queuedAt?: string;
    /** Auto-resume chain: the run this one continues, and its place in the chain (1 for the first continuation). */
    resumeOf?: string;
    resumeCount?: number;
    /** The continuation started (or queued) because this run hit its time limit without a report. */
    resumedBy?: string;
};

/** Waiting or in progress; queued runs have no supervisor yet. */
export const ACTIVE: readonly RunStatus[] = ["queued", "starting", "running"];
/** Holding one of the machine's jawan slots. */
export const RUNNING: readonly RunStatus[] = ["starting", "running"];

/** Milliseconds per minute of a run's time limit; `TOLI_RUN_MINUTE_MS` shortens it for tests. */
export function runMinuteMs(): number {
    const override = Number(process.env.TOLI_RUN_MINUTE_MS);
    return Number.isInteger(override) && override > 0 ? override : 60_000;
}

export function loadRun(id: string): JawanRun {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new ToliError(`invalid run id "${id}"`);
    const path = paths.jawanRecord(id);
    if (!existsSync(path)) throw new ToliError(`unknown run "${id}" (see \`bin/toli runs\`)`);
    return readJson<JawanRun>(path, {} as JawanRun);
}

/** Read-modify-write one run record under its lock (the supervisor and `run kill` race on status). */
export function updateRun(id: string, change: (run: JawanRun) => void): JawanRun {
    return withLock(paths.lock(`jawan-${id}`), () => {
        const run = loadRun(id);
        change(run);
        writeJsonAtomic(paths.jawanRecord(id), run);
        return run;
    });
}

/** Every spawned run, newest first. Active runs whose supervisor died are recorded as failed. */
export function listRuns(): JawanRun[] {
    const dir = paths.jawansDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((file) => file.endsWith(".json"))
        .map((file) => readJson<JawanRun>(join(dir, file), {} as JawanRun))
        .filter((run) => typeof run.id === "string")
        .map((run) =>
            ACTIVE.includes(run.status) && run.supervisorPid !== null && !pidAlive(run.supervisorPid)
                ? updateRun(run.id, (stale) => {
                      if (!ACTIVE.includes(stale.status)) return;
                      stale.status = "failed";
                      stale.endedAt = now().toISOString();
                      stale.error = "the supervisor exited without recording an outcome";
                  })
                : run,
        )
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
}

export function activeRuns(): JawanRun[] {
    return listRuns().filter((run) => ACTIVE.includes(run.status));
}

/** Signal the run's whole process group (spawned detached), falling back to the single pid. */
export function killGroup(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            // Already gone.
        }
    }
}

/**
 * Stop a jawan. A running one is signalled and its supervisor still records the outcome (status killed) and posts it;
 * a queued one is only marked killed, so it never starts.
 */
export function killRun(id: string): JawanRun {
    const before = loadRun(id);
    if (!ACTIVE.includes(before.status) && before.status !== "killed")
        throw new ToliError(`${id} is not running (status ${before.status})`);
    // A second kill of a run that ignored SIGTERM escalates.
    const signal: NodeJS.Signals = before.status === "killed" ? "SIGKILL" : "SIGTERM";
    let wasQueued = false;
    const run = updateRun(id, (record) => {
        if (record.status === "queued") {
            wasQueued = true;
            record.endedAt = now().toISOString();
            record.error = "killed while queued; it never started";
        }
        record.status = "killed";
    });
    if (wasQueued) return run;
    if (run.pid !== null) killGroup(run.pid, signal);
    else if (run.supervisorPid !== null) killGroup(run.supervisorPid, signal);
    return run;
}

/** `<id> <status> <harness> <task project> <age> <log>`, tab-separated. */
export function runLine(run: JawanRun): string {
    const where = [run.task, run.project].filter((part) => part !== null).join(" ");
    const minutes = Math.max(0, Math.round((now().getTime() - Date.parse(run.startedAt)) / 60_000));
    const age = minutes < 120 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
    return `${run.id}\t${run.status}\t${run.harness}\t${where === "" ? "-" : where}\t${age}\t${relative(paths.root(), run.logPath)}`;
}
