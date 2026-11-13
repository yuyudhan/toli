// AGENTS.md rule 5 in code: one code folder, one build folder. A build runs only in a place toli knows: a registered
// project's clone (data/projects.json), a task worktree toli made for a worktree-per-task project
// (projects/.worktrees/<project>/<T-id>), a no-mistakes run worktree (<NM_HOME>/worktrees/<repo>/<run>, the gate's
// own), or toli's own checkout. `bin/toli build-slot -- <command>` checks the working tree of the build (the git
// toplevel of the cwd, or of a `--manifest-path`, climbing out of submodules) before it queues for a slot, and refuses
// anything else: a git worktree a jawan made, a `git archive` export, a /tmp copy. The cargo shim (bin/shims/cargo)
// sends every heavy cargo command there, inside a slot too. TOLI_BUILD_PLACE_OVERRIDE="<reason>" lets one build through
// anyway: it warns and appends a line to logs/build-place.log. `bin/toli disk keep` and `bin/toli doctor` flag, never
// delete, folders outside those places under /tmp, $TMPDIR and the home folder that hold a `target/` or
// `node_modules/`, and every `git worktree list` entry of toli's checkout or a registered clone that toli did not make.
import { appendFileSync, type Dirent, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isGitRepo } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { now, run, ToliError, warn } from "../core/util.ts";
import { loadProjects } from "../projects/projects.ts";
import { gitWorktrees } from "../projects/workspace.ts";
import type { Check } from "../setup/doctor.ts";
import { real, within } from "./disk-scan.ts";
import { noMistakesHome } from "./no-mistakes-runs.ts";

/** Set to a reason, it lets a build run outside the known places (logged in logs/build-place.log). */
export const OVERRIDE_ENV = "TOLI_BUILD_PLACE_OVERRIDE";
/** Colon-separated folders the stray scan reads instead of /tmp, $TMPDIR and the home folder (tests). */
const SCAN_ROOTS_ENV = "TOLI_BUILD_SCAN_ROOTS";
/** How many levels below each scan root the stray scan reads (~/code/<org>/<repo> is 3). */
const SCAN_DEPTH = 3;
/** At most this many folders are read per scan root, so a huge home folder cannot stall `doctor` or the keeper. */
const SCAN_LIMIT = 10_000;
/** The build folders whose presence marks a folder as a build's working tree. */
const BUILD_FOLDERS: readonly string[] = ["target", "node_modules"];
/** Folders never descended into: OS and app data on macOS, never a project checkout. */
const SKIPPED_FOLDERS: Readonly<Record<string, true>> = { Library: true };
/** Submodules nest; past this many superprojects the outermost one found counts. */
const MAX_SUPERPROJECTS = 8;
/** Variables a git hook sets that would point git at the hook's repository instead of the folder asked about. */
const HOOK_GIT_ENV: Record<string, undefined> = {
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_INDEX_FILE: undefined,
};

/** The places a build may run in, every path resolved. */
type Places = {
    /** Toli's checkout and each registered clone, with how to name it. */
    checkouts: Map<string, string>;
    /** projects/.worktrees/<project> of each registered project: its task worktrees are the folders directly in it. */
    taskWorktrees: Map<string, string>;
    /** <NM_HOME>/worktrees: no-mistakes run worktrees are <repo>/<run> below it. */
    runWorktrees: string;
};

/** A folder outside the known places: a build folder's owner or a worktree toli did not make, and why it is flagged. */
export type OutsideBuild = { path: string; why: string };

export type OutsideScan = { found: OutsideBuild[]; complete: boolean };

function knownPlaces(): Places {
    const checkouts = new Map<string, string>([[real(paths.root()), "toli's checkout"]]);
    const taskWorktrees = new Map<string, string>();
    for (const project of loadProjects()) {
        checkouts.set(real(paths.projectDir(project.name)), `projects/${project.name}`);
        taskWorktrees.set(real(paths.worktreesDir(project.name)), project.name);
    }
    return { checkouts, taskWorktrees, runWorktrees: real(join(noMistakesHome(), "worktrees")) };
}

/** git in `dir`, never steered elsewhere by a hook's environment. */
function gitIn(dir: string, args: string[]): string | null {
    const result = run(["git", "-C", dir, ...args], { env: HOOK_GIT_ENV });
    return result.code === 0 ? result.stdout.trim() : null;
}

/** The working tree a build in `dir` uses: its git toplevel, out of any submodules; `dir` itself outside git. */
function workingTree(dir: string): { path: string; git: boolean } {
    let tree = gitIn(dir, ["rev-parse", "--show-toplevel"]);
    if (tree === null || tree === "") return { path: real(dir), git: false };
    for (let hops = 0; hops < MAX_SUPERPROJECTS; hops++) {
        const parent = gitIn(tree, ["rev-parse", "--show-superproject-working-tree"]);
        if (parent === null || parent === "") break;
        tree = parent;
    }
    return { path: real(tree), git: true };
}

/** Which known place the git working tree `tree` is, or null when it is none of them. */
function placeOf(tree: string, places: Places): string | null {
    const checkout = places.checkouts.get(tree);
    if (checkout !== undefined) return checkout;
    const project = places.taskWorktrees.get(dirname(tree));
    if (project !== undefined) return `${project}'s task worktree`;
    if (dirname(dirname(tree)) === places.runWorktrees) return "a no-mistakes run worktree";
    return null;
}

/** Whether `path` is a known place or lies inside one. */
function insidePlace(path: string, places: Places): boolean {
    return [...places.checkouts.keys(), ...places.taskWorktrees.keys(), places.runWorktrees].some((place) =>
        within(path, place),
    );
}

/** The folder whose working tree a build of `args` started in `cwd` uses: a `--manifest-path`'s, else the cwd. */
export function buildDir(args: string[], cwd: string): string {
    for (let index = 0; index < args.length; index++) {
        const arg = args[index] ?? "";
        if (arg === "--") break;
        const next = args[index + 1];
        if (arg === "--manifest-path" && next !== undefined) return dirname(resolve(cwd, next));
        if (arg.startsWith("--manifest-path=")) return dirname(resolve(cwd, arg.slice("--manifest-path=".length)));
    }
    return cwd;
}

function refusal(tree: string): string {
    return (
        `refusing to build in ${tree}: it is not a registered clone (data/projects.json), a task worktree toli made ` +
        "(projects/.worktrees/<project>/<T-id>) or toli's own checkout. AGENTS.md rule 5: one code folder, one build " +
        "folder; build in the checkout you work in, never in a git worktree, a git archive export or a /tmp copy. " +
        `When the user agreed to an exception: ${OVERRIDE_ENV}="<why>" (logged in logs/build-place.log).`
    );
}

/** Record a build let outside the known places; a log that cannot be written never stops the build. */
function logOverride(entry: Record<string, string | number>): void {
    try {
        mkdirSync(dirname(paths.buildPlaceLog()), { recursive: true });
        appendFileSync(paths.buildPlaceLog(), `${JSON.stringify(entry)}\n`);
    } catch (error) {
        warn(`toli: could not write logs/build-place.log: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Refuse (ToliError) a build of `command` started in `cwd` whose working tree is outside the known places, unless
 * OVERRIDE_ENV gives a reason: then warn, log it and return.
 */
export function checkBuildPlace(cwd: string, command: string[]): void {
    const places = knownPlaces();
    const tree = workingTree(buildDir(command.slice(1), cwd));
    const allowed = tree.git ? placeOf(tree.path, places) !== null : insidePlace(tree.path, places);
    if (allowed) return;
    const reason = (process.env[OVERRIDE_ENV] ?? "").trim();
    if (reason === "") throw new ToliError(refusal(tree.path));
    warn(
        `toli: building outside the clones in ${tree.path} (${OVERRIDE_ENV}: ${reason}); logged in logs/build-place.log`,
    );
    logOverride({
        at: now().toISOString(),
        tree: tree.path,
        cwd,
        command: command.join(" "),
        reason,
        pid: process.pid,
    });
}

/** The folders the stray scan reads, resolved and without repeats. */
function scanRoots(): string[] {
    const configured = process.env[SCAN_ROOTS_ENV];
    const roots = configured === undefined ? ["/tmp", tmpdir(), homedir()] : configured.split(":");
    return [...new Set(roots.filter((root) => root !== "").map(real))];
}

/** Folders below the scan roots, outside every known place, that hold a build folder. */
function strayBuildFolders(places: Places, roots: string[]): OutsideScan {
    const found: OutsideBuild[] = [];
    let complete = true;
    let budget = 0;
    const visit = (dir: string, depth: number): void => {
        if (budget <= 0 || insidePlace(dir, places)) return;
        budget--;
        let entries: Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        const folders = entries.filter((entry) => entry.isDirectory());
        const builds = folders.filter((entry) => BUILD_FOLDERS.includes(entry.name)).map((entry) => `${entry.name}/`);
        if (builds.length > 0) {
            found.push({ path: dir, why: `holds ${builds.join(" and ")} outside the clones` });
            return;
        }
        if (depth >= SCAN_DEPTH) return;
        for (const entry of folders) {
            if (entry.name.startsWith(".") || SKIPPED_FOLDERS[entry.name] === true) continue;
            visit(join(dir, entry.name), depth + 1);
        }
    };
    for (const root of roots) {
        budget = SCAN_LIMIT;
        visit(root, 0);
        if (budget <= 0) complete = false;
    }
    return { found, complete };
}

/** Worktrees of toli's checkout and the registered clones that are none of the known places. */
function strayWorktrees(places: Places): OutsideBuild[] {
    const found: OutsideBuild[] = [];
    for (const [checkout, label] of places.checkouts) {
        if (!isGitRepo(checkout)) continue;
        let trees: string[];
        try {
            trees = gitWorktrees(checkout).map((tree) => real(tree.path));
        } catch {
            continue;
        }
        for (const tree of trees) {
            if (!existsSync(tree) || placeOf(tree, places) !== null) continue;
            found.push({ path: tree, why: `a git worktree of ${label} that toli did not make` });
        }
    }
    return found;
}

/**
 * Every folder outside the known places that holds a build folder, and every worktree toli did not make, one entry per
 * path, sorted. Read only: nothing is ever deleted. `complete` is false when the scan stopped at its folder limit.
 */
export function outsideBuilds(): OutsideScan {
    const places = knownPlaces();
    const folders = strayBuildFolders(places, scanRoots());
    const byPath = new Map<string, string[]>();
    for (const { path, why } of [...strayWorktrees(places), ...folders.found]) {
        byPath.set(path, [...(byPath.get(path) ?? []), why]);
    }
    const found = [...byPath.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, whys]) => ({ path, why: whys.join("; ") }));
    return { found, complete: folders.complete };
}

/** One line per flagged folder, for `disk keep` and `doctor`. */
export function outsideBuildLine({ path, why }: OutsideBuild): string {
    return `${path}: ${why} (AGENTS.md rule 5; toli never deletes it: land its work in the clone, then remove it)`;
}

/** What the scan left out, when it stopped early. */
export const PARTIAL_SCAN = `the scan stopped after ${SCAN_LIMIT} folders of a scan root, so more may exist`;

/** At most this many flagged folders get a `doctor` line each; `disk keep --dry-run` lists them all. */
const DOCTOR_LINES = 10;

/** `doctor`'s lines: a warning per flagged folder (the first DOCTOR_LINES), or one ok line when there are none. */
export function buildPlaceChecks(): Check[] {
    const { found, complete } = outsideBuilds();
    const warning = (detail: string): Check => ({ level: "warn", name: "build-place", detail });
    const checks = found.slice(0, DOCTOR_LINES).map((build) => warning(outsideBuildLine(build)));
    if (found.length > DOCTOR_LINES)
        checks.push(warning(`${found.length - DOCTOR_LINES} more: bin/toli disk keep --dry-run lists them all`));
    if (!complete) checks.push(warning(PARTIAL_SCAN));
    if (checks.length > 0) return checks;
    return [
        {
            level: "ok",
            name: "build-place",
            detail: "no build folders or worktrees outside the clones, toli's task worktrees and toli's checkout",
        },
    ];
}
