// A gate's record store (src/forge/gate.ts runs the gates): one JSON record per project, tree and recipe in
// state/gates/<project>/, read-modify-written under its lock, and every decision about it logged in logs/gates.log.
// A record is keyed on the git tree it ran on, not the commit: a rebased, amended or empty-message-changed commit with
// the same files is the same gate result. A pass is sealed with an HMAC (key in state/gate-key, made once per
// installation, mode 0600) that only the gate runner writes, so a record edited or copied by hand never counts.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
    appendFileSync,
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { paths } from "../core/paths.ts";
import { now, pidAlive, readJson, ToliError, withLock, writeJsonAtomic } from "../core/util.ts";

/**
 * `stalled`: stopped by the runner for going silent; `runaway`: stopped by the runner for running over 3 times its
 * estimate or printing failures for 30 minutes (src/forge/gate-supervise.ts); `killed`: stopped by a signal, by toli
 * because every jawan that started or joined it ended (src/forge/gate-owner.ts), or its runner vanished.
 */
export type GateStatus = "running" | "passed" | "failed" | "stalled" | "runaway" | "killed";

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
    /** When the runner was spawned (right after spawn returned): with `pid`, the runner's identity. */
    pidStartedAt?: string;
    startedAt: string;
    /**
     * The `bin/toli spawn` runs (TOLI_RUN_ID) that started or joined this gate, in that order. Absent when anyone else
     * started or joined it: then no jawan owns it and toli never stops it for a jawan ending.
     */
    owners?: string[];
    endedAt: string | null;
    /** When the runner last saw the log grow. */
    lastOutputAt: string | null;
    exitCode: number | null;
    log: string;
    stallMinutes: number;
    /** How long the recipe should take (ms): the median of its recent passes' recipeMs; absent without passes. */
    estimateMs?: number;
    /** How long the recipe itself ran (ms, not counting the wait for a build slot); set when it ends. */
    recipeMs?: number;
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

/** A gate key and a proof: 32 bytes as 64 lowercase hex digits. */
const HEX_256 = /^[0-9a-f]{64}$/;

/**
 * The installation's gate key; created (owner-only, published atomically) by the first seal or proof check. A key
 * anyone else could read or replace (a symlink, another owner, group or other permission bits) or not in the shape
 * toli writes is refused: a proof sealed with it would prove nothing.
 */
function gateKey(): Buffer {
    const file = paths.gateKey();
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) {
        const staged = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
        writeFileSync(staged, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
        try {
            linkSync(staged, file);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        } finally {
            unlinkSync(staged);
        }
    }
    const stat = lstatSync(file);
    const uid = process.getuid?.();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid))
        throw new ToliError(
            `${file} must be a regular file owned by this user with mode 0600 (it is ` +
                `${stat.isSymbolicLink() ? "a symlink" : `mode ${(stat.mode & 0o777).toString(8)}, uid ${stat.uid}`}); ` +
                "delete it and run the gate again",
        );
    const key = readFileSync(file, "utf8").trim();
    if (!HEX_256.test(key)) throw new ToliError(`${file} is not a gate key; delete it and run the gate again`);
    return Buffer.from(key, "hex");
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
    if (!HEX_256.test(record.proof)) return false;
    const have = Buffer.from(record.proof, "hex");
    const want = Buffer.from(proofOf(record), "hex");
    return timingSafeEqual(have, want);
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

/** Every gate record file on this machine, of every project; an unreadable store or project folder reads as none. */
export function allRecordFiles(): string[] {
    const root = paths.gatesDir("");
    const files: string[] = [];
    let projects: string[];
    try {
        projects = readdirSync(root);
    } catch {
        return files;
    }
    for (const project of projects) {
        try {
            for (const name of readdirSync(join(root, project)))
                if (name.endsWith(".json")) files.push(join(root, project, name));
        } catch {
            // Not a project's folder.
        }
    }
    return files;
}

/**
 * Every gate running on this machine now (`gate run`, `push --gate`, the pre-push hook): a `running` record of any
 * project whose runner is alive. Read-only; an unreadable store or record reads as none.
 */
export function runningGates(): GateRecord[] {
    return allRecordFiles()
        .map((file) => readRecord(file))
        .filter(
            (record): record is GateRecord =>
                record?.status === "running" && record.pid !== null && pidAlive(record.pid),
        );
}

/** How many of a recipe's latest passes its estimate takes the median of. */
const ESTIMATE_PASSES = 5;

/**
 * How long `recipe` should take in `project` (ms): the median of the recipe's latest proven passes on any tree, each
 * its recipeMs (or, recorded before that, its whole time from start to end); undefined when it never passed here.
 */
export function recipeEstimateMs(project: string, recipe: string): number | undefined {
    const dir = paths.gatesDir(project);
    // Record files are <tree>-<recipe hash>.json: the recipe's records on every tree share this suffix.
    const suffix = basename(recordFile(project, "", recipe));
    let names: string[];
    try {
        names = readdirSync(dir).filter((name) => name.endsWith(suffix));
    } catch {
        return undefined;
    }
    const passes = names
        .map((name) => readRecord(join(dir, name)))
        .filter((record): record is GateRecord => provenPass(record, project, record?.tree ?? "", recipe))
        .sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""))
        .slice(0, ESTIMATE_PASSES)
        .map((record) => record.recipeMs ?? Date.parse(record.endedAt ?? "") - Date.parse(record.startedAt))
        .filter((ms) => Number.isFinite(ms) && ms > 0)
        .sort((a, b) => a - b);
    const middle = Math.floor(passes.length / 2);
    const upper = passes[middle];
    if (upper === undefined) return undefined;
    return passes.length % 2 === 1 ? upper : ((passes[middle - 1] ?? upper) + upper) / 2;
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
