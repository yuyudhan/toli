// A gate's record store (src/forge/gate.ts runs the gates): one JSON record per project, tree and recipe in
// state/gates/<project>/, read-modify-written under its lock, and every decision about it logged in logs/gates.log.
// A record is keyed on the git tree it ran on, not the commit: a rebased, amended or empty-message-changed commit with
// the same files is the same gate result. A pass is sealed with an HMAC (key in state/gate-key, made once per
// installation, mode 0600) that only the gate runner writes, so a record edited or copied by hand never counts.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "../core/paths.ts";
import { now, pidAlive, readJson, ToliError, withLock, writeJsonAtomic } from "../core/util.ts";

/** `stalled`: stopped by the runner for going silent; `killed`: stopped by a signal, or its runner vanished. */
export type GateStatus = "running" | "passed" | "failed" | "stalled" | "killed";

export type GateRecord = {
    project: string;
    /** The commit the gate ran at (informational; the result belongs to `tree`). */
    sha: string;
    /** The tree of that commit: what the gate tested. */
    tree: string;
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
    /** HMAC of the pass (see sealPass); present only on a record the gate runner marked `passed`. */
    proof?: string;
};

/** The record file of one project, tree and recipe: <tree>-<first 16 hex of the recipe's sha256>.json. */
export function recordFile(project: string, tree: string, recipe: string): string {
    const hash = createHash("sha256").update(recipe).digest("hex").slice(0, 16);
    return join(paths.gatesDir(project), `${tree}-${hash}.json`);
}

/** The installation's gate key; created (owner-only, published atomically) by the first seal or proof check. */
function gateKey(): Buffer {
    const file = paths.gateKey();
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) {
        const staged = `${file}.${process.pid}.tmp`;
        writeFileSync(staged, randomBytes(32).toString("hex"), { mode: 0o600 });
        try {
            linkSync(staged, file);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        } finally {
            unlinkSync(staged);
        }
    }
    const key = readFileSync(file, "utf8").trim();
    if (key === "") throw new ToliError(`${file} is empty; delete it and run the gate again`);
    return Buffer.from(key, "utf8");
}

/** What a proof covers: the project, the tree, the exact recipe text, and when it ended passed. */
function proofOf(record: GateRecord): string {
    const body = JSON.stringify([record.project, record.tree, record.recipe, "passed", record.endedAt]);
    return createHmac("sha256", gateKey()).update(body).digest("hex");
}

/** Seal a record the runner just marked passed. */
export function sealPass(record: GateRecord): void {
    record.proof = proofOf(record);
}

/**
 * Whether `record` is a pass of `recipe` on `tree` in `project` that this installation's gate runner recorded. A
 * record whose status was edited to passed, or copied from another tree, recipe or project, fails.
 */
export function provenPass(record: GateRecord | null, project: string, tree: string, recipe: string): boolean {
    if (record === null || record.status !== "passed" || typeof record.proof !== "string") return false;
    if (record.project !== project || record.tree !== tree || record.recipe !== recipe) return false;
    const have = Buffer.from(record.proof, "hex");
    const want = Buffer.from(proofOf(record), "hex");
    return have.length === want.length && timingSafeEqual(have, want);
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
