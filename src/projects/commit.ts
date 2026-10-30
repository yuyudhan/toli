// `bin/toli commit` (R23): safe commits in a checkout many jawans share, without worktrees or tree copies.
//
// Each attempt reads the branch tip once (`old`), builds a private temporary index from it (GIT_INDEX_FILE), stages
// only the named paths and/or applies a patch of hunks, checks the staged set (it changes only the named paths, has
// no leaks, every staged lock file parses, it does not revert a recent commit), writes the commit with `commit-tree`
// on `old`, and moves the branch with `update-ref <branch> <new> <old>`, which fails if the branch moved meanwhile.
// One retry rebuilds everything from the fresh tip; a second move is a refusal. The shared index and other jawans'
// staged or unstaged changes are never read, so a stale shared index can no longer revert anyone's commits.
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
};

export type Committed = { sha: string; branch: string; parent: string; files: string[]; attempts: number };

/** Test seam: runs after the commit object is written and before the branch moves. */
export type CommitHooks = { beforeUpdateRef?: (attempt: number) => void };

function attemptCommit(request: CommitRequest, attemptNo: number, hooks: CommitHooks): Committed | null {
    const { dir } = request;
    const branch = currentBranch(dir);
    if (branch === null) throw new ToliError(`refusing: ${dir} is on a detached HEAD; commit on a branch`);
    const ref = `refs/heads/${branch}`;
    const parent = gitOk(dir, ["rev-parse", "--verify", `${ref}^{commit}`]);
    const attempt = new Attempt(dir);
    try {
        attempt.gitOk(["read-tree", parent]);
        if (request.paths.length > 0) attempt.gitOk(["add", "--all", "--", ...request.paths]);
        const fromPatch = request.patch === undefined ? [] : patchFiles(attempt, request.patch);
        if (request.patch !== undefined) attempt.gitOk(["apply", "--cached", "-"], request.patch);
        const tree = attempt.gitOk(["write-tree"]);
        const files = gitOk(dir, ["diff", "--name-only", "--no-renames", parent, tree]).split("\n").filter(Boolean);
        if (files.length === 0)
            throw new ToliError(`nothing to commit: the named paths match ${branch} (${parent.slice(0, 12)})`);
        const named = new Set(
            gitOk(dir, ["diff", "--name-only", "--no-renames", parent, tree, "--", ...request.paths, ...fromPatch])
                .split("\n")
                .filter(Boolean),
        );
        const stray = files.filter((file) => !named.has(file));
        if (stray.length > 0)
            throw new ToliError(`refusing: the staged set changes paths that were not named: ${stray.join(", ")}`);
        scanLeaks(attempt);
        checkLockFiles(attempt, files);
        checkReverts(dir, parent, tree, files, request.allowRevert ?? []);
        const created = git(dir, ["commit-tree", tree, "-p", parent, "-F", "-"], `${request.message}\n`);
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
        return { sha, branch, parent, files, attempts: attemptNo };
    } finally {
        attempt.dispose();
    }
}

/**
 * Commit the named paths and/or patch hunks onto the branch checked out in `request.dir` (see the file comment).
 * Throws a ToliError on every refusal; the branch, the shared index and the working tree are then untouched.
 */
export function safeCommit(request: CommitRequest, hooks: CommitHooks = {}): Committed {
    if (request.paths.length === 0 && request.patch === undefined)
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
        const synced = git(request.dir, ["reset", "--quiet", committed.sha, "--", ...committed.files]);
        if (synced.code !== 0)
            warn(
                `toli: committed, but the shared index was not refreshed (git reset -q -- <paths>): ${synced.stderr.trim()}`,
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

/** `toli commit <project> [--task T<n>] -m "<message>" [--patch <file>] [--allow-revert <sha>]... [-- <path>...]` */
export function commitCommand(argv: string[]): void {
    const args = new Args(argv, { values: ["message", "task", "patch", "allow-revert"] });
    args.maxPositional(1);
    const dir = commitDir(args.pos(0, "project"), args.str("task"));
    const raw = args.str("message");
    if (raw === undefined) throw new ToliError('commit needs -m "<message>"');
    const message = stripAiTrailers(raw);
    if (message.trim() === "") throw new ToliError("commit message is empty after removing AI trailers");
    const patchFile = args.str("patch");
    const patch = patchFile === undefined ? undefined : readFileSync(resolve(process.cwd(), patchFile), "utf8");
    const committed = safeCommit({
        dir,
        paths: args.rest.filter((file) => file !== ""),
        ...(patch === undefined ? {} : { patch }),
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
