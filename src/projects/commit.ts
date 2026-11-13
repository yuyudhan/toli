// `bin/toli commit` (R23): safe commits in a checkout many jawans share, without worktrees or tree copies.
//
// Each attempt reads the branch tip once (`old`), builds a private temporary index from it (GIT_INDEX_FILE), stages
// only the named paths and/or applies a patch of hunks, checks the staged set (it changes only the named paths, has
// no leaks, every staged lock file parses, it does not revert a recent commit), runs the project's commit-msg hook on
// that private index (pre-commit hooks are skipped, see `commitMsgHook`), writes the commit with `commit-tree` on
// `old`, and moves the branch with `update-ref <branch> <new> <old>`, which fails if the branch moved meanwhile.
// One retry rebuilds everything from the fresh tip; a second move is a refusal. The shared index and other jawans'
// staged or unstaged changes are never read, so a stale shared index can no longer revert anyone's commits.
// `--merge <ref>` starts the private index from the clean `git merge-tree` result instead and adds `<ref>` as second
// parent; the files the merge brought are then checked out into the shared index and working tree. A conflicted merge
// is refused unless `--resolved`: then the named working-tree files replace merge-tree's conflicted ones, every
// conflicted path must be named and marker-free, and the usual checks run on the result. A named path the merge
// conflicts on or changes that is in neither the working tree nor the merge result is resolved by deleting it.
// A `git merge` in progress (MERGE_HEAD) must be landed with `--merge <its sha>`: the commit then adopts it (merged
// files not named must match the merge result in the working tree, named ones may change it) and ends it with
// `git merge --quit`. Any other commit is refused while it is in progress, since it would drop the merged parent.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Args } from "../core/args.ts";
import { currentBranch, git, gitOk, headSha } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { persona } from "../core/persona.ts";
import { out, ToliError, warn } from "../core/util.ts";
import { DEVELOP_BRANCH } from "../release/release.ts";
import { activeRuntime, syncRuntime } from "../release/runtime.ts";
import {
    Attempt,
    absentPaths,
    applyPatches,
    checkLockFiles,
    checkResolved,
    checkReverts,
    commitMsgHook,
    parseHunks,
    scanLeaks,
} from "./commit-checks.ts";
import { adoptsMerge, cleanMerge } from "./commit-merge.ts";
import { findProject, projectCloneDir, toliSelfCheckout } from "./projects.ts";
import { perTask } from "./strategy.ts";
import { refExists, samePath, workDir } from "./workspace.ts";

// Word boundaries keep human sign-offs such as "<dev@gmail.com>" (contains "ai") intact.
const AI_TRAILER = /^(Co-authored-by|Co-Authored-By|Generated-by|Signed-off-by: .*\b(Claude|GPT|AI|omp|Oh My Pi)\b).*/i;

/** Remove AI attribution trailer lines, then trailing blank lines. */
export function stripAiTrailers(message: string): string {
    const lines = message.split(/\r?\n/).filter((line) => !AI_TRAILER.test(line.trim()));
    while (lines.length > 0 && (lines[lines.length - 1] as string).trim() === "") lines.pop();
    return lines.join("\n");
}

export type CommitRequest = {
    /** The checkout to commit in; its checked-out branch moves. */
    dir: string;
    /** Paths (relative to `dir`) whose working-tree state is committed whole, deletions included. */
    paths: string[];
    /** Unified diffs (`git diff` output) whose hunks are committed, applied in order; the working tree is not read for them. */
    patches?: CommitPatch[];
    message: string;
    /** Commits (sha prefixes) this commit may revert on purpose. */
    allowRevert?: string[];
    /** A ref to merge: the commit gets it as second parent and starts from the clean merge result of the two. */
    merge?: string;
    /**
     * The merge's conflicts are resolved in the working tree: every conflicted path must be among `paths`, free of
     * conflict markers. Without it a conflicted merge is refused.
     */
    resolved?: boolean;
};

/** One `--patch` file: its name as given (for errors) and its diff. */
export type CommitPatch = { name: string; diff: string };

/** `files`: every path changed against the first parent; `merged`: those the merge brought in (not named). */
export type Committed = {
    sha: string;
    branch: string;
    parent: string;
    files: string[];
    merged: string[];
    attempts: number;
};

/** Test seam: runs after the commit object is written and before the branch moves. */
export type CommitHooks = { beforeUpdateRef?: (attempt: number) => void };

function attemptCommit(
    request: CommitRequest,
    attemptNo: number,
    hooks: CommitHooks,
    adopted: boolean,
): Committed | null {
    const { dir } = request;
    const branch = currentBranch(dir);
    if (branch === null) throw new ToliError(`refusing: ${dir} is on a detached HEAD; commit on a branch`);
    const ref = `refs/heads/${branch}`;
    const parent = headSha(dir, ref);
    const merge =
        request.merge === undefined
            ? null
            : cleanMerge(dir, parent, request.merge, {
                  resolved: request.resolved === true,
                  named: request.paths,
                  adopted,
              });
    // The named paths and patch apply on top of the merge result; the merge itself needs no naming, except the
    // conflicted paths of a resolved merge, whose working-tree versions replace merge-tree's conflict markers.
    const start = merge?.tree ?? parent;
    const attempt = new Attempt(dir);
    try {
        attempt.gitOk(["read-tree", start]);
        const deleted = absentPaths(attempt, request.paths, merge);
        const added = request.paths.filter((file) => !deleted.includes(file));
        if (added.length > 0) attempt.gitOk(["add", "--all", "--", ...added]);
        const fromPatch = applyPatches(attempt, request.patches ?? []);
        const tree = attempt.gitOk(["write-tree"]);
        const files = gitOk(dir, ["diff", "--name-only", "--no-renames", parent, tree]).split("\n").filter(Boolean);
        if (files.length === 0 && merge === null)
            throw new ToliError(`nothing to commit: the named paths match ${branch} (${parent.slice(0, 12)})`);
        const own = gitOk(dir, ["diff", "--name-only", "--no-renames", start, tree]).split("\n").filter(Boolean);
        const named = new Set(
            own.length === 0
                ? []
                : gitOk(dir, ["diff", "--name-only", "--no-renames", start, tree, "--", ...request.paths, ...fromPatch])
                      .split("\n")
                      .filter(Boolean),
        );
        const stray = own.filter((file) => !named.has(file));
        if (stray.length > 0)
            throw new ToliError(`refusing: the staged set changes paths that were not named: ${stray.join(", ")}`);
        const conflicts = merge?.conflicts ?? [];
        const overlap =
            merge === null || merge.adopted
                ? []
                : own.filter(
                      (file) =>
                          merge.files.includes(file) && !conflicts.includes(file) && !merge.regenerated.includes(file),
                  );
        if (overlap.length > 0)
            throw new ToliError(
                `refusing: ${overlap.join(", ")} changed by both the merge and the named paths; commit the merge first, then your edits`,
            );
        if (conflicts.length > 0) {
            const listed = new Set(
                request.paths.length === 0
                    ? []
                    : attempt
                          .gitOk(["ls-files", "--", ...request.paths])
                          .split("\n")
                          .filter(Boolean),
            );
            checkResolved(attempt, conflicts, (file) => named.has(file) || listed.has(file) || deleted.includes(file));
        }
        scanLeaks(attempt);
        checkLockFiles(attempt, files);
        // Only the committer's own changes on top of the merge result can revert; what the merged ref brings cannot,
        // including the ref's own hunks a conflict resolution kept as they are.
        const brought =
            merge === null || conflicts.length === 0
                ? []
                : parseHunks(
                      gitOk(dir, [
                          "diff",
                          "-U0",
                          "--no-color",
                          "--no-ext-diff",
                          "--no-renames",
                          gitOk(dir, ["merge-base", parent, merge.commit]),
                          merge.commit,
                          "--",
                          ...conflicts,
                      ]),
                  );
        checkReverts(dir, parent, tree, own, request.allowRevert ?? [], brought);
        const message = commitMsgHook(attempt, request.message);
        const parents = ["-p", parent, ...(merge === null ? [] : ["-p", merge.commit])];
        const created = git(dir, ["commit-tree", tree, ...parents, "-F", "-"], `${message}\n`);
        if (created.code !== 0)
            throw new ToliError(`git commit-tree failed: ${(created.stderr || created.stdout).trim()}`);
        const sha = created.stdout.trim();
        hooks.beforeUpdateRef?.(attemptNo);
        const moved = git(dir, ["update-ref", "-m", `toli commit: ${message.split("\n")[0]}`, ref, sha, parent]);
        if (moved.code !== 0) return null;
        // A path the merge touches that ends as in `parent` (a conflict resolved by deleting it) has nothing to check out.
        const merged = merge?.files.filter((file) => files.includes(file)) ?? [];
        return { sha, branch, parent, files, merged, attempts: attemptNo };
    } finally {
        attempt.dispose();
    }
}

/**
 * Commit the named paths and/or patch hunks (and/or a clean merge) onto the branch checked out in `request.dir` (see
 * the file comment). Throws a ToliError on every refusal; the branch, the shared index and the working tree are then
 * untouched.
 */
export function safeCommit(request: CommitRequest, hooks: CommitHooks = {}): Committed {
    if (request.paths.length === 0 && (request.patches ?? []).length === 0 && request.merge === undefined)
        throw new ToliError(
            'commit needs paths after -- or --patch <file>: toli commit <project> -m "..." -- <path>...',
        );
    if (request.resolved === true && request.merge === undefined)
        throw new ToliError("--resolved goes with --merge <ref>: it commits a merge whose conflicts you resolved");
    const adopted = adoptsMerge(request.dir, request.merge);
    for (let attemptNo = 1; attemptNo <= 2; attemptNo++) {
        const committed = attemptCommit(request, attemptNo, hooks, adopted);
        if (committed === null) {
            if (attemptNo === 1) warn("toli: the branch moved while committing; retrying once from its new tip");
            continue;
        }
        // The adopted `git merge` is now committed: end it, leaving the index and working tree for the steps below.
        const quit = adopted ? git(request.dir, ["merge", "--quit"]) : null;
        if (quit !== null && quit.code !== 0)
            warn(
                `toli: committed, but the git merge is still marked in progress (git merge --quit): ${quit.stderr.trim()}`,
            );
        // The shared index still holds the old blobs of the committed files, and a resolved merge's conflict stages:
        // point the committed paths' entries at the commit (index only), so git status shows no phantom staged reverts
        // and no unmerged path, including a named one that ends as in the first parent (a conflict resolved to its
        // side). Other paths' entries are left as they are.
        const own = [...new Set([...committed.files, ...request.paths])].filter(
            (file) => !committed.merged.includes(file),
        );
        const synced = own.length === 0 ? null : git(request.dir, ["reset", "--quiet", committed.sha, "--", ...own]);
        if (synced !== null && synced.code !== 0)
            warn(
                `toli: committed, but the shared index was not refreshed (git reset -q -- <paths>): ${synced.stderr.trim()}`,
            );
        // The merged files were clean before the merge: bring the index and the working tree to the merge result. A
        // file the merge deletes that is already out of the index (an adopted `git merge` removed it) is done; naming
        // it would fail the whole restore, as git knows it from neither side.
        const pending =
            committed.merged.length === 0
                ? []
                : gitOk(request.dir, ["ls-files", `--with-tree=${committed.sha}`, "--", ...committed.merged])
                      .split("\n")
                      .filter(Boolean);
        const restored =
            pending.length === 0
                ? null
                : git(request.dir, [
                      "restore",
                      `--source=${committed.sha}`,
                      "--staged",
                      "--worktree",
                      "--",
                      ...pending,
                  ]);
        if (restored !== null && restored.code !== 0)
            warn(
                `toli: committed, but the merged files were not checked out (git restore --source=${committed.sha.slice(0, 12)} --staged --worktree -- <paths>): ${restored.stderr.trim()}`,
            );
        return committed;
    }
    throw new ToliError(
        "refusing: the branch moved twice while committing (other jawans are committing too); nothing was committed. Run the same commit again.",
    );
}

/** Refuse when the project has a fixed working branch and the clone is on another one (or detached). */
function requireWorkingBranch(name: string, dir: string): void {
    const expected = findProject(name).branch;
    if (!expected) return;
    const actual = currentBranch(dir);
    if (actual === expected) return;
    throw new ToliError(
        `refusing: projects/${name} is on ${actual === null ? "a detached HEAD" : `"${actual}"`}, but its working branch is "${expected}". ` +
            `If this work belongs on "${expected}", switch first (git -C ${dir} switch ${expected}, only with a clean tree); ` +
            `otherwise ask ${persona().user}, and change the setting only on their word (bin/toli project set ${name} --branch <b>|none).`,
    );
}

/**
 * The checkout to commit in. `toli` (when no registered project has that name) is toli's own checkout, committing
 * on `develop` when it exists. Per-task strategies commit only on the task's own branch, in its workspace (`--task`,
 * or run from inside the task's worktree); same-branch projects keep the fixed-branch check on the clone.
 */
function commitDir(name: string, taskId: string | undefined): string {
    const root = toliSelfCheckout(name);
    if (root !== null) {
        const branch = currentBranch(root);
        if (refExists(root, `refs/heads/${DEVELOP_BRANCH}`) && branch !== DEVELOP_BRANCH)
            throw new ToliError(
                `refusing: toli's checkout is on ${branch === null ? "a detached HEAD" : `"${branch}"`}; toli's own work lands on ${DEVELOP_BRANCH}`,
            );
        return root;
    }
    const target = workDir(name, taskId);
    if (target.branch !== null) {
        const actual = currentBranch(target.dir);
        if (actual !== target.branch)
            throw new ToliError(
                `refusing: ${target.dir} is on ${actual === null ? "a detached HEAD" : `"${actual}"`}, but ${target.task?.id}'s branch is ` +
                    `"${target.branch}". Prepare it again (bin/toli workspace prepare ${target.task?.id}) or ask ${persona().user}.`,
            );
        return target.dir;
    }
    const workspace = findProject(name).workspace;
    if (perTask(workspace))
        throw new ToliError(
            `refusing: ${name} uses ${workspace}, so commits go on a task branch: pass --task <T-id> ` +
                `(its workspace is prepared by bin/toli spawn --task or bin/toli workspace prepare <T-id>)`,
        );
    requireWorkingBranch(name, target.dir);
    return target.dir;
}

/**
 * `toli commit <project> [--task T<n>] -m "<message>"... [--merge <ref> [--resolved]] [--patch <file>]...
 * [--allow-revert <sha>]... [-- <path>...]`; repeated `-m` values become separate paragraphs, as with `git commit`,
 * and repeated `--patch` files all apply, in the order given.
 */
export function commitCommand(argv: string[]): void {
    const args = new Args(argv, {
        booleans: ["resolved"],
        values: ["message", "task", "patch", "allow-revert", "merge"],
    });
    args.maxPositional(1);
    const dir = commitDir(args.pos(0, "project"), args.str("task"));
    const paragraphs = args.all("message");
    if (paragraphs.length === 0) throw new ToliError('commit needs -m "<message>"');
    const message = stripAiTrailers(paragraphs.join("\n\n"));
    if (message.trim() === "") throw new ToliError("commit message is empty after removing AI trailers");
    const patches = args
        .all("patch")
        .map((name) => ({ name, diff: readFileSync(resolve(process.cwd(), name), "utf8") }));
    const merge = args.str("merge");
    const committed = safeCommit({
        dir,
        paths: args.rest.filter((file) => file !== ""),
        patches,
        ...(merge === undefined ? {} : { merge }),
        resolved: args.bool("resolved"),
        message,
        allowRevert: args.all("allow-revert"),
    });
    out(committed.sha);
    // toli's own checkout: the live session runs the installed runtime, so move it to the new commit. Not after a
    // merge: the merged code has not passed `just check` here yet, so the runtime waits for `bin/toli self sync`.
    if (samePath(dir, paths.root()) && activeRuntime(dir) !== null) {
        if (merge !== undefined) {
            warn(
                "toli: merged, but the live runtime stays on the previous commit until the merge passes its check: run just check, then bin/toli self sync",
            );
            return;
        }
        try {
            syncRuntime(dir);
        } catch (error) {
            warn(
                `toli: committed, but the live runtime stays on the previous commit: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}

export function branchCommand(argv: string[]): void {
    const args = new Args(argv);
    args.maxPositional(2);
    const dir = projectCloneDir(args.pos(0, "project"));
    const branch = args.pos(1, "branch");
    gitOk(dir, ["check-ref-format", "--branch", branch]);
    const result = git(dir, ["switch", "-c", branch]);
    if (result.code !== 0)
        throw new ToliError(`git switch -c ${branch} failed: ${(result.stderr || result.stdout).trim()}`);
    out(`switched to new branch ${branch} in ${dir}`);
}
