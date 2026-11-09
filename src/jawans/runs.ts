// Records of jawans started with `bin/toli spawn`: one JSON file per run in state/jawans/<runId>.json.
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { paths } from "../core/paths.ts";
import { now, pidAlive, readJson, ToliError, withLock, writeJsonAtomic } from "../core/util.ts";
import type { Harness, WorkType } from "../harness/harness.ts";
import { type FallbackRecord, type ModelSource, type Tier, type Usage, usageText } from "../harness/models.ts";

/**
 * `queued`: waiting for a free jawan slot (config/machine.json capacity.maxRuns). `time-limit`: stopped by its explicit
 * `--max-time` without a report (src/jawans/limits.ts). `stalled`: stopped after no progress for capacity.stallMinutes
 * (src/jawans/progress.ts). Both are resumed in the same session (src/jawans/supervise.ts).
 */
export type RunStatus = "queued" | "starting" | "running" | "done" | "failed" | "killed" | "time-limit" | "stalled";

export type JawanRun = {
    id: string;
    harness: Harness;
    task: string | null;
    project: string | null;
    work: WorkType | null;
    /** The model passed to the harness; null runs its own default. A limit fallback updates it to the model retried on. */
    model: string | null;
    /** The model tier (src/harness/models.ts) and what chose the model; absent on runs from before tiers. */
    tier?: Tier | null;
    modelSource?: ModelSource;
    /** The retry after a rate or usage limit: from which model to which, and why. */
    fallback?: FallbackRecord;
    /** Tokens and cost the harness printed, when it prints them. */
    usage?: Usage;
    cwd: string;
    runDir: string;
    briefPath: string;
    logPath: string;
    /** The harness command with the brief elided, for humans. */
    command: string;
    /** Wall-clock limit in minutes, only when asked for (`--max-time`); null runs until done or stalled. */
    maxMinutes: number | null;
    /** Minutes without progress after which the run is stopped as stalled (capacity.stallMinutes at its start). */
    stallMinutes?: number;
    /** omp: the session dir every run of the chain shares (`--session-dir`), and the session file this run resumed. */
    sessionDir?: string;
    resumeSession?: string;
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
    /** Resume chain: the run this one continues, and its place in the chain (1 for the first continuation). */
    resumeOf?: string;
    resumeCount?: number;
    /** Why this run continues the previous one: `stalled`, `time-limit`, `rate/usage limit`, `lead` (`toli resume`). */
    resumeReason?: string;
    /** The continuation started (or queued) because this run stopped without a report, or the lead resumed it. */
    resumedBy?: string;
    /** `spawn --replace`: the live runs of the same task this one superseded, and the run that superseded this one. */
    replaces?: string[];
    replacedBy?: string;
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

/** The harness with its model and tier: `omp claude-sonnet-5-5 (standard)`, `omp default` without a model. */
export function modelText(run: Pick<JawanRun, "harness" | "model" | "tier">): string {
    const tier = run.tier === undefined || run.tier === null ? "" : ` (${run.tier})`;
    return `${run.harness} ${run.model ?? "default"}${tier}`;
}

/** `<id> <status> <harness model (tier)> <task project> <age> <log>`, tab-separated. */
export function runLine(run: JawanRun): string {
    const where = [run.task, run.project].filter((part) => part !== null).join(" ");
    const minutes = Math.max(0, Math.round((now().getTime() - Date.parse(run.startedAt)) / 60_000));
    const age = minutes < 120 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
    return `${run.id}\t${run.status}\t${modelText(run)}\t${where === "" ? "-" : where}\t${age}\t${relative(paths.root(), run.logPath)}`;
}

/** One harness and model's share of the runs started today: `bin/toli digest` and `bin/toli resources --json`. */
export type ModelTotal = {
    harness: Harness;
    model: string | null;
    runs: number;
    /** Wall-clock minutes the runs took (or have taken so far); queued time not counted. */
    minutes: number;
    /** Present when the harness printed tokens or cost for at least one of the runs. */
    tokens?: number;
    costUsd?: number;
};

/** Totals per harness and model of the runs started since local midnight, most runs first. */
export function modelTotalsToday(runs: JawanRun[] = listRuns()): ModelTotal[] {
    const at = now();
    const midnight = new Date(at);
    midnight.setHours(0, 0, 0, 0);
    const totals = new Map<string, ModelTotal>();
    for (const run of runs) {
        if (run.status === "queued" || Date.parse(run.startedAt) < midnight.getTime()) continue;
        const key = `${run.harness}\t${run.model ?? ""}`;
        const total = totals.get(key) ?? { harness: run.harness, model: run.model, runs: 0, minutes: 0 };
        const end = run.endedAt === null ? at.getTime() : Date.parse(run.endedAt);
        total.runs += 1;
        total.minutes += Math.max(0, Math.round((end - Date.parse(run.startedAt)) / 60_000));
        if (run.usage?.tokens !== undefined) total.tokens = (total.tokens ?? 0) + run.usage.tokens;
        if (run.usage?.costUsd !== undefined) total.costUsd = (total.costUsd ?? 0) + run.usage.costUsd;
        totals.set(key, total);
    }
    return [...totals.values()].sort((a, b) => b.runs - a.runs || b.minutes - a.minutes);
}

/** `omp claude-sonnet-5-5: 4 runs, 95m, 120000 tokens, $1.20`. */
export function modelTotalLine(total: ModelTotal): string {
    const usage = usageText(total);
    return `${total.harness} ${total.model ?? "default"}: ${total.runs} run${total.runs === 1 ? "" : "s"}, ${total.minutes}m${usage === "" ? "" : `, ${usage}`}`;
}
