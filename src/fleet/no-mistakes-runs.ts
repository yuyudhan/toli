// Build output the no-mistakes gate leaves in its run worktrees, for the disk keeper (src/fleet/disk.ts, step 1) and
// the low-disk alert (disk-alert.ts). no-mistakes runs each gate push in a detached worktree,
// `<NM_HOME>/worktrees/<repo>/<run>` (NM_HOME defaults to ~/.no-mistakes), and removes it when the run ends, best
// effort: a run whose checks started a compose stack leaves that stack's root-owned `docker-data/backend/target`
// behind, about 20 GB a run (T1294). Only folders under `<NM_HOME>/worktrees/` are ever considered: a run record that
// names a worktree elsewhere (a configured worktree root) never makes the keeper delete there (T1297). no-mistakes' own
// state database (`<NM_HOME>/state.sqlite`, read only) says which runs are finished: a worktree counts as finished only
// when run records name it and every one of them is terminal. Anything uncertain (no record, a status not known to be
// terminal, a database that cannot be read) counts as in use. Files a container wrote as root are removed by a
// throwaway container (`docker run --rm`), never with sudo.
import { Database } from "bun:sqlite";
import { type Dirent, existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { run } from "../core/util.ts";
import { whileIdle } from "./cargo-lock.ts";
import {
    BUILD_KINDS,
    type BuildDir,
    type BuildKind,
    type Checkout,
    checkoutUse,
    currentHolders,
    ignoredDirs,
    openBelow,
    pushBuildDir,
    real,
} from "./disk-scan.ts";
import { describe, pauseHold } from "./disk-state.ts";
import { firstLine } from "./docker-volumes.ts";

/** no-mistakes run statuses after which the run never works in its worktree again (its types.RunStatus.Terminal). */
const TERMINAL: Readonly<Record<string, true>> = {
    completed: true,
    failed: true,
    cancelled: true,
    checks_passed: true,
    handed_off: true,
    ci_monitor_interrupted: true,
};

/** The image of the throwaway container that removes root-owned build output: a few MB, with `rm` on board. */
const REMOVER_IMAGE = "busybox:latest";
/** Removing a 20 GB target can take minutes on a slow disk. */
const REMOVER_TIMEOUT_MS = 900_000;
/** Below an ignored folder that is not build output itself, how many levels deep `runBuildDirs` looks. */
const NESTED_DEPTH = 4;

/** One no-mistakes run record: its id, status and the worktree it runs in (resolved), when known. */
type RunRecord = { id: string; status: string; worktree: string | null };

/**
 * One no-mistakes run worktree as a checkout (its `project` names the run and its status, for the keeper's lines), and
 * why it is in use, or null when its run is finished.
 */
export type RunWorktree = { checkout: Checkout; use: string | null };

/** no-mistakes' data directory: NM_HOME when set, as no-mistakes itself resolves it, else ~/.no-mistakes. */
export function noMistakesHome(): string {
    const configured = process.env.NM_HOME ?? "";
    return configured === "" ? join(homedir(), ".no-mistakes") : configured;
}

/** Every run record in no-mistakes' state database, or why it cannot be read. */
function readRuns(home: string): RunRecord[] | string {
    const file = join(home, "state.sqlite");
    if (!existsSync(file)) return `${file} does not exist`;
    let db: Database | null = null;
    try {
        db = new Database(file, { readonly: true });
        const columns = db
            .query<{ name: string }, []>("PRAGMA table_info(runs)")
            .all()
            .map((column) => column.name);
        if (!["id", "repo_id", "status"].every((name) => columns.includes(name)))
            return `${file} has no runs table with id, repo_id and status`;
        // Runs recorded before no-mistakes pinned each run's placement have no worktree_dir: the default one is theirs.
        const recorded = columns.includes("worktree_dir") ? "worktree_dir" : "NULL";
        const rows = db
            .query<{ id: unknown; repo_id: unknown; status: unknown; dir: unknown }, []>(
                `SELECT id, repo_id, status, ${recorded} AS dir FROM runs`,
            )
            .all();
        return rows.map((row) => {
            const id = String(row.id);
            const dir = typeof row.dir === "string" && row.dir !== "" ? row.dir : null;
            const path = dir === null ? join(home, "worktrees", String(row.repo_id), id) : dir;
            return { id, status: String(row.status), worktree: isAbsolute(path) ? real(path) : null };
        });
    } catch (error) {
        return `cannot read ${file}: ${describe(error)}`;
    } finally {
        db?.close();
    }
}

/** Real folders (no symlinks) directly inside `dir`; none when it cannot be read. */
function subdirs(dir: string): string[] {
    let entries: Dirent[];
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));
}

/** Why the worktree at `path` (resolved) is in use, and its label; null `use` when every run naming it is finished. */
function judge(path: string, runs: RunRecord[] | string): RunWorktree {
    if (typeof runs === "string")
        return {
            checkout: { project: "no-mistakes worktree", path, main: false },
            use: `no-mistakes state unreadable (${runs}), so its run may still be working`,
        };
    const mine = runs.filter((record) => record.worktree === path);
    const active = mine.find((record) => TERMINAL[record.status] !== true);
    const shown = active ?? mine[0];
    if (shown === undefined)
        return {
            checkout: { project: "no-mistakes worktree", path, main: false },
            use: "no no-mistakes run record names it, so it may belong to a run still starting",
        };
    return {
        checkout: { project: `no-mistakes run ${shown.id}, ${shown.status}`, path, main: false },
        use: active === undefined ? null : `no-mistakes run ${active.id} is ${active.status}`,
    };
}

/**
 * Every no-mistakes run worktree on this machine, the folders under `<home>/worktrees/<repo>/` and nothing outside
 * them, each judged finished or in use.
 */
export function runWorktrees(home: string = noMistakesHome()): RunWorktree[] {
    const found = new Set<string>();
    for (const repo of subdirs(join(home, "worktrees"))) for (const tree of subdirs(repo)) found.add(real(tree));
    const runs = readRuns(home);
    return [...found].sort().map((path) => judge(path, runs));
}

/** Why the run worktree at `path` is in use right now (no-mistakes' state read again), or null when it is finished. */
export function runWorktreeUse(path: string, home: string = noMistakesHome()): string | null {
    return judge(path, readRuns(home)).use;
}

/**
 * A run worktree's build output: what `buildDirs` lists in a checkout, plus the build output inside its other ignored
 * folders (a compose stack's `docker-data/backend/target`); every folder below an ignored, wholly untracked one is
 * ignored and untracked too. Inside one only unmistakable build output counts: a `target` cargo marked as its own
 * (`CACHEDIR.TAG` or `.rustc_info.json`) or a `node_modules`, never a `dist` or an unmarked `target`, which may be
 * anyone's data. Symlinks are never followed and an unreadable folder is skipped.
 */
export function runBuildDirs(checkout: Checkout): BuildDir[] {
    const dirs: BuildDir[] = [];
    const walk = (dir: string, depth: number): void => {
        let entries: Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const path = join(dir, entry.name);
            const kind = nestedKind(path, entry.name);
            if (kind !== null) pushBuildDir(dirs, kind, path, checkout);
            else if (depth < NESTED_DEPTH) walk(path, depth + 1);
        }
    };
    for (const path of ignoredDirs(checkout)) {
        const kind = BUILD_KINDS.find((name) => name === basename(path));
        if (kind !== undefined) pushBuildDir(dirs, kind, path, checkout);
        else walk(path, 1);
    }
    return dirs;
}

function nestedKind(path: string, name: string): BuildKind | null {
    if (name === "node_modules") return "node_modules";
    if (name !== "target") return null;
    return existsSync(join(path, "CACHEDIR.TAG")) || existsSync(join(path, ".rustc_info.json")) ? "target" : null;
}

/** What the keeper's step 1 hands `freeRunWorktrees`: its run's mode, checkouts, and its deleting and logging. */
export type RunFreeing = {
    dryRun: boolean;
    checkouts: Checkout[];
    enough: () => boolean;
    remove: (path: string, step: string, deleteIt: () => string | null) => void;
    say: (line: string) => void;
};

/**
 * The keeper's step 1, first: the build output finished runs left in their worktrees, the deadest output there is,
 * until free space is back at the floor. no-mistakes' state is read again just before a real deletion, and a running
 * jawan or a process working in the worktree keeps it too. A worktree whose run is not known to be finished keeps its
 * build output at every step, the last resort included: the keeper's later steps never see these folders.
 */
export function freeRunWorktrees(context: RunFreeing): void {
    const { dryRun, checkouts, enough, remove, say } = context;
    const holders = currentHolders();
    for (const tree of runWorktrees()) {
        if (enough()) return;
        for (const dir of runBuildDirs(tree.checkout)) {
            if (enough()) return;
            let reason = tree.use ?? checkoutUse(dir.checkout, holders, checkouts);
            if (reason === null && !dryRun)
                reason = runWorktreeUse(tree.checkout.path) ?? checkoutUse(dir.checkout, currentHolders(), checkouts);
            if (reason === null)
                remove(dir.path, `step 1: finished no-mistakes run's ${dir.kind}`, () => freeRunOutput(dir));
            else say(`skipped ${dir.path}: ${reason}`);
        }
    }
}

/**
 * Delete one build folder of a finished run's worktree, or say why it stays: the keeper's pause, cargo's locks and
 * every in-use check a target wipe makes (a cargo in its workspace, a process running from it or working there, an open
 * file), or an open file for a `node_modules`. Root-owned files go through `removeAsRoot`.
 */
export function freeRunOutput(dir: BuildDir): string | null {
    const paused = pauseHold();
    if (paused !== null) return paused;
    if (dir.kind !== "target") {
        const open = openBelow(dir.path);
        return open.length > 0 ? `open files, e.g. ${open.join(", ")}` : removeTree(dir.path);
    }
    const outcome = whileIdle(dir.path, () => removeTree(dir.path));
    return outcome.ran ? outcome.value : outcome.reason;
}

/** Delete `path`; files this account may not delete (a container wrote them as root) go through `removeAsRoot`. */
function removeTree(path: string): string | null {
    try {
        rmSync(path, { recursive: true, force: true });
        return null;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM") return removeAsRoot(path);
        return `could not delete it: ${describe(error)}`;
    }
}

/**
 * Remove `path`, which holds files a container wrote as root, from a throwaway container that binds its parent folder
 * (`docker run --rm`, no network, as root inside it); never sudo. The reason when it could not.
 */
export function removeAsRoot(path: string): string | null {
    const why = "it holds root-owned files";
    const info = run(["docker", "info", "--format", "{{.ServerVersion}}"], { timeoutMs: 20_000 });
    if (info.code !== 0)
        return `${why}, and docker is ${info.code === 127 ? "not installed" : "not reachable"} to remove them (never sudo)`;
    const parent = dirname(path);
    // --mount takes comma-separated fields, so a path with a comma cannot be bound safely.
    if (parent.includes(",")) return `${why}, and its folder's path has a comma docker --mount cannot bind`;
    const removed = run(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--user",
            "0:0",
            "--mount",
            `type=bind,source=${parent},target=/toli-parent`,
            "--entrypoint",
            "rm",
            REMOVER_IMAGE,
            "-rf",
            `/toli-parent/${basename(path)}`,
        ],
        { timeoutMs: REMOVER_TIMEOUT_MS },
    );
    if (removed.code !== 0)
        return `${why}, and the throwaway container could not remove them: ${firstLine(removed.stderr || removed.stdout)}`;
    return existsSync(path) ? `${why}, still there after the throwaway container removed them` : null;
}
