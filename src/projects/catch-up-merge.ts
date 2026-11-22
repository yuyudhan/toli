// `bin/toli catch-up merge <project> --tag <vX.Y.Z>`, run by the release catch-up jawan (src/projects/catch-up.ts):
// merge the tagged release into each long-lived branch's checkout on this machine through `bin/toli commit`'s
// `--merge` (safeCommit), and print the plan the jawan follows next: the quick checks to run and, per branch, either
// the one push command it may run after them (naming the branch, so it refuses a checkout on any other) or why the
// merge stays local, and the `catch-up undo` line that takes the merge back should the checks fail. It never pushes.
// A conflict is found with `git merge-tree` before anything is written, so the work is never touched; the branch's
// task gets a note. A checkout not on its branch, one another live jawan holds (it or the project clone), one with work
// not on origin, or one an open task already plans the merge for (`standDown`) is skipped and handed back to the next
// scan. Also `bin/toli catch-up scan`.
import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { Args } from "../core/args.ts";
import { currentBranch, git, nulPaths, resolveSha } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { now, out, printJson, ToliError } from "../core/util.ts";
import { updateTask } from "../records/backlog.ts";
import { refExists } from "./base-branch.ts";
import {
    catchUpTargets,
    landedSkip,
    mainRef,
    RELEASE_TAG,
    releaseBranch,
    scanCatchUp,
    type Target,
    updateCatchUpState,
} from "./catch-up.ts";
import { catchUpMergeTag, catchUpSubject, standDown } from "./catch-up-hold.ts";
import { safeCommit } from "./commit.ts";
import { hookLimit } from "./commit-hooks.ts";
import { findProject, type Project, projectCloneDir } from "./projects.ts";

/**
 * What became of one branch. `push`: the one command the jawan may run once the checks passed; `keepLocal`: why the
 * merge stays on this machine; `undo`: the command that takes the merge back should the checks fail. All are set only
 * for a branch merged now.
 */
export type CatchUpOutcome = Target & {
    result: "up to date" | "landed" | "not checked out" | "held" | "conflict" | "refused" | "merged";
    detail: string;
    merged?: string;
    checks?: string;
    push?: string;
    keepLocal?: string;
    undo?: string;
};

/** The placeholders a `--catch-up-trailer` may use, filled in per merge. */
export const TRAILER_FIELDS = ["tag", "base", "branch"] as const;
type TrailerFields = Record<(typeof TRAILER_FIELDS)[number], string>;
const TRAILER_PLACEHOLDER = new RegExp(`\\{(${TRAILER_FIELDS.join("|")})\\}`, "g");

/**
 * The catch-up merge's message: the subject, then the project's trailer line (if set) with its placeholders filled in,
 * so a commit-msg hook that demands a trailer on such a merge sees it. The hook still runs and judges the message.
 */
function catchUpMessage(project: Project, fields: TrailerFields): string {
    const subject = catchUpSubject(fields.tag, fields.branch);
    if (project.catchUpTrailer === undefined) return subject;
    const trailer = project.catchUpTrailer.replace(TRAILER_PLACEHOLDER, (_, key: keyof TrailerFields) => fields[key]);
    return `${subject}\n\n${trailer}`;
}

/** origin's branch names (`git ls-remote --heads`), or null when origin cannot be read. */
function originBranches(clone: string): Set<string> | null {
    const listed = git(clone, ["ls-remote", "--heads", "origin"]);
    if (listed.code !== 0) return null;
    return new Set(
        listed.stdout
            .split("\n")
            .map((line) => line.split(/\s+/)[1] ?? "")
            .filter((ref) => ref.startsWith("refs/heads/"))
            .map((ref) => ref.slice("refs/heads/".length)),
    );
}

/** Note on the branch's task why its catch-up did not land, so its owner merges the release before the next push. */
function tellOwner(project: string, target: Target, tag: string, why: string): void {
    if (target.task === null) return;
    const task = target.task;
    updateTask(task, (entry) => {
        entry.notes.push(
            `catch-up ${tag}: merging it into ${target.branch} ${why}; nothing was merged and the work is as it was. ` +
                `Merge ${tag} into it (bin/toli commit ${project} --task ${task} --merge ${tag}) before its next push.`,
        );
    });
}

/** Push or keep local, for a branch merged now. */
function pushPlan(project: Project, target: Target, remote: Set<string> | null): { push?: string; keepLocal?: string } {
    if (remote === null) return { keepLocal: "origin could not be read, so whether the branch is on it is unknown" };
    if (!remote.has(target.branch)) return { keepLocal: `${target.branch} is not on origin` };
    if (project.catchUpPush === false)
        return {
            keepLocal: `catch-up pushes are off for ${project.name} on this machine (--catch-up-push no: its push gate is too heavy here); the branch takes the release at its next push or landing`,
        };
    if (project.standing?.push !== true)
        return {
            keepLocal: `no standing push grant for ${project.name} (bin/toli project set ${project.name} --standing-push yes, on the user's word)`,
        };
    const task = target.task === null ? "" : ` --task ${target.task}`;
    return { push: `bin/toli push ${project.name} --branch ${target.branch}${task}` };
}

function mergeTarget(
    project: Project,
    clone: string,
    release: { tag: string; sha: string; base: string },
    target: Target,
    remote: Set<string> | null,
    ownTask: string | null,
): CatchUpOutcome {
    const { tag, sha, base } = release;
    const head = `refs/heads/${target.branch}`;
    const outcome = (result: CatchUpOutcome["result"], detail: string): CatchUpOutcome => ({
        ...target,
        result,
        detail,
    });
    if (git(clone, ["merge-base", "--is-ancestor", sha, head]).code === 0)
        return outcome("up to date", `up to date (has ${tag})`);
    const landed = landedSkip(clone, base, sha, target);
    if (landed !== null) return outcome("landed", `${landed}; nothing merged`);
    if (target.dir === null || currentBranch(target.dir) !== target.branch)
        return outcome("not checked out", "not checked out on this machine; nothing merged");
    const holder = standDown(project, clone, mainRef(clone, base), tag, { ...target, dir: target.dir }, now(), ownTask);
    if (holder !== null) return outcome("held", holder);
    const tried = git(clone, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", head, sha]);
    if (tried.code === 1) {
        const conflicts = [...new Set(nulPaths(tried.stdout).slice(1))].join(", ");
        tellOwner(project.name, target, tag, `conflicts in ${conflicts}`);
        return outcome("conflict", `conflict in ${conflicts}: nothing merged, the work left as it was`);
    }
    try {
        const committed = safeCommit({
            dir: target.dir,
            paths: [],
            merge: sha,
            message: catchUpMessage(project, { tag, base, branch: target.branch }),
            hookLimit: hookLimit(project.name),
        });
        return {
            ...outcome("merged", `merged ${tag} as ${committed.sha.slice(0, 12)}`),
            merged: committed.sha,
            checks:
                project.catchUpChecks ??
                `the quick checks ${relative(paths.root(), paths.projectNotes(project.name))} names`,
            ...pushPlan(project, target, remote),
            undo: `bin/toli catch-up undo ${project.name} --branch ${target.branch} --merge ${committed.sha.slice(0, 12)}`,
        };
    } catch (error) {
        if (!(error instanceof ToliError)) throw error;
        tellOwner(project.name, target, tag, `was refused (${error.message})`);
        // A commit-msg hook that demands a trailer on such a merge is met by the project's setting, never bypassed.
        const hint =
            project.catchUpTrailer === undefined && error.message.includes("commit-msg hook")
                ? `; if the hook needs a trailer line on this merge: bin/toli project set ${project.name} --catch-up-trailer '<Key>: <text>'`
                : "";
        return outcome("refused", `${error.message}; the work left as it was${hint}`);
    }
}

/**
 * Merge release `tag` into every long-lived branch of `name` on this machine; a branch found held or not checked out
 * goes back to the scan. `ownTask`: the task this catch-up was dispatched on, whose own jawan never holds it. Each
 * merge made is recorded in state/catch-up.json, the only commits `undoMerge` takes back.
 */
export function mergeRelease(name: string, tag: string, ownTask: string | null = null): CatchUpOutcome[] {
    if (!RELEASE_TAG.test(tag)) throw new ToliError(`--tag must be a release tag vX.Y.Z, got "${tag}"`);
    const project = findProject(name);
    const clone = projectCloneDir(name);
    const sha = resolveSha(clone, `refs/tags/${tag}`);
    if (sha === null)
        throw new ToliError(`projects/${name} has no tag ${tag} (bin/toli catch-up scan ${name} fetches)`);
    const main = releaseBranch(project, clone);
    if (main === null) throw new ToliError(`no release branch known for ${name} (project set --base-branch <b>)`);
    const remote = originBranches(clone);
    const outcomes = catchUpTargets(project, clone, main).map((target) =>
        mergeTarget(project, clone, { tag, sha, base: main }, target, remote, ownTask),
    );
    const handBack = outcomes
        .filter((entry) => entry.result === "held" || entry.result === "not checked out")
        .map((entry) => entry.branch);
    const merges = outcomes.flatMap((entry) => (entry.merged === undefined ? [] : [entry.merged]));
    updateCatchUpState((state) => {
        const known = state.projects[name];
        const entry = known?.tag === tag ? known : { tag, sha, attempted: [] };
        state.projects[name] = entry;
        entry.attempted = entry.attempted.filter((branch) => !handBack.includes(branch));
        if (merges.length > 0) entry.merges = [...(entry.merges ?? []), ...merges];
    });
    return outcomes;
}

/**
 * `catch-up undo <project> --branch <b> --merge <sha>`: take back a catch-up merge whose checks failed, leaving the
 * checkout as the merge found it. Only a merge this machine's catch-up recorded making for the project's current
 * release, that is still the branch's tip (nothing on top), not on origin's copy of the branch, in a checkout on that
 * branch: the branch moves back to the merge's first parent with `git reset --keep`, which refuses rather than lose a
 * change in the work tree. The branch's task gets a note. Any other commit is never touched.
 */
export function undoMerge(name: string, branch: string, merge: string): string {
    const project = findProject(name);
    const clone = projectCloneDir(name);
    const sha = resolveSha(clone, merge);
    if (sha === null) throw new ToliError(`refusing: no commit ${merge} in projects/${name}; nothing undone`);
    const short = sha.slice(0, 12);
    const recorded = updateCatchUpState((state) => state.projects[name]?.merges?.includes(sha) === true);
    const tag = catchUpMergeTag(clone, sha, branch);
    if (!recorded || tag === null)
        throw new ToliError(
            `refusing: ${short} is not a merge this machine's catch-up made into ${branch}; nothing undone`,
        );
    const main = releaseBranch(project, clone);
    const target = main === null ? undefined : catchUpTargets(project, clone, main).find((t) => t.branch === branch);
    if (target === undefined || target.dir === null || currentBranch(target.dir) !== branch)
        throw new ToliError(`refusing: ${branch} is not checked out on this machine; nothing undone`);
    const tip = resolveSha(clone, `refs/heads/${branch}`);
    if (tip !== sha)
        throw new ToliError(
            `refusing: ${branch} has moved past the catch-up merge ${short} (now at ${tip?.slice(0, 12) ?? "nothing"}); nothing undone, the merge stays with its owner`,
        );
    const remote = `refs/remotes/origin/${branch}`;
    if (refExists(clone, remote) && git(clone, ["merge-base", "--is-ancestor", sha, remote]).code === 0)
        throw new ToliError(`refusing: the catch-up merge ${short} is on origin/${branch} already; nothing undone`);
    const parent = resolveSha(clone, `${sha}^1`);
    if (parent === null) throw new ToliError(`refusing: ${short} has no first parent; nothing undone`);
    const reset = git(target.dir, ["reset", "--quiet", "--keep", parent]);
    if (reset.code !== 0)
        throw new ToliError(
            `refusing: git reset --keep ${parent.slice(0, 12)} would lose changes in ${relative(realpathSync(paths.root()), target.dir)} (${(reset.stderr || reset.stdout).trim()}); nothing undone`,
        );
    updateCatchUpState((state) => {
        const entry = state.projects[name];
        if (entry?.merges !== undefined) entry.merges = entry.merges.filter((made) => made !== sha);
    });
    tellOwner(name, target, tag, `failed its checks, so the catch-up undid its merge ${short}`);
    return `${branch}: undid the catch-up merge ${short}; back at ${parent.slice(0, 12)}, as the merge found it`;
}

function outcomeText(entry: CatchUpOutcome): string[] {
    if (entry.result !== "merged" && entry.result !== "conflict" && entry.result !== "refused")
        return [
            `${entry.branch}: ${entry.result === "held" ? `held (${entry.detail}), tried again next scan` : entry.detail}`,
        ];
    const where = [entry.task, entry.dir].filter((part) => part !== null).join(", ");
    return [
        `${entry.branch} (${where}): ${entry.detail}`,
        ...(entry.checks === undefined ? [] : [`  checks: ${entry.checks}`]),
        ...(entry.push === undefined ? [] : [`  push (after the checks pass): ${entry.push}`]),
        ...(entry.keepLocal === undefined ? [] : [`  keep local: ${entry.keepLocal}`]),
        ...(entry.undo === undefined ? [] : [`  if the checks fail: ${entry.undo}`]),
    ];
}

const USAGE =
    "usage: toli catch-up scan [<project>] [--no-fetch] | merge <project> --tag <vX.Y.Z> [--task <T-id>] [--json] | undo <project> --branch <b> --merge <sha>";

/** `toli catch-up scan [<project>] [--no-fetch]` | `merge ...` | `undo ...` (USAGE). */
export function catchUpCommand(argv: string[]): number {
    const [sub, ...rest] = argv;
    if (sub === "scan") {
        const args = new Args(rest, { booleans: ["no-fetch"] });
        args.maxPositional(1);
        const project = args.positional[0];
        if (project !== undefined) findProject(project);
        const lines = scanCatchUp({ fetch: !args.bool("no-fetch"), ...(project === undefined ? {} : { project }) });
        out(lines.length === 0 ? "no projects registered" : lines.join("\n"));
        return 0;
    }
    if (sub === "merge") {
        const args = new Args(rest, { values: ["tag", "task"], booleans: ["json"] });
        args.maxPositional(1);
        const tag = args.str("tag");
        if (tag === undefined) throw new ToliError("catch-up merge needs --tag <vX.Y.Z>");
        const outcomes = mergeRelease(args.pos(0, "project"), tag, args.str("task") ?? process.env.TOLI_TASK ?? null);
        if (args.bool("json")) printJson(outcomes);
        else out(outcomes.length === 0 ? "no long-lived branch here" : outcomes.flatMap(outcomeText).join("\n"));
        return 0;
    }
    if (sub === "undo") {
        const args = new Args(rest, { values: ["branch", "merge"] });
        args.maxPositional(1);
        const branch = args.str("branch");
        const merge = args.str("merge");
        if (branch === undefined || merge === undefined)
            throw new ToliError("catch-up undo needs --branch <b> --merge <sha>");
        out(undoMerge(args.pos(0, "project"), branch, merge));
        return 0;
    }
    throw new ToliError(USAGE);
}
