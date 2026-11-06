// What the disk keeper (src/fleet/disk.ts) may delete, and what holds it: the checkouts of registered projects, their
// git-ignored build output folders, the runs and processes using each checkout, and the files processes hold open.
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { git, isGitRepo } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { run } from "../core/util.ts";
import { listRuns, RUNNING } from "../jawans/runs.ts";
import { loadProjects } from "../projects/projects.ts";
import { gitWorktrees } from "../projects/workspace.ts";

/** One working tree of a registered project: its main clone or one of the clone's git worktrees. */
export type Checkout = { project: string; path: string; main: boolean };

export type BuildKind = "target" | "node_modules" | "dist";

export type BuildDir = { kind: BuildKind; path: string; checkout: Checkout; mtimeMs: number };

const BUILD_KINDS: readonly BuildKind[] = ["target", "node_modules", "dist"];

function real(path: string): string {
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

/** Working directory of every process of this user, keyed by path, valued by one pid (`lsof -d cwd`). */
function processCwds(): Map<string, string> {
    const cwds = new Map<string, string>();
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
export function openBelow(dir: string, limit = 3): string[] {
    const listed = run(["lsof", "-n", "-P", "-w", "-Fpn"], { timeoutMs: 120_000 });
    const me = String(process.pid);
    const held: string[] = [];
    let pid = "";
    for (const line of listed.stdout.split("\n")) {
        if (line.startsWith("p")) pid = line.slice(1);
        else if (line.startsWith("n") && pid !== me && within(line.slice(1), dir)) {
            held.push(`${line.slice(1)} (pid ${pid})`);
            if (held.length >= limit) break;
        }
    }
    return held;
}

/**
 * A cargo process (`cargo`, `cargo-clippy`, `cargo-nextest`, ...) whose working directory lies in `workspace`, as
 * `cargo (pid N) runs in <dir>`, or null. `cargo test` drops its build lock once compiling is done and then runs the
 * test binaries one by one; between two of them nothing in the target is open, yet cargo is about to start the next.
 */
export function cargoRunsIn(workspace: string): string | null {
    const listed = run(["lsof", "-a", "-d", "cwd", "-c", "cargo", "-w", "-Fpn"], { timeoutMs: 60_000 });
    let pid = "";
    for (const line of listed.stdout.split("\n")) {
        if (line.startsWith("p")) pid = line.slice(1);
        else if (line.startsWith("n") && within(line.slice(1), workspace))
            return `cargo (pid ${pid}) runs in ${line.slice(1)}`;
    }
    return null;
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
