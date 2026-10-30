// Records of jawans started with `bin/toli spawn`: one JSON file per run in state/jawans/<runId>.json.
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { Harness, WorkType } from "./harness.ts";
import { paths } from "./paths.ts";
import { now, pidAlive, readJson, ToliError, withLock, writeJsonAtomic } from "./util.ts";

export type RunStatus = "starting" | "running" | "done" | "failed" | "killed";

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
};

export const ACTIVE: readonly RunStatus[] = ["starting", "running"];

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

/** Stop a running jawan; its supervisor still records the outcome (status killed) and posts it. */
export function killRun(id: string): JawanRun {
    const before = loadRun(id);
    if (!ACTIVE.includes(before.status) && before.status !== "killed")
        throw new ToliError(`${id} is not running (status ${before.status})`);
    // A second kill of a run that ignored SIGTERM escalates.
    const signal: NodeJS.Signals = before.status === "killed" ? "SIGKILL" : "SIGTERM";
    const run = updateRun(id, (record) => {
        record.status = "killed";
    });
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
