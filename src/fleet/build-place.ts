// AGENTS.md rule 5 in code: one code folder, one build folder. A build runs only in a place toli knows: a registered
// project's clone (data/projects.json), a task worktree toli made for a worktree-per-task project
// (projects/.worktrees/<project>/<T-id>), a no-mistakes run worktree (<NM_HOME>/worktrees/<repo>/<run>, the gate's
// own), the release dry run's temporary clone of toli (scripts/publish.ts marks it: RELEASE_CLONE_MARKER, T2334),
// or toli's own checkout. `bin/toli build-slot -- <command>` checks the working tree of the build (the git
// toplevel of the cwd, or of a `--manifest-path`, climbing out of submodules) before it queues for a slot, and refuses
// anything else: a git worktree a jawan made, a `git archive` export, a /tmp copy. The cargo shim (bin/shims/cargo)
// sends every heavy cargo command there, inside a slot too. TOLI_BUILD_PLACE_OVERRIDE="<reason>" lets one build through
// anyway: it warns and appends a line to logs/build-place.log. `bin/toli disk keep` and `bin/toli doctor` flag, never
// delete, folders outside those places under /tmp, $TMPDIR and the home folder that hold a `target/` or
// `node_modules/`, and every `git worktree list` entry of toli's checkout or a registered clone that toli did not make.
// The scan never opens the home folder's privacy-protected folders (Desktop, Documents, Downloads, Movies, Music,
// Pictures, Library) or an app's TemporaryItems folder: on macOS reading one raises a privacy prompt that blocks the
// reader until someone answers (T1907, T2243). Each root is walked in a process of its own (src/fleet/stray-walk.ts),
// killed past its time limit, so a folder that blocks anyway never holds `disk keep` or `doctor`.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
import type { WalkEvent, WalkJob } from "./stray-walk.ts";

/** Set to a reason, it lets a build run outside the known places (logged in logs/build-place.log). */
export const OVERRIDE_ENV = "TOLI_BUILD_PLACE_OVERRIDE";
/**
 * The file `just release --dry-run` (scripts/publish.ts) writes in its temporary clone's .git folder, holding the
 * clone's resolved path: with toli's checkout as its origin, that clone is a known place for its verify run.
 */
export const RELEASE_CLONE_MARKER = "toli-release-dry-run";
/** Colon-separated folders the stray scan reads instead of /tmp, $TMPDIR and the home folder (tests). */
const SCAN_ROOTS_ENV = "TOLI_BUILD_SCAN_ROOTS";
/** How many levels below each scan root the stray scan reads (~/code/<org>/<repo> is 3). */
const SCAN_DEPTH = 3;
/** At most this many folders are read per scan root, so a huge home folder cannot stall `doctor` or the keeper. */
const SCAN_LIMIT = 10_000;
/** At most this long is spent reading each scan root, so a slow disk cannot stall `doctor` or the keeper either. */
const SCAN_MS = 60_000;
/**
 * Past its time limit a scan root's walk stops by itself between folders; this much later it is killed, stuck in one
 * folder that never answered. Covers the walker's start too.
 */
const WALK_GRACE_MS = 5_000;
/** The stray scan's walker, run as a process of its own per scan root (src/fleet/stray-walk.ts). */
const WALKER = join(import.meta.dir, "stray-walk.ts");
/** The build folders whose presence marks a folder as a build's working tree. */
const BUILD_FOLDERS: readonly string[] = ["target", "node_modules"];
/**
 * Folders never descended into, at any depth: OS and app data on macOS, never a project checkout. An app's
 * `TemporaryItems` folder ($TMPDIR/com.apple.replayd/TemporaryItems) is privacy-protected like the ones below.
 */
const SKIPPED_FOLDERS: readonly string[] = ["Library", "TemporaryItems"];
/**
 * The home folder's own folders macOS guards with a privacy (TCC) prompt: opening one makes the system ask the user
 * whether toli's runtime may read it, and the read blocks until someone answers, which on an unattended machine is
 * never. `~/Library` (iCloud Drive included) is a SKIPPED_FOLDERS entry. Never a project checkout's place either.
 */
const HOME_PROTECTED_FOLDERS: readonly string[] = ["Desktop", "Documents", "Downloads", "Movies", "Music", "Pictures"];
/** Submodules nest; past this many superprojects the outermost one found counts. */
const MAX_SUPERPROJECTS = 8;

/** The places a build may run in, every path resolved. */
type Places = {
    /** Toli's checkout and each registered clone, with how to name it. */
    checkouts: Map<string, string>;
    /** projects/.worktrees/<project> of each registered project: its task worktrees are the folders directly in it. */
    taskWorktrees: Map<string, string>;
    /** <NM_HOME>/worktrees: no-mistakes run worktrees are <repo>/<run> below it. */
    runWorktrees: string;
    /** Toli's own checkout: the origin of the release dry run's clone. */
    toli: string;
};

/** A folder outside the known places: a build folder's owner or a worktree toli did not make, and why it is flagged. */
export type OutsideBuild = { path: string; why: string };

export type OutsideScan = { found: OutsideBuild[]; complete: boolean; unanswered: string[] };

function knownPlaces(): Places {
    const toli = real(paths.root());
    const checkouts = new Map<string, string>([[toli, "toli's checkout"]]);
    const taskWorktrees = new Map<string, string>();
    for (const project of loadProjects()) {
        checkouts.set(real(paths.projectDir(project.name)), `projects/${project.name}`);
        taskWorktrees.set(real(paths.worktreesDir(project.name)), project.name);
    }
    return { checkouts, taskWorktrees, runWorktrees: real(join(noMistakesHome(), "worktrees")), toli };
}

/** git in `dir`; main() dropped a hook's GIT_DIR and the like, so nothing steers it elsewhere. */
function gitIn(dir: string, args: string[]): string | null {
    const result = run(["git", "-C", dir, ...args]);
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

/**
 * Whether the git working tree `tree` is the release dry run's clone of toli's checkout `toli`: its own .git folder
 * holds RELEASE_CLONE_MARKER naming this very tree, and its origin is `toli`. A copy of such a clone moved elsewhere,
 * or any other clone, names another tree or another origin.
 */
function isReleaseClone(tree: string, toli: string): boolean {
    const gitDir = gitIn(tree, ["rev-parse", "--absolute-git-dir"]);
    if (gitDir === null || real(gitDir) !== join(tree, ".git")) return false;
    const marker = join(tree, ".git", RELEASE_CLONE_MARKER);
    if (!existsSync(marker) || readFileSync(marker, "utf8").trim() !== tree) return false;
    const origin = gitIn(tree, ["config", "--get", "remote.origin.url"]);
    return origin !== null && origin !== "" && real(origin) === toli;
}

/** Which known place the git working tree `tree` is, or null when it is none of them. */
function placeOf(tree: string, places: Places): string | null {
    const checkout = places.checkouts.get(tree);
    if (checkout !== undefined) return checkout;
    const project = places.taskWorktrees.get(dirname(tree));
    if (project !== undefined) return `${project}'s task worktree`;
    if (dirname(dirname(tree)) === places.runWorktrees) return "a no-mistakes run worktree";
    if (isReleaseClone(tree, places.toli)) return "the release dry run's clone";
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

/** How long each scan root's walk may read; `TOLI_BUILD_SCAN_MS` replaces SCAN_MS (tests). */
function scanMs(): number {
    const override = Number(process.env.TOLI_BUILD_SCAN_MS);
    return Number.isInteger(override) && override > 0 ? override : SCAN_MS;
}

/** What one scan root's walk found, whether it read all of it, and the folder it got stuck in, if any. */
type RootScan = { found: OutsideBuild[]; complete: boolean; unanswered: string | null };

/**
 * Walk `job.root` in a walker process (src/fleet/stray-walk.ts), killed `killAfterMs` after it starts. A walker killed
 * there, or that never reports its end, leaves the root incomplete; killed in a read it never finished, the folder it
 * was reading is the unanswered one. What it found before is kept either way.
 */
function walkRoot(job: WalkJob, killAfterMs: number): RootScan {
    const result = run([process.execPath, WALKER], { cwd: "/", stdin: JSON.stringify(job), timeoutMs: killAfterMs });
    const found: OutsideBuild[] = [];
    let reading: string | null = null;
    let end: { stopped: boolean } | null = null;
    for (const line of result.stdout.split("\n")) {
        if (line === "") continue;
        let event: WalkEvent;
        try {
            event = JSON.parse(line) as WalkEvent;
        } catch {
            continue;
        }
        if ("reading" in event) reading = event.reading;
        else if ("found" in event) {
            const builds = event.builds.map((name) => `${name}/`).join(" and ");
            found.push({ path: event.found, why: `holds ${builds} outside the clones` });
        } else end = { stopped: event.stopped };
    }
    if (end !== null) return { found, complete: !end.stopped, unanswered: null };
    return { found, complete: false, unanswered: result.timedOut ? reading : null };
}

/**
 * Folders below the scan roots, outside every known place, that hold a build folder. The home folder's protected
 * folders are never opened. Each root is walked in a process of its own, so one folder that never answers cannot hold
 * the caller: a walk reads for SCAN_LIMIT folders or the scan time at most, and is killed WALK_GRACE_MS after that.
 * A root cut short leaves the scan incomplete; a folder a walk was killed in is listed as unanswered.
 */
function strayBuildFolders(places: Places, roots: string[]): OutsideScan {
    const home = real(homedir());
    const never = [
        ...places.checkouts.keys(),
        ...places.taskWorktrees.keys(),
        places.runWorktrees,
        ...HOME_PROTECTED_FOLDERS.map((name) => join(home, name)),
    ];
    const ms = scanMs();
    const scan: OutsideScan = { found: [], complete: true, unanswered: [] };
    for (const root of roots) {
        if (insidePlace(root, places)) continue;
        const job: WalkJob = {
            root,
            never,
            skipNames: [...SKIPPED_FOLDERS],
            buildFolders: [...BUILD_FOLDERS],
            depth: SCAN_DEPTH,
            limit: SCAN_LIMIT,
            ms,
        };
        const walked = walkRoot(job, ms + WALK_GRACE_MS);
        scan.found.push(...walked.found);
        if (!walked.complete) scan.complete = false;
        if (walked.unanswered !== null) scan.unanswered.push(walked.unanswered);
    }
    return scan;
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
 * path, sorted. Read only: nothing is ever deleted. `complete` is false when the scan of a root stopped early;
 * `unanswered` lists the folders a walk was killed in, waiting on a read that never finished.
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
    return { found, complete: folders.complete, unanswered: folders.unanswered };
}

/** One line per flagged folder, for `disk keep` and `doctor`. */
export function outsideBuildLine({ path, why }: OutsideBuild): string {
    return `${path}: ${why} (AGENTS.md rule 5; toli never deletes it: land its work in the clone, then remove it)`;
}

/** What the scan left out, when it stopped early: each folder that never answered, then what that means. */
export function partialScanLines({ complete, unanswered }: OutsideScan): string[] {
    if (complete) return [];
    const ms = scanMs();
    return [
        ...unanswered.map(
            (dir) =>
                `the scan gave up on ${dir}: reading it never finished (its walk was stopped after ${(ms + WALK_GRACE_MS) / 1000} s; on macOS, a privacy prompt nobody answered)`,
        ),
        `the scan stopped early in a scan root (after ${SCAN_LIMIT} folders, ${ms / 1000} s, or at a folder that never answered), so more may exist`,
    ];
}

/** At most this many flagged folders get a `doctor` line each; `disk keep --dry-run` lists them all. */
const DOCTOR_LINES = 10;

/** `doctor`'s lines: a warning per flagged folder (the first DOCTOR_LINES), or one ok line when there are none. */
export function buildPlaceChecks(): Check[] {
    const scan = outsideBuilds();
    const { found } = scan;
    const warning = (detail: string): Check => ({ level: "warn", name: "build-place", detail });
    const checks = found.slice(0, DOCTOR_LINES).map((build) => warning(outsideBuildLine(build)));
    if (found.length > DOCTOR_LINES)
        checks.push(warning(`${found.length - DOCTOR_LINES} more: bin/toli disk keep --dry-run lists them all`));
    for (const line of partialScanLines(scan)) checks.push(warning(line));
    if (checks.length > 0) return checks;
    return [
        {
            level: "ok",
            name: "build-place",
            detail: "no build folders or worktrees outside the clones, toli's task worktrees and toli's checkout",
        },
    ];
}
