// `bin/toli commit` (R23): safe commits in a checkout many jawans share, without worktrees or tree copies.
//
// Each attempt reads the branch tip once (`old`), builds a private temporary index from it (GIT_INDEX_FILE), stages
// only the named paths and/or applies a patch of hunks, checks the staged set (it changes only the named paths, has
// no leaks, every staged lock file parses, it does not revert a recent commit), writes the commit with `commit-tree`
// on `old`, and moves the branch with `update-ref <branch> <new> <old>`, which fails if the branch moved meanwhile.
// One retry rebuilds everything from the fresh tip; a second move is a refusal. The shared index and other jawans'
// staged or unstaged changes are never read, so a stale shared index can no longer revert anyone's commits.
// `--merge <ref>` starts the private index from the clean `git merge-tree` result instead and adds `<ref>` as second
// parent; the files the merge brought are then checked out into the shared index and working tree.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Args } from "../core/args.ts";
import { currentBranch, git, gitOk, isGitRepo } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { persona } from "../core/persona.ts";
import { out, ToliError, warn } from "../core/util.ts";
import { DEVELOP_BRANCH } from "../release/release.ts";
import { activeRuntime, syncRuntime } from "../release/runtime.ts";
import { Attempt, checkLockFiles, checkReverts, patchFiles, scanLeaks } from "./commit-checks.ts";
import { findProject, loadProjects, projectCloneDir } from "./projects.ts";
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
    /** A unified diff (`git diff` output) whose hunks are committed; the working tree is not read for it. */
    patch?: string;
    message: string;
    /** Commits (sha prefixes) this commit may revert on purpose. */
    allowRevert?: string[];
    /** A ref to merge: the commit gets it as second parent and starts from the clean merge result of the two. */
    merge?: string;
};

/** `files`: every path changed against the first parent; `merged`: those the merge brought in (not named). */
export type Committed = {
    sha: string;
    branch: string;
    parent: string;
    files: string[];
    merged: string[];
    attempts: number;
};

type Merge = { commit: string; tree: string; files: string[] };

/**
 * The clean merge of `ref` into `parent` (`git merge-tree --write-tree`, which touches neither index nor working
 * tree). Refuses a ref already contained in `parent`, a conflicted merge, and local changes to the files it changes.
 */
function cleanMerge(dir: string, parent: string, ref: string): Merge {
    const resolved = git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (resolved.code !== 0) throw new ToliError(`--merge ${ref}: no such commit`);
    const commit = resolved.stdout.trim();
    if (git(dir, ["merge-base", "--is-ancestor", commit, parent]).code === 0)
        throw new ToliError(`nothing to commit: ${ref} (${commit.slice(0, 12)}) is already merged`);
    const merged = git(dir, ["merge-tree", "--write-tree", "--name-only", "--no-messages", parent, commit]);
    const [tree = "", ...conflicts] = merged.stdout.trim().split("\n");
    if (merged.code === 1)
        throw new ToliError(
            `refusing: merging ${ref} has conflicts in ${[...new Set(conflicts)].join(", ")}; nothing was committed. ` +
                `Resolve them on a branch of your own (git switch -c <b>, git merge ${ref}, fix, commit) and merge that.`,
        );
    if (merged.code !== 0) throw new ToliError(`git merge-tree failed: ${(merged.stderr || merged.stdout).trim()}`);
    const files = gitOk(dir, ["diff", "--name-only", "--no-renames", parent, tree]).split("\n").filter(Boolean);
    const dirty =
        files.length === 0
            ? ""
            : gitOk(dir, [
                  "--no-optional-locks",
                  "status",
                  "--porcelain",
                  "--untracked-files=all",
                  "--ignored=matching",
                  "--",
                  ...files,
              ]);
    if (dirty !== "")
        throw new ToliError(
            `refusing: local changes to files the merge changes: ${dirty
                .split("\n")
                .map((line) => line.slice(3))
                .join(", ")}; commit or move them first`,
        );
    return { commit, tree, files };
}

/** Test seam: runs after the commit object is written and before the branch moves. */
export type CommitHooks = { beforeUpdateRef?: (attempt: number) => void };

function attemptCommit(request: CommitRequest, attemptNo: number, hooks: CommitHooks): Committed | null {
    const { dir } = request;
    const branch = currentBranch(dir);
    if (branch === null) throw new ToliError(`refusing: ${dir} is on a detached HEAD; commit on a branch`);
    const ref = `refs/heads/${branch}`;
    const parent = gitOk(dir, ["rev-parse", "--verify", `${ref}^{commit}`]);
    const merge = request.merge === undefined ? null : cleanMerge(dir, parent, request.merge);
    // The named paths and patch apply on top of the merge result; the merge itself needs no naming.
    const start = merge?.tree ?? parent;
    const attempt = new Attempt(dir);
    try {
        attempt.gitOk(["read-tree", start]);
        if (request.paths.length > 0) attempt.gitOk(["add", "--all", "--", ...request.paths]);
        const fromPatch = request.patch === undefined ? [] : patchFiles(attempt, request.patch);
        if (request.patch !== undefined) attempt.gitOk(["apply", "--cached", "-"], request.patch);
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
        const overlap = merge === null ? [] : own.filter((file) => merge.files.includes(file));
        if (overlap.length > 0)
            throw new ToliError(
                `refusing: ${overlap.join(", ")} changed by both the merge and the named paths; commit the merge first, then your edits`,
            );
        scanLeaks(attempt);
        checkLockFiles(attempt, files);
        checkReverts(dir, parent, tree, files, request.allowRevert ?? []);
        const parents = ["-p", parent, ...(merge === null ? [] : ["-p", merge.commit])];
        const created = git(dir, ["commit-tree", tree, ...parents, "-F", "-"], `${request.message}\n`);
        if (created.code !== 0)
            throw new ToliError(`git commit-tree failed: ${(created.stderr || created.stdout).trim()}`);
        const sha = created.stdout.trim();
        hooks.beforeUpdateRef?.(attemptNo);
        const moved = git(dir, [
            "update-ref",
            "-m",
            `toli commit: ${request.message.split("\n")[0]}`,
            ref,
            sha,
            parent,
        ]);
        if (moved.code !== 0) return null;
        return { sha, branch, parent, files, merged: merge?.files ?? [], attempts: attemptNo };
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
    if (request.paths.length === 0 && request.patch === undefined && request.merge === undefined)
        throw new ToliError(
            'commit needs paths after -- or --patch <file>: toli commit <project> -m "..." -- <path>...',
        );
    for (let attemptNo = 1; attemptNo <= 2; attemptNo++) {
        const committed = attemptCommit(request, attemptNo, hooks);
        if (committed === null) {
            if (attemptNo === 1) warn("toli: the branch moved while committing; retrying once from its new tip");
            continue;
        }
        // The shared index still holds the old blobs of the committed files: point those entries at the commit, so
        // git status shows no phantom staged reverts. Other paths' entries are left as they are.
        const own = committed.files.filter((file) => !committed.merged.includes(file));
        const synced = own.length === 0 ? null : git(request.dir, ["reset", "--quiet", committed.sha, "--", ...own]);
        if (synced !== null && synced.code !== 0)
            warn(
                `toli: committed, but the shared index was not refreshed (git reset -q -- <paths>): ${synced.stderr.trim()}`,
            );
        // The merged files were clean before the merge: bring the index and the working tree to the merge result.
        const restored =
            committed.merged.length === 0
                ? null
                : git(request.dir, [
                      "restore",
                      `--source=${committed.sha}`,
                      "--staged",
                      "--worktree",
                      "--",
                      ...committed.merged,
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
    if (name === "toli" && !loadProjects().some((project) => project.name === "toli")) {
        const root = paths.root();
        if (!isGitRepo(root)) throw new ToliError(`${root} is not a git checkout`);
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
 * `toli commit <project> [--task T<n>] -m "<message>"... [--merge <ref>] [--patch <file>] [--allow-revert <sha>]...
 * [-- <path>...]`; repeated `-m` values become separate paragraphs, as with `git commit`.
 */
export function commitCommand(argv: string[]): void {
    const args = new Args(argv, { values: ["message", "task", "patch", "allow-revert", "merge"] });
    args.maxPositional(1);
    const dir = commitDir(args.pos(0, "project"), args.str("task"));
    const paragraphs = args.all("message");
    if (paragraphs.length === 0) throw new ToliError('commit needs -m "<message>"');
    const message = stripAiTrailers(paragraphs.join("\n\n"));
    if (message.trim() === "") throw new ToliError("commit message is empty after removing AI trailers");
    const patchFile = args.str("patch");
    const patch = patchFile === undefined ? undefined : readFileSync(resolve(process.cwd(), patchFile), "utf8");
    const merge = args.str("merge");
    const committed = safeCommit({
        dir,
        paths: args.rest.filter((file) => file !== ""),
        ...(patch === undefined ? {} : { patch }),
        ...(merge === undefined ? {} : { merge }),
        message,
        allowRevert: args.all("allow-revert"),
    });
    out(committed.sha);
    // toli's own checkout: the live session runs the installed runtime, so move it to the new commit.
    if (samePath(dir, paths.root()) && activeRuntime(dir) !== null) {
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
