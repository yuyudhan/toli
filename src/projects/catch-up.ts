// Release catch-up (docs/projects.md "Release catch-up"): every machine works on its projects' latest release. When
// origin's main of a project carries a new vX.Y.Z tag, this machine's scan (`bin/toli catch-up scan`, which the tick
// starts detached every SCAN_MINUTES so it never waits on the network) starts one catch-up jawan for the project
// through the normal `bin/toli spawn` path. That jawan runs `bin/toli catch-up merge` (src/projects/catch-up-merge.ts),
// which merges the tag into each long-lived branch's checkout, then runs the quick checks and pushes only what the
// merge's plan allows. The scan itself never merges, commits or pushes.
import { spawn as spawnChild } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadMachine } from "../core/config.ts";
import { currentBranch, git, isGitRepo, resolveSha } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { now, readJson, run, withLock, writeJsonAtomic } from "../core/util.ts";
import { machineDispatch } from "../fleet/dispatch.ts";
import { currentFull } from "../fleet/full.ts";
import { activeRuns } from "../jawans/runs.ts";
import { spawnJawan } from "../jawans/spawn.ts";
import { loadBacklog } from "../records/backlog.ts";
import { addInboxItem } from "../records/inbox.ts";
import { originDefault, refExists } from "./base-branch.ts";
import { standDown } from "./catch-up-hold.ts";
import { loadProjects, type Project } from "./projects.ts";
import { perTask } from "./strategy.ts";
import { gitWorktrees } from "./workspace.ts";
import { LIVE } from "./workspace-toggle.ts";

/** How often the tick starts a scan (each one fetches every project's main and tags). */
export const SCAN_MINUTES = 10;
const FETCH_TIMEOUT_MS = 120_000;
export const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

/** This CLI (not paths.toliBin(): TOLI_ROOT may point the data elsewhere, as in tests). */
const TOLI_SCRIPT = resolve(import.meta.dir, "..", "..", "bin", "toli");

/**
 * A project's last catch-up: the release it is for, the jawan run started for it, the branches already handed to a
 * run for that release (each is tried once per release; a branch found held is handed back for the next scan), and the
 * merges `catch-up merge` made for it (`merges`), the only commits `catch-up undo` may take back.
 */
export type CatchUpEntry = { tag: string; sha: string; run?: string; attempted: string[]; merges?: string[] };
type CatchUpState = { lastScan?: string; projects: Record<string, CatchUpEntry> };

/** Read-modify-write state/catch-up.json under its lock. */
export function updateCatchUpState<T>(fn: (state: CatchUpState) => T): T {
    return withLock(paths.lock("catch-up"), () => {
        const state = readJson<CatchUpState>(paths.catchUpState(), { projects: {} });
        state.projects ??= {};
        const result = fn(state);
        writeJsonAtomic(paths.catchUpState(), state);
        return result;
    });
}

/** The branch releases are tagged on: the project's `baseBranch`, else origin's default branch. */
export function releaseBranch(project: Project, clone: string): string | null {
    return project.baseBranch ?? originDefault(clone);
}

/** The newest vX.Y.Z tag merged into `ref` and the commit it tags; null when there is none. */
function latestRelease(clone: string, ref: string): { tag: string; sha: string } | null {
    const listed = git(clone, ["tag", "--merged", ref, "--list", "v*", "--sort=-v:refname"]);
    const tag = listed.stdout
        .split("\n")
        .map((line) => line.trim())
        .find((line) => RELEASE_TAG.test(line));
    const sha = tag === undefined ? null : resolveSha(clone, `refs/tags/${tag}`);
    return tag === undefined || sha === null ? null : { tag, sha };
}

/** Where the release branch `main` is read here: origin's copy when fetched, else the local branch. */
export function mainRef(clone: string, main: string): string {
    return refExists(clone, `refs/remotes/origin/${main}`) ? `refs/remotes/origin/${main}` : `refs/heads/${main}`;
}

/**
 * Why `target` gets no catch-up though it lacks the release (`release`: the tagged commit), or null: every commit on
 * it is already on the release branch (an ancestor of `main`'s ref or of the release), so its work has landed and
 * merging the release would only bring main into a finished branch.
 */
export function landedSkip(clone: string, main: string, release: string, target: Target): string | null {
    const tip = resolveSha(clone, `refs/heads/${target.branch}`);
    if (tip === null) return null;
    const ref = mainRef(clone, main);
    const landed = [ref, release].some((into) => git(clone, ["merge-base", "--is-ancestor", tip, into]).code === 0);
    return landed ? `skipped: already on ${ref.replace(/^refs\/(remotes|heads)\//, "")} (${tip.slice(0, 12)})` : null;
}

/** A long-lived branch of the project on this machine: where it is checked out, and the live task it belongs to. */
export type Target = { branch: string; dir: string | null; task: string | null };
/** A target whose branch is checked out on this machine: the only kind a catch-up jawan is handed. */
export type CheckedOut = Target & { dir: string };

/**
 * The branches a release catches up here, never `main` itself: the project's fixed `branch` (a same-branch project
 * without one: the branch its clone is on), then the branch of each live (active or held) task of the project.
 */
export function catchUpTargets(project: Project, clone: string, main: string): Target[] {
    const worktrees = gitWorktrees(clone);
    const targets = new Map<string, Target>();
    const add = (branch: string | null | undefined, task: string | null): void => {
        if (!branch || branch === main || targets.has(branch) || !refExists(clone, `refs/heads/${branch}`)) return;
        const dir = worktrees.find((entry) => entry.branch === branch)?.path ?? null;
        targets.set(branch, { branch, dir, task });
    };
    add(project.branch ?? (perTask(project.workspace) ? null : currentBranch(clone)), null);
    for (const task of loadBacklog().tasks)
        if (task.project === project.name && LIVE.includes(task.status)) add(task.workspace?.branch, task.id);
    return [...targets.values()];
}

/** The catch-up jawan's brief for `targets`, written to the project's briefs; returns its path. */
function writeBrief(
    project: Project,
    release: { tag: string; sha: string },
    main: string,
    targets: CheckedOut[],
): string {
    const name = project.name;
    const file = join(paths.projectBriefsDir(name), `catch-up-${release.tag}.md`);
    const notes = relative(paths.root(), paths.projectNotes(name));
    const checks =
        project.catchUpChecks === undefined
            ? `the quick checks ${notes} names (format, lint, guards; never a full build or test suite)`
            : `\`${project.catchUpChecks}\``;
    const branches = targets.map(
        (target) => `- ${target.branch}${target.task === null ? "" : ` (${target.task})`}: ${target.dir}`,
    );
    mkdirSync(paths.projectBriefsDir(name), { recursive: true });
    writeFileSync(
        file,
        [
            "TOLI_BRIEF v1",
            "",
            `# Catch-up: merge ${name} ${release.tag} into this machine's long-lived branches`,
            "",
            `${name}'s origin/${main} carries the new release ${release.tag} (${release.sha}). The standing rule: every`,
            "machine works on the latest release. toli's release catch-up started this run (docs/projects.md",
            '"Release catch-up").',
            "",
            "## Goal",
            "",
            `- Objective: every branch below contains ${release.tag}, or the report says why not.`,
            `- Validate: \`bin/toli catch-up merge ${name} --tag ${release.tag}\` reports each branch merged, up to date,`,
            "  held, in conflict or refused.",
            "- Stop when: each branch is merged (and pushed where the plan says), skipped, or reported.",
            "",
            "## Branches",
            "",
            ...branches,
            "",
            "## Steps",
            "",
            `1. Run \`bin/toli catch-up merge ${name} --tag ${release.tag}\` (dispatched on a task, add \`--task <T-id>\`).`,
            `   It merges ${release.tag} into each branch's checkout through \`bin/toli commit\`'s \`--merge\`, skips a`,
            "   checkout another live jawan holds, one with work not on origin, one an open task already plans this merge",
            "   for, or one no longer on its branch (the next scan retries it), and refuses a conflict without touching",
            "   the work (the task gets a note).",
            `2. Only in a checkout it reports merged, run ${checks}. Heavy commands go under \`bin/toli build-slot --\`.`,
            "   A failure: run that branch's `if the checks fail` line, its `undo` line, which takes back only that merge",
            "   and leaves the checkout as the merge found it, and report the output of both. A branch it did not merge",
            "   gets no check, build or push here.",
            "3. Push only a branch the plan prints a `push` line for, with exactly that command, after its checks",
            "   passed: it names the branch (`--branch`) and refuses when the checkout is on any other. Never",
            "   --no-verify, never --force, never main, never a branch not already on origin.",
            "4. Report the tag and, per branch: merged sha, up to date, skipped or held, conflict files, checks, pushed,",
            "   kept local or undone, and why.",
            "",
            "Do nothing else: no other branch, no rebase, reset (but the `undo` line), stash or conflict resolution; a",
            "conflict stays with its owner.",
            "",
        ].join("\n"),
    );
    return file;
}

/**
 * Hand `targets` to one catch-up jawan: spawned (queued while every slot is busy), or, where jawans run only as the
 * interactive Sardar's subagents (`lead.dispatch` "subagents"), posted to the lead's inbox to dispatch.
 */
function startCatchUp(
    project: Project,
    release: { tag: string; sha: string },
    main: string,
    targets: CheckedOut[],
): { run: string | undefined; line: string } {
    const brief = writeBrief(project, release, main, targets);
    if (machineDispatch() === "subagents") {
        addInboxItem(
            loadMachine().name,
            `catch-up ${project.name} ${release.tag}`,
            `${project.name} released ${release.tag}. Dispatch the catch-up jawan brief ${relative(paths.root(), brief)} as a subagent (lead.dispatch is "subagents"); recorded on a task, its \`catch-up merge\` takes \`--task <T-id>\`.`,
        );
        return { run: undefined, line: "brief posted to the lead's inbox to dispatch" };
    }
    const started = spawnJawan({ briefPath: brief, project: project.name, work: "ship", tier: "light" });
    return { run: started.id, line: `catch-up run ${started.id} (${started.status})` };
}

/** One project's scan: fetch its main and tags, then start a catch-up for the branches behind the newest release. */
function scanProject(project: Project, fetch: boolean, at: Date): string[] {
    const name = project.name;
    if (project.catchUp === false) return [`${name}: catch-up is off (on with --catch-up default)`];
    const clone = paths.projectDir(name);
    if (!isGitRepo(clone)) return [`${name}: not cloned on this machine`];
    const main = releaseBranch(project, clone);
    if (main === null) return [`${name}: no release branch known (bin/toli project set ${name} --base-branch <b>)`];
    const lines: string[] = [];
    if (fetch) {
        const spec = `+refs/heads/${main}:refs/remotes/origin/${main}`;
        const fetched = run(["git", "-C", clone, "fetch", "--quiet", "--tags", "origin", spec], {
            timeoutMs: FETCH_TIMEOUT_MS,
            env: { GIT_TERMINAL_PROMPT: "0" },
        });
        if (fetched.code !== 0)
            lines.push(`${name}: git fetch origin ${main} failed (${(fetched.stderr || fetched.stdout).trim()})`);
    }
    const ref = mainRef(clone, main);
    const release = latestRelease(clone, ref);
    if (release === null) return [...lines, `${name}: no vX.Y.Z tag on origin/${main}`];
    const label = `${name}: ${release.tag} (${release.sha.slice(0, 12)})`;
    return updateCatchUpState((state) => {
        const previous = state.projects[name];
        const live = previous?.run === undefined ? undefined : activeRuns().find((entry) => entry.id === previous.run);
        if (live !== undefined) return [...lines, `${label}: catch-up run ${live.id} is still ${live.status}`];
        const entry: CatchUpEntry =
            previous?.tag === release.tag ? previous : { tag: release.tag, sha: release.sha, attempted: [] };
        state.projects[name] = entry;
        const lagging = catchUpTargets(project, clone, main).filter(
            (target) =>
                git(clone, ["merge-base", "--is-ancestor", release.sha, `refs/heads/${target.branch}`]).code !== 0,
        );
        if (lagging.length === 0) return [...lines, `${label}: every long-lived branch has it`];
        const open = lagging.filter((target) => {
            const skip = landedSkip(clone, main, release.sha, target);
            if (skip !== null) lines.push(`${label}: ${target.branch}: ${skip}`);
            return skip === null;
        });
        if (open.length === 0) return lines;
        const behind = open.filter((target) => !entry.attempted.includes(target.branch));
        if (behind.length === 0)
            return [
                ...lines,
                `${label}: ${open.map((target) => target.branch).join(", ")} already had a catch-up for this release (see its report)`,
            ];
        const ready: CheckedOut[] = [];
        for (const target of behind) {
            if (target.dir === null) {
                const on = currentBranch(clone) ?? "a detached HEAD";
                lines.push(
                    `${label}: ${target.branch}: skipped: not checked out here (${relative(paths.root(), clone)} is on ${on}), tried again next scan`,
                );
                continue;
            }
            const checkedOut = { ...target, dir: target.dir };
            const holder = standDown(project, clone, ref, release.tag, checkedOut, at, null);
            if (holder === null) ready.push(checkedOut);
            else lines.push(`${label}: ${target.branch}: held (${holder}), tried again next scan`);
        }
        if (ready.length === 0) return lines;
        if (currentFull() !== null) return [...lines, `${label}: this machine is marked full; tried again next scan`];
        const started = startCatchUp(project, release, main, ready);
        if (started.run === undefined) delete entry.run;
        else entry.run = started.run;
        entry.attempted.push(...ready.map((target) => target.branch));
        return [...lines, `${label}: ${started.line} for ${ready.map((target) => target.branch).join(", ")}`];
    });
}

/** `catch-up scan [<project>]`: every registered project (or the one named), each failure its own line. */
export function scanCatchUp(options: { project?: string; fetch: boolean; at?: Date }): string[] {
    const at = options.at ?? now();
    const projects = loadProjects().filter((entry) => options.project === undefined || entry.name === options.project);
    return projects.flatMap((project) => {
        try {
            return scanProject(project, options.fetch, at);
        } catch (error) {
            return [`${project.name}: catch-up scan failed: ${error instanceof Error ? error.message : String(error)}`];
        }
    });
}

/**
 * Called by the tick: when a scan is due (none started in the last SCAN_MINUTES) and some cloned project has
 * catch-up on, start `bin/toli catch-up scan` detached (output in logs/catch-up.log) and return at once.
 */
export function startDueCatchUpScan(at: Date = now()): string | null {
    const any = loadProjects().some((entry) => entry.catchUp !== false && isGitRepo(paths.projectDir(entry.name)));
    if (!any) return null;
    const due = updateCatchUpState((state) => {
        const last = state.lastScan === undefined ? Number.NaN : Date.parse(state.lastScan);
        if (Number.isFinite(last) && at.getTime() - last < SCAN_MINUTES * 60_000) return false;
        state.lastScan = at.toISOString();
        return true;
    });
    if (!due) return null;
    mkdirSync(paths.logsDir(), { recursive: true });
    const log = openSync(paths.catchUpLog(), "a");
    try {
        writeSync(log, `${at.toISOString()} catch-up scan started by the tick\n`);
        const child = spawnChild(process.execPath, [TOLI_SCRIPT, "catch-up", "scan"], {
            cwd: paths.root(),
            detached: true,
            stdio: ["ignore", log, log],
            env: process.env,
        });
        child.unref();
        return `catch-up scan: started in the background (pid ${child.pid ?? "unknown"}, log ${paths.catchUpLog()})`;
    } finally {
        closeSync(log);
    }
}
