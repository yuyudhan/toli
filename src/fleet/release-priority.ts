// Release priority (docs/fleet.md "Release priority"): while a `--work release` run of a project set
// `--release-priority yes` (`bin/toli project set`) runs on this machine, a heavy build for any other project waits for
// it before joining the heavy-build slots' line (src/fleet/build-queue.ts `takeInTurn`), so it never competes with the
// release for the cores. It waits holding neither a slot nor a ticket in the line, so the release's own builds never
// queue behind it and no lock is held across the wait. Builds of the run itself (its TOLI_RUN_ID, inherited by its
// cargo, gate and push) and builds in that project's clone or task worktrees never wait; a run whose supervisor is
// gone (a crashed or killed run) holds nobody back.
import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { paths } from "../core/paths.ts";
import { pidAlive, warn } from "../core/util.ts";
import { type JawanRun, RUNNING, readRunRecords } from "../jawans/runs.ts";
import { loadProjects } from "../projects/projects.ts";

/** How often a build that gives way looks again whether the release run it waits for still runs. */
const POLL_MS = 1000;

/** `path` with its symlinks resolved, or null when it does not exist. */
export function realOrNull(path: string): string | null {
    try {
        return realpathSync(path);
    } catch {
        return null;
    }
}

/** Whether `path` (resolved) is the folder `dir` or lies inside it. */
export function within(path: string, dir: string): boolean {
    const real = realOrNull(dir);
    return real !== null && (path === real || path.startsWith(`${real}${sep}`));
}

/** The registered project whose clone or task worktree `cwd` lies in, or null. */
export function projectAt(cwd: string): string | null {
    const here = realOrNull(cwd);
    if (here === null) return null;
    const project = loadProjects().find(
        (candidate) =>
            within(here, paths.projectDir(candidate.name)) || within(here, paths.worktreesDir(candidate.name)),
    );
    return project?.name ?? null;
}

/** A release-priority project's running release run: its id and project. */
export type PriorityRelease = { id: string; project: string };

/** Whether `run` is a live `--work release` run of one of the `priority` projects: running, its supervisor alive. */
function livePriorityRelease(run: JawanRun, priority: ReadonlySet<string>): run is JawanRun & { project: string } {
    return (
        run.work === "release" &&
        run.project !== null &&
        priority.has(run.project) &&
        RUNNING.includes(run.status) &&
        run.supervisorPid !== null &&
        pidAlive(run.supervisorPid)
    );
}

/**
 * The release-priority run a heavy build started in `cwd` by this process gives way to, or null when it may go: no
 * release-priority project's release run runs, or the build is that run's own (`TOLI_RUN_ID`) or in that project's
 * clone or task worktrees. Costs one read of data/projects.json when no project has release priority.
 */
export function priorityReleaseAhead(cwd: string): PriorityRelease | null {
    const priority = new Set(
        loadProjects()
            .filter((project) => project.releasePriority === true)
            .map((project) => project.name),
    );
    if (priority.size === 0) return null;
    const own = projectAt(cwd);
    const run = readRunRecords().find(
        (candidate): candidate is JawanRun & { project: string } =>
            livePriorityRelease(candidate, priority) &&
            candidate.project !== own &&
            candidate.id !== process.env.TOLI_RUN_ID,
    );
    return run === undefined ? null : { id: run.id, project: run.project };
}

/** The one line a heavy build prints when it starts waiting for `run`. */
export function priorityReleaseText(run: PriorityRelease): string {
    return `toli: waiting for ${run.project}'s release run ${run.id} to end (release priority) before a heavy build`;
}

/**
 * Wait while a release-priority run is ahead of a build started in `cwd` (`priorityReleaseAhead`), saying once per
 * run which one it waits for. True once none is; false once `wanted` says the build is no longer needed.
 */
export async function giveWayToPriorityRelease(cwd: string, wanted: () => boolean): Promise<boolean> {
    let told: string | null = null;
    for (;;) {
        if (!wanted()) return false;
        const ahead = priorityReleaseAhead(cwd);
        if (ahead === null) return true;
        if (ahead.id !== told) warn(priorityReleaseText(ahead));
        told = ahead.id;
        await Bun.sleep(POLL_MS);
    }
}
