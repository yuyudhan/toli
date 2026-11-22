// When the release catch-up (src/projects/catch-up.ts, docs/projects.md "Release catch-up") must leave a branch for a
// later scan: a live run or native subagent works there, a queued or live run already names the release, its checkout
// holds work not on origin, or an open task already plans the merge (`standDown`). The scan and `bin/toli catch-up
// merge` both ask before they touch a branch; `bin/toli push` asks `checkoutHolder` before its pre-push check. Also how
// a catch-up merge is recognised (`catchUpMergeTag`).
import { readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { git, resolveSha } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { now } from "../core/util.ts";
import { activeRuns } from "../jawans/runs.ts";
import { namesTag, tagOwner } from "../jawans/tag-owner.ts";
import { agentState, nativeAgent, workingSubagent } from "../records/agents.ts";
import { loadBacklog } from "../records/backlog.ts";
import { briefPath, staleTaskMinutes } from "../records/stale.ts";
import { refExists } from "./base-branch.ts";
import type { CheckedOut } from "./catch-up.ts";
import type { Project } from "./projects.ts";
import { samePath } from "./workspace.ts";
import { LIVE } from "./workspace-toggle.ts";

/**
 * Who holds checkout `dir`, or null: a live `bin/toli spawn` run working in it (never the calling run, TOLI_RUN_ID;
 * a queued run works nowhere yet), or a live task's native subagent whose recorded workspace it is (never `ownTask`,
 * the task the caller acts for). The catch-up and `bin/toli push` (src/forge/forge.ts) both read it.
 */
export function checkoutHolder(dir: string, at: Date = now(), ownTask: string | null = null): string | null {
    const self = process.env.TOLI_RUN_ID;
    const live = activeRuns().find(
        (entry) => entry.id !== self && entry.status !== "queued" && samePath(entry.cwd, dir),
    );
    if (live !== undefined) return `jawan run ${live.id} works in it`;
    const grace = staleTaskMinutes();
    const task = loadBacklog().tasks.find(
        (entry) =>
            entry.id !== ownTask &&
            LIVE.includes(entry.status) &&
            entry.workspace !== undefined &&
            samePath(entry.workspace.path, dir) &&
            nativeAgent(entry) &&
            agentState(entry, at, grace).state === "live",
    );
    return task === undefined ? null : `${task.id}'s jawan ${task.agent} works in it`;
}

/**
 * Who holds `target`'s checkout, or null: a holder of the checkout itself, else of the project clone, where the
 * catch-up jawan runs (a live run of the project works there, whichever branch it is on).
 */
function targetHolder(
    target: CheckedOut,
    clone: string,
    at: Date = now(),
    ownTask: string | null = null,
): string | null {
    const own = checkoutHolder(target.dir, at, ownTask);
    if (own !== null || samePath(target.dir, clone)) return own;
    const holder = checkoutHolder(clone, at, ownTask);
    return holder === null ? null : `${relative(paths.root(), clone)}: ${holder}`;
}

/** The subject of a catch-up merge of release `tag` into `branch`. */
export function catchUpSubject(tag: string, branch: string): string {
    return `Merge ${tag} into ${branch}`;
}

const CATCH_UP_SUBJECT = /^Merge (v\d+\.\d+\.\d+) into (.+)$/;

/**
 * The release a catch-up merge into `branch` brought, when commit `sha` is one: two parents, the second the commit
 * of the vX.Y.Z tag its subject (`catchUpSubject`) names. Else null.
 */
export function catchUpMergeTag(clone: string, sha: string, branch: string): string | null {
    const shown = git(clone, ["log", "-1", "--format=%P%n%s", sha]);
    if (shown.code !== 0) return null;
    const [parents = "", subject = ""] = shown.stdout.split("\n");
    const [, second, ...more] = parents.trim().split(" ");
    const named = CATCH_UP_SUBJECT.exec(subject.trim());
    if (second === undefined || more.length > 0 || named === null || named[2] !== branch) return null;
    const tag = named[1] ?? "";
    return resolveSha(clone, `refs/tags/${tag}`) === second ? tag : null;
}

/**
 * A live native subagent working on `project` (`workingSubagent`, the signal capacity.maxRuns counts), never
 * `ownTask`'s, or null. A `bin/toli spawn` run is seen by the checkout it works in; a native subagent records none
 * unless its task has a workspace, so the catch-up stands down for the whole project while one works.
 */
function subagentHolder(project: string, at: Date, ownTask: string | null): string | null {
    const grace = staleTaskMinutes();
    const task = loadBacklog().tasks.find(
        (entry) => entry.project === project && entry.id !== ownTask && workingSubagent(entry, at, grace),
    );
    return task === undefined ? null : `${task.id}'s jawan ${task.agent} works on ${project}`;
}

/**
 * An open (queued, active or held) task of `project`, never `ownTask`, that already plans merging release `tag`, or
 * null: its title or its brief (data/projects/<p>/briefs/T<n>.md) names the tag, or a catch-up note handed it the merge
 * (`catch-up <tag>: ...`, src/projects/catch-up-merge.ts tellOwner). A held task's merge waits on the user's word, so
 * the catch-up must not make it meanwhile.
 */
function plannedMerge(project: string, tag: string, ownTask: string | null): string | null {
    const briefNames = (id: string): boolean => {
        const brief = briefPath(project, id);
        return brief !== null && namesTag(readFileSync(join(paths.root(), brief), "utf8"), tag);
    };
    const task = loadBacklog().tasks.find(
        (entry) =>
            entry.project === project &&
            entry.id !== ownTask &&
            (entry.status === "queued" || LIVE.includes(entry.status)) &&
            (namesTag(entry.title, tag) ||
                entry.notes.some((note) => note.startsWith(`catch-up ${tag}:`)) ||
                briefNames(entry.id)),
    );
    return task === undefined ? null : `${task.id} already plans merging ${tag}`;
}

/**
 * Work in `target`'s checkout that is not the catch-up's and not on origin, or null: uncommitted changes to tracked
 * files, or commits on its branch (first parents) on neither origin's copy of it nor `mainRef` (where the release
 * branch is read, src/projects/catch-up.ts mainRef), other than earlier catch-up merges (`catchUpMergeTag`). A branch
 * origin does not have is judged by its changes alone. A merge on top of such work would mix the release into
 * someone's work in progress.
 */
function foreignWork(clone: string, mainRef: string, target: CheckedOut): string | null {
    // git lists checkouts by their real paths (/private/var for /var on macOS); so is the root, to name it from there.
    const where = relative(realpathSync(paths.root()), target.dir);
    const changed = git(target.dir, ["diff", "--quiet", "HEAD", "--"]);
    if (changed.code === 1) return `uncommitted changes in ${where}`;
    if (changed.code !== 0) return `the changes in ${where} could not be read`;
    const remote = `refs/remotes/origin/${target.branch}`;
    if (!refExists(clone, remote)) return null;
    const range = ["--first-parent", `refs/heads/${target.branch}`, "--not", remote, mainRef];
    const counted = git(clone, ["rev-list", "--count", ...range]);
    const listed = git(clone, ["rev-list", ...range]);
    const shas = listed.stdout.split("\n").filter((line) => line !== "");
    if (counted.code !== 0 || listed.code !== 0 || Number(counted.stdout.trim()) !== shas.length)
        return `the commits of ${target.branch} not on origin could not be read`;
    const others = shas.filter((sha) => catchUpMergeTag(clone, sha, target.branch) === null).length;
    if (others === 0) return null;
    return `${others} commit${others === 1 ? "" : "s"} on ${target.branch} not on origin/${target.branch}`;
}

/**
 * Why the catch-up of release `tag` must leave `target` for a later scan now, or null (docs/projects.md "Release
 * catch-up"): a live run or native subagent holds its checkout or the clone (`targetHolder`), a queued or live run of
 * the clone already names the tag in its brief (`tagOwner`: one merge run per release), a native subagent works on the
 * project, an open task already plans this merge, or the checkout holds work not on origin (`mainRef`: where the
 * release branch is read). `ownTask`: the task the catch-up itself was dispatched on, if any.
 */
export function standDown(
    project: Project,
    clone: string,
    mainRef: string,
    tag: string,
    target: CheckedOut,
    at: Date,
    ownTask: string | null,
): string | null {
    return (
        targetHolder(target, clone, at, ownTask) ??
        tagOwner({ project: project.name, cwd: clone, brief: "", catchUp: tag })?.why ??
        subagentHolder(project.name, at, ownTask) ??
        plannedMerge(project.name, tag, ownTask) ??
        foreignWork(clone, mainRef, target)
    );
}
