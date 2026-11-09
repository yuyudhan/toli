// A gate's record store (src/forge/gate.ts runs the gates): one JSON record per project, commit and recipe in
// state/gates/<project>/, read-modify-written under its lock, and every decision about it logged in logs/gates.log.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../core/paths.ts";
import { now, pidAlive, readJson, ToliError, withLock, writeJsonAtomic } from "../core/util.ts";

/** `stalled`: stopped by the runner for going silent; `killed`: stopped by a signal, or its runner vanished. */
export type GateStatus = "running" | "passed" | "failed" | "stalled" | "killed";

export type GateRecord = {
    project: string;
    sha: string;
    recipe: string;
    /** The checkout the gate runs in (the one `bin/toli push` uses). */
    dir: string;
    status: GateStatus;
    /** The runner's pid; null only while its caller is starting it. */
    pid: number | null;
    startedAt: string;
    endedAt: string | null;
    /** When the runner last saw the log grow. */
    lastOutputAt: string | null;
    exitCode: number | null;
    log: string;
    stallMinutes: number;
    /** Why a gate that did not pass stopped. */
    reason?: string;
};

/** The record file of one project, commit and recipe: <sha>-<first 16 hex of the recipe's sha256>.json. */
export function recordFile(project: string, sha: string, recipe: string): string {
    const hash = createHash("sha256").update(recipe).digest("hex").slice(0, 16);
    return join(paths.gatesDir(project), `${sha}-${hash}.json`);
}

export function readRecord(file: string): GateRecord | null {
    return readJson<GateRecord | null>(file, null);
}

/** Read-modify-write one record under its lock (the runner, its callers and attachers race on it). */
export function updateRecord(file: string, change: (record: GateRecord) => void): GateRecord {
    return withLock(`${file}.lock`, () => {
        const record = readRecord(file);
        if (record === null) throw new ToliError(`gate record ${file} is gone`);
        change(record);
        writeJsonAtomic(file, record);
        return record;
    });
}

/** A `running` record whose runner is gone is recorded `killed`; returns the record as it now stands. */
export function reconcile(file: string): GateRecord | null {
    const record = readRecord(file);
    if (record === null || record.status !== "running" || (record.pid !== null && pidAlive(record.pid))) return record;
    return withLock(`${file}.lock`, () => {
        const current = readRecord(file);
        if (current === null || current.status !== "running" || (current.pid !== null && pidAlive(current.pid)))
            return current;
        current.status = "killed";
        current.endedAt = now().toISOString();
        current.reason = `its runner (pid ${current.pid ?? "unknown"}) exited without recording an outcome`;
        writeJsonAtomic(file, current);
        return current;
    });
}

export function short(sha: string): string {
    return sha.slice(0, 12);
}

/** One line in logs/gates.log: `<time> <project> <sha12> <decision>: <message>`. */
export function logDecision(record: Pick<GateRecord, "project" | "sha">, decision: string, message: string): void {
    mkdirSync(paths.logsDir(), { recursive: true });
    appendFileSync(
        paths.gatesLog(),
        `${now().toISOString()} ${record.project} ${short(record.sha)} ${decision}: ${message}\n`,
    );
}

export function outcomeText(record: GateRecord): string {
    const minutes =
        record.endedAt === null
            ? null
            : Math.round((Date.parse(record.endedAt) - Date.parse(record.startedAt)) / 60_000);
    const after = minutes === null ? "" : ` after ${minutes}m`;
    const exit = record.exitCode === null ? "" : ` (exit ${record.exitCode})`;
    const reason = record.reason === undefined ? "" : `: ${record.reason}`;
    return `${record.recipe} ${record.status} at ${short(record.sha)}${exit}${after}${reason}, log ${record.log}`;
}
