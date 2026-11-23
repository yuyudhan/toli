// What the disk keeper (src/fleet/disk.ts) may delete, and what holds it: the checkouts of registered projects, their
// git-ignored build output folders, the runs, native jawans, running gates and processes using each checkout, and the
// files processes hold open.
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { git, isGitRepo } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { now, platform, run } from "../core/util.ts";
import { runningGates } from "../forge/gate-record.ts";
import { listRuns, RUNNING } from "../jawans/runs.ts";
import { loadProjects } from "../projects/projects.ts";
import { gitWorktrees } from "../projects/workspace.ts";
import { agentState, nativeAgent } from "../records/agents.ts";
import { loadBacklog } from "../records/backlog.ts";
import { staleTaskMinutes } from "../records/stale.ts";
import { busySlots } from "./build-queue.ts";
import { harnessHelper } from "./build-tools.ts";
import { procCwds, procOpenFiles } from "./disk-proc.ts";

/** One working tree of a registered project: its main clone or one of the clone's git worktrees. */
export type Checkout = { project: string; path: string; main: boolean };

export type BuildKind = "target" | "node_modules" | "dist";

export type BuildDir = { kind: BuildKind; path: string; checkout: Checkout; mtimeMs: number };

export const BUILD_KINDS: readonly BuildKind[] = ["target", "node_modules", "dist"];

/** `path` with symlinks resolved, or `path` itself when it does not exist. */
export function real(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

/** `path` is `dir` or lies below it (both already resolved). */
export function within(path: string, dir: string): boolean {
    return path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
}

/** Every checkout of every registered project cloned here, main clone first, each path resolved once. */
export function projectCheckouts(): Checkout[] {
    const seen = new Set<string>();
    const checkouts: Checkout[] = [];
    for (const project of loadProjects()) {
        const clone = paths.projectDir(project.name);
        if (!isGitRepo(clone)) continue;
        const main = real(clone);
        let trees: string[] = [main];
        try {
            trees = gitWorktrees(clone).map((tree) => real(tree.path));
        } catch {
            // A clone git cannot list worktrees for still has its own working tree.
        }
        for (const path of trees) {
            if (seen.has(path) || !existsSync(path)) continue;
            seen.add(path);
            checkouts.push({ project: project.name, path, main: path === main });
        }
    }
    return checkouts;
}

/**
 * The checkout's build output: git-ignored, wholly untracked folders named `target`, `node_modules` or `dist`
 * (`git ls-files --others --ignored --directory`), so nothing tracked or merely uncommitted is ever listed.
 */
export function buildDirs(checkout: Checkout): BuildDir[] {
    const dirs: BuildDir[] = [];
    for (const path of ignoredDirs(checkout)) {
        const kind = BUILD_KINDS.find((name) => name === basename(path));
        if (kind !== undefined) pushBuildDir(dirs, kind, path, checkout);
    }
    return dirs;
}

/** The checkout's git-ignored, wholly untracked folders, each at its topmost ignored level. */
export function ignoredDirs(checkout: Checkout): string[] {
    const listed = git(checkout.path, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
    if (listed.code !== 0) return [];
    return listed.stdout
        .split("\0")
        .filter((entry) => entry.endsWith("/"))
        .map((entry) => join(checkout.path, entry.slice(0, -1)));
}

/** What a target wipe adds to the folder it renames aside before deleting it (src/fleet/cargo-lock.ts renameAside). */
export const WIPE_ASIDE = ".toli-wipe-";
const WIPE_ASIDE_NAME = /\.toli-wipe-\d+$/;

/**
 * Folders a target wipe renamed aside and never finished deleting (a kill between the rename and the delete, or
 * root-owned files nothing could remove): every wholly untracked folder of the checkout named
 * `<name>.toli-wipe-<ms>`, whether git excludes it (the wipe adds `*.toli-wipe-*` to the checkout's excludes) or not.
 */
export function wipeLeftovers(checkout: Checkout): string[] {
    const listed = git(checkout.path, ["ls-files", "-z", "--others", "--directory"]);
    if (listed.code !== 0) return [];
    return listed.stdout
        .split("\0")
        .filter((entry) => entry.endsWith("/") && WIPE_ASIDE_NAME.test(entry.slice(0, -1)))
        .map((entry) => join(checkout.path, entry.slice(0, -1)));
}

/** Add `path` as a build folder of `kind` when it is a real folder (not a symlink) still there. */
export function pushBuildDir(dirs: BuildDir[], kind: BuildKind, path: string, checkout: Checkout): void {
    try {
        const stat = lstatSync(path);
        if (stat.isDirectory()) dirs.push({ kind, path, checkout, mtimeMs: newestChildMtime(path, stat.mtimeMs) });
    } catch {
        // Gone since git listed it.
    }
}

/** Newest mtime of the folder and its direct children: a build rewrites `target/debug`, `node_modules/.bin`, etc. */
function newestChildMtime(dir: string, own: number): number {
    let newest = own;
    try {
        for (const name of readdirSync(dir)) {
            try {
                newest = Math.max(newest, lstatSync(join(dir, name)).mtimeMs);
            } catch {
                // Removed meanwhile.
            }
        }
    } catch {
        // Unreadable: its own mtime stands.
    }
    return newest;
}

/**
 * What uses checkouts right now: running jawans' directories and projects, the task worktrees live native subagents
 * work in, the checkouts running gates check, every process's working directory, and where each held heavy-build
 * slot's holder works.
 */
export type Holders = {
    runs: { cwd: string; project: string | null; id: string }[];
    tasks: { path: string; why: string }[];
    gates: { dir: string; why: string }[];
    cwds: Map<string, string>;
    slots: { cwd: string; why: string }[];
};

export function currentHolders(): Holders {
    const runs = listRuns()
        .filter((entry) => RUNNING.includes(entry.status))
        .map((entry) => ({ cwd: real(entry.cwd), project: entry.project, id: entry.id }));
    const gates = runningGates().map((gate) => ({
        dir: real(gate.dir),
        why: `a gate of ${gate.project} (pid ${gate.pid}) runs in it`,
    }));
    const slots = busySlots().map((slot) => ({
        cwd: real(slot.cwd),
        why: `heavy-build slot ${slot.slot} (pid ${slot.pid}) is held for a build in it`,
    }));
    return { runs, tasks: subagentWorkspaces(), gates, cwds: processCwds(), slots };
}

/**
 * The recorded workspace of every open task whose native subagent is live (agentState, as the jawan count reads it):
 * a jawan between two commands runs no process there, and the run records cover only `bin/toli spawn` jawans (T1905).
 * A done or dropped task's tag holds nothing: its subagent lives on in the lead session and moves to other tasks, so
 * the tag would hold the worktree for as long as that session lives (T2107); a follow-up reopens the task first.
 */
function subagentWorkspaces(): Holders["tasks"] {
    const at = now();
    const grace = staleTaskMinutes();
    return loadBacklog().tasks.flatMap((task) =>
        task.workspace !== undefined &&
        task.status !== "done" &&
        task.status !== "dropped" &&
        nativeAgent(task) &&
        agentState(task, at, grace).state === "live"
            ? [{ path: real(task.workspace.path), why: `${task.id}'s jawan ${task.agent} works in it` }]
            : [],
    );
}

/**
 * Working directory of every process of this user, keyed by path, valued by one pid (`lsof -d cwd`, Linux /proc);
 * a harness's idle helper (harnessHelper, as `ps` shows its command line) is left out.
 */
function processCwds(): Map<string, string> {
    const helpers = helperPids();
    const cwds = new Map<string, string>();
    if (platform() === "linux") {
        for (const { pid, cwd } of procCwds()) if (!helpers.has(pid)) cwds.set(cwd, pid);
        return cwds;
    }
    const uid = process.getuid?.();
    const user = uid === undefined ? [] : ["-u", String(uid)];
    const listed = run(["lsof", "-a", "-d", "cwd", ...user, "-w", "-Fpn"], { timeoutMs: 60_000 });
    let pid = "";
    for (const line of listed.stdout.split("\n")) {
        if (line.startsWith("p")) pid = line.slice(1);
        else if (line.startsWith("n") && pid !== String(process.pid) && !helpers.has(pid)) cwds.set(line.slice(1), pid);
    }
    return cwds;
}

/** The pids of every harness's idle helper running now (`ps`); none when the table cannot be read. */
function helperPids(): Set<string> {
    const listed = run(["ps", "-axww", "-o", "pid=,args="], { timeoutMs: 30_000 });
    const pids = new Set<string>();
    for (const line of listed.stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (match?.[1] !== undefined && harnessHelper(match[2] ?? "")) pids.add(match[1]);
    }
    return pids;
}

/**
 * Why `checkout` is in use, or null when nothing uses it: a running jawan whose directory is inside it (or, for the
 * main clone, a running jawan of its project working elsewhere), a live native subagent whose open task's recorded
 * workspace is this worktree (never the main clone, whose build output has rules of its own), a running gate checking
 * it, or a process whose working directory is inside it.
 */
export function checkoutUse(checkout: Checkout, holders: Holders, all: Checkout[]): string | null {
    for (const entry of holders.runs) {
        if (within(entry.cwd, checkout.path)) return `jawan ${entry.id} works in it`;
        const inOwnCheckout = all.some((other) => other.project === entry.project && within(entry.cwd, other.path));
        if (checkout.main && entry.project === checkout.project && !inOwnCheckout)
            return `jawan ${entry.id} works on ${checkout.project}`;
    }
    const task = checkout.main ? undefined : holders.tasks.find((entry) => within(entry.path, checkout.path));
    if (task !== undefined) return task.why;
    const gate = holders.gates.find((entry) => within(entry.dir, checkout.path));
    if (gate !== undefined) return gate.why;
    for (const [cwd, pid] of holders.cwds) {
        if (within(cwd, checkout.path)) return `process ${pid} runs in ${cwd}`;
    }
    return null;
}

/**
 * Why `checkout`'s `target/` folders stay while free disk is over the emergency level, or null (T2232): a live native
 * jawan whose open task's recorded workspace is this main clone (a task pinned to it, such as a release train, between
 * two commands), or a held heavy-build slot whose holder works in the checkout, whatever target it builds into. Under
 * the emergency level they go like any idle target: a full disk deletes the build folders nothing uses now.
 */
export function softHold(checkout: Checkout, holders: Holders): string | null {
    const task = checkout.main ? holders.tasks.find((entry) => within(entry.path, checkout.path)) : undefined;
    if (task !== undefined) return task.why;
    return holders.slots.find((entry) => within(entry.cwd, checkout.path))?.why ?? null;
}

/** Paths below `dir` that any process other than this one holds open (`lsof -Fpn`), at most `limit` of them. */
export function openBelow(dir: string, limit = 3, openFiles: () => HeldFile[] = allOpenFiles): string[] {
    return heldOpenBelow(dir, limit, openFiles).map((held) => `${held.path} (pid ${held.pid})`);
}

/** One file a process holds open, runs or maps, with the holding pid. */
export type HeldFile = { path: string; pid: string };

/** Every file any process other than this one holds open, runs or maps (`lsof -Fpn` lists all three; Linux /proc). */
export function allOpenFiles(): HeldFile[] {
    if (platform() === "linux") return procOpenFiles();
    const listed = run(["lsof", "-n", "-P", "-w", "-Fpn"], { timeoutMs: 120_000 });
    const me = String(process.pid);
    const held: HeldFile[] = [];
    let pid = "";
    for (const line of listed.stdout.split("\n")) {
        if (line.startsWith("p")) pid = line.slice(1);
        else if (line.startsWith("n") && pid !== me) held.push({ path: line.slice(1), pid });
    }
    return held;
}

/** Files below `dir` that any process other than this one holds open, runs or maps; at most `limit` of them. */
export function heldOpenBelow(
    dir: string,
    limit = Number.POSITIVE_INFINITY,
    openFiles: () => HeldFile[] = allOpenFiles,
): HeldFile[] {
    const held: HeldFile[] = [];
    for (const file of openFiles()) {
        if (!within(file.path, dir)) continue;
        held.push(file);
        if (held.length >= limit) break;
    }
    return held;
}

/** Size of a folder in GB from `du -sk` (0 when du fails). */
export function sizeGB(path: string): number {
    const result = run(["du", "-sk", path], { timeoutMs: 600_000 });
    const kb = Number(result.stdout.trim().split(/\s+/)[0]);
    return Number.isFinite(kb) ? kb / 1024 / 1024 : 0;
}

/** Files under `dir` (no symlinks followed) with size and mtime, for trimming a cache to its cap. */
export function cacheFiles(dir: string): { path: string; bytes: number; mtimeMs: number }[] {
    const files: { path: string; bytes: number; mtimeMs: number }[] = [];
    const walk = (current: string): void => {
        let names: string[];
        try {
            names = readdirSync(current);
        } catch {
            return;
        }
        for (const name of names) {
            const path = join(current, name);
            try {
                const stat = lstatSync(path);
                if (stat.isDirectory()) walk(path);
                else if (stat.isFile()) files.push({ path, bytes: stat.size, mtimeMs: stat.mtimeMs });
            } catch {
                // Removed meanwhile.
            }
        }
    };
    if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir);
    return files;
}
