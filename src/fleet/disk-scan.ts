// What the disk keeper (src/fleet/disk.ts) may delete, and what holds it: the checkouts of registered projects, their
// git-ignored build output folders, the runs and processes using each checkout, and the files processes hold open.
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { git, isGitRepo } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { pidAlive, platform, run } from "../core/util.ts";
import { listRuns, RUNNING } from "../jawans/runs.ts";
import { loadProjects } from "../projects/projects.ts";
import { gitWorktrees } from "../projects/workspace.ts";
import { buildTool, configuredBuildTools } from "./build-tools.ts";
import { procCargoCwds, procCwds, procLink, procOpenFiles } from "./disk-proc.ts";
import { procFile } from "./resources.ts";

/** One working tree of a registered project: its main clone or one of the clone's git worktrees. */
export type Checkout = { project: string; path: string; main: boolean };

export type BuildKind = "target" | "node_modules" | "dist";

export type BuildDir = { kind: BuildKind; path: string; checkout: Checkout; mtimeMs: number };

const BUILD_KINDS: readonly BuildKind[] = ["target", "node_modules", "dist"];

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
    const listed = git(checkout.path, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
    if (listed.code !== 0) return [];
    const dirs: BuildDir[] = [];
    for (const entry of listed.stdout.split("\0")) {
        if (!entry.endsWith("/")) continue;
        const path = join(checkout.path, entry.slice(0, -1));
        const kind = BUILD_KINDS.find((name) => name === basename(path));
        if (kind === undefined) continue;
        try {
            const stat = lstatSync(path);
            if (!stat.isDirectory()) continue;
            dirs.push({ kind, path, checkout, mtimeMs: newestChildMtime(path, stat.mtimeMs) });
        } catch {
            // Gone since git listed it.
        }
    }
    return dirs;
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

/** What uses checkouts right now: running jawans' directories and projects, and every process's working directory. */
export type Holders = { runs: { cwd: string; project: string | null; id: string }[]; cwds: Map<string, string> };

export function currentHolders(): Holders {
    const runs = listRuns()
        .filter((entry) => RUNNING.includes(entry.status))
        .map((entry) => ({ cwd: real(entry.cwd), project: entry.project, id: entry.id }));
    return { runs, cwds: processCwds() };
}

/** Working directory of every process of this user, keyed by path, valued by one pid (`lsof -d cwd`, Linux /proc). */
function processCwds(): Map<string, string> {
    const cwds = new Map<string, string>();
    if (platform() === "linux") {
        for (const { pid, cwd } of procCwds()) cwds.set(cwd, pid);
        return cwds;
    }
    const uid = process.getuid?.();
    const user = uid === undefined ? [] : ["-u", String(uid)];
    const listed = run(["lsof", "-a", "-d", "cwd", ...user, "-w", "-Fpn"], { timeoutMs: 60_000 });
    let pid = "";
    for (const line of listed.stdout.split("\n")) {
        if (line.startsWith("p")) pid = line.slice(1);
        else if (line.startsWith("n") && pid !== String(process.pid)) cwds.set(line.slice(1), pid);
    }
    return cwds;
}

/**
 * Why `checkout` is in use, or null when nothing uses it: a running jawan whose directory is inside it (or, for the
 * main clone, a running jawan of its project working elsewhere), or a process whose working directory is inside it.
 */
export function checkoutUse(checkout: Checkout, holders: Holders, all: Checkout[]): string | null {
    for (const entry of holders.runs) {
        if (within(entry.cwd, checkout.path)) return `jawan ${entry.id} works in it`;
        const inOwnCheckout = all.some((other) => other.project === entry.project && within(entry.cwd, other.path));
        if (checkout.main && entry.project === checkout.project && !inOwnCheckout)
            return `jawan ${entry.id} works on ${checkout.project}`;
    }
    for (const [cwd, pid] of holders.cwds) {
        if (within(cwd, checkout.path)) return `process ${pid} runs in ${cwd}`;
    }
    return null;
}

/** Paths below `dir` that any process other than this one holds open (`lsof -Fpn`), at most `limit` of them. */
export function openBelow(dir: string, limit = 3, openFiles: () => HeldFile[] = allOpenFiles): string[] {
    return heldOpenBelow(dir, limit, openFiles).map((held) => `${held.path} (pid ${held.pid})`);
}

/** One file a process holds open, runs or maps, with the holding pid. */
export type HeldFile = { path: string; pid: string };

/** Every file any process other than this one holds open, runs or maps (`lsof -Fpn` lists all three; Linux /proc). */
function allOpenFiles(): HeldFile[] {
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

/**
 * One other process: its command line, the executable and mapped files it runs, and its working directory.
 * `uninspected`: one of this user's processes whose files could not be read (lsof left it out, typically while it was
 * exec'ing); the keeper counts it as using every target rather than guess.
 */
export type ProcessUse = { pid: string; args: string; files: string[]; cwd: string | null; uninspected?: true };

/**
 * Rechecks of one of this user's processes lsof left out, `RECHECK_MS` apart (about 2 s in all), before it counts as
 * uninspected: a process caught mid-exec on a loaded machine becomes readable once its exec completes.
 */
const RECHECKS = 40;
const RECHECK_MS = 50;

/** Parse lsof `-Fpfn` output into the table's entries; returns the pids it reported. */
function readLsof(stdout: string, table: Map<string, ProcessUse>): Set<string> {
    const seen = new Set<string>();
    let current: ProcessUse | undefined;
    let fd = "";
    for (const line of stdout.split("\n")) {
        const value = line.slice(1);
        if (line.startsWith("p")) {
            current = table.get(value);
            seen.add(value);
        } else if (line.startsWith("f")) fd = value;
        else if (line.startsWith("n") && current !== undefined) {
            if (fd === "cwd") current.cwd = value;
            else current.files.push(value);
        }
    }
    return seen;
}

/**
 * Every process but this one (`ps`), with what it runs and where; null when the table cannot be read. A process of
 * this user that cannot be inspected is kept as `uninspected`, never as one that uses nothing: lsof silently leaves out
 * a process caught mid-exec (a test binary cargo just started), and under load that is common.
 */
function processTable(): ProcessUse[] | null {
    const listed = run(["ps", "-axww", "-o", "pid=,uid=,stat=,args="], { timeoutMs: 30_000 });
    if (listed.code !== 0) return null;
    const me = String(process.pid);
    const uid = String(process.getuid?.() ?? -1);
    const table = new Map<string, ProcessUse>();
    const mine: string[] = [];
    for (const line of listed.stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        const pid = match?.[1];
        if (pid === undefined || pid === me) continue;
        table.set(pid, { pid, args: match?.[4] ?? "", files: [], cwd: null });
        // Zombies hold no files; other users' processes are not ours to read.
        if (match?.[2] === uid && !(match?.[3] ?? "").startsWith("Z")) mine.push(pid);
    }
    if (platform() === "linux") {
        for (const entry of table.values()) {
            const exe = procLink(entry.pid, "exe");
            if (exe !== null) entry.files.push(exe);
            entry.cwd = procLink(entry.pid, "cwd");
        }
        for (const pid of mine) {
            const entry = table.get(pid);
            if (entry !== undefined && entry.files.length === 0 && existsSync(procFile(pid))) entry.uninspected = true;
        }
        return [...table.values()];
    }
    // macOS: the executable and every mapped file (`txt`) plus the working directory of each process, in one pass.
    const files = run(["lsof", "-a", "-d", "cwd,txt", "-w", "-Fpfn"], { timeoutMs: 60_000 });
    if (files.stdout === "" && files.code !== 0) return null;
    const seen = readLsof(files.stdout, table);
    for (const pid of mine) {
        if (seen.has(pid)) continue;
        const entry = table.get(pid);
        if (entry === undefined) continue;
        let inspected = false;
        for (let attempt = 0; attempt < RECHECKS && !inspected; attempt++) {
            if (attempt > 0) Bun.sleepSync(RECHECK_MS);
            const one = run(["lsof", "-a", "-p", pid, "-d", "cwd,txt", "-w", "-Fpfn"], { timeoutMs: 10_000 });
            inspected = readLsof(one.stdout, table).has(pid) || !pidAlive(Number(pid));
        }
        if (inspected) continue;
        entry.uninspected = true;
        // lsof still cannot read it, but ps shows what it exec'd: its program path tells which target it runs from.
        const args = run(["ps", "-o", "args=", "-p", pid], { timeoutMs: 10_000 }).stdout.trim();
        const program = args.split(/\s+/)[0] ?? "";
        if (program.startsWith("/")) entry.files.push(real(program));
    }
    return [...table.values()];
}

/**
 * Why a process uses `target` right now, or null when none does: one runs an executable or maps a file under it (a
 * test binary cargo started after releasing its locks), works inside the workspace that owns it (the folder holding
 * `target/`), or is a build tool running in, above or on that workspace. An unreadable process table is a reason too.
 */
export function targetUse(
    target: string,
    processes: () => ProcessUse[] | null = processTable,
    buildTools: () => string[] = configuredBuildTools,
): string | null {
    const dir = real(target);
    const workspaces = [...new Set([dirname(dir), dirname(target)])];
    const table = processes();
    if (table === null) return "cannot read the process table to see who uses it";
    const extra = buildTools();
    const roots = new Set(["/", real(homedir())]);
    for (const entry of table) {
        const file = entry.files.find((path) => within(path, dir));
        if (file !== undefined) return `process ${entry.pid} runs ${file}`;
        const cwd = entry.cwd;
        if (cwd !== null && workspaces.some((workspace) => within(cwd, workspace)))
            return `process ${entry.pid} runs in ${cwd}`;
        const tool = buildTool(entry.args, extra);
        if (tool === null) continue;
        if (cwd === null) return `${tool} (pid ${entry.pid}) runs where it cannot be seen`;
        const above = !roots.has(cwd) && workspaces.some((workspace) => within(workspace, cwd));
        if (above || workspaces.some((workspace) => entry.args.includes(workspace)))
            return `${tool} (pid ${entry.pid}) builds in ${workspaces[0]}`;
    }
    // Only when nothing seen uses it: a process that could not be inspected might be running from it.
    const unseen = table.find((entry) => entry.uninspected === true);
    return unseen === undefined ? null : `process ${unseen.pid} could not be inspected (lsof did not list it)`;
}

/** The working directory of every cargo process (`cargo`, `cargo-clippy`, `cargo-nextest`, ...; `lsof -c cargo`). */
function cargoCwds(): { pid: string; cwd: string }[] {
    if (platform() === "linux") return procCargoCwds();
    const listed = run(["lsof", "-a", "-d", "cwd", "-c", "cargo", "-w", "-Fpn"], { timeoutMs: 60_000 });
    const cwds: { pid: string; cwd: string }[] = [];
    let pid = "";
    for (const line of listed.stdout.split("\n")) {
        if (line.startsWith("p")) pid = line.slice(1);
        else if (line.startsWith("n")) cwds.push({ pid, cwd: line.slice(1) });
    }
    return cwds;
}

/**
 * A cargo process whose working directory lies in `workspace`, as `cargo (pid N) runs in <dir>`, or null. `cargo test`
 * drops its build lock once compiling is done and then runs the test binaries one by one; between two of them nothing
 * in the target is open, yet cargo is about to start the next.
 */
export function cargoRunsIn(
    workspace: string,
    cargos: () => { pid: string; cwd: string }[] = cargoCwds,
): string | null {
    const found = cargos().find((cargo) => within(cargo.cwd, workspace));
    return found === undefined ? null : `cargo (pid ${found.pid}) runs in ${found.cwd}`;
}

/** What a target wipe asks the machine about who uses the target; the live machine unless a caller injects its own. */
export type UseProbes = {
    /** Every process but this one with what it runs and where; null when the table cannot be read. */
    processes: () => ProcessUse[] | null;
    /** Every file a process other than this one holds open, runs or maps. */
    openFiles: () => HeldFile[];
    /** The working directory of every cargo process. */
    cargos: () => { pid: string; cwd: string }[];
    /** The machine's own build tools (capacity.diskBuildTools), beside the generic ones. */
    buildTools: () => string[];
};

export const LIVE_PROBES: UseProbes = {
    processes: processTable,
    openFiles: allOpenFiles,
    cargos: cargoCwds,
    buildTools: configuredBuildTools,
};

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
