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
// `--patch-out` (toli's own checkout, e.g. a release install detached at a tag) runs the same build on HEAD in a
// private object directory and returns it as `git format-patch` text; no ref, index, working tree or runtime moves.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { Args } from "../core/args.ts";
import { currentBranch, git, gitOk, gitPaths, headSha } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { persona } from "../core/persona.ts";
import { out, ToliError, warn } from "../core/util.ts";
import { DEVELOP_BRANCH } from "../release/release.ts";
import { activeRuntime, syncRuntime } from "../release/runtime.ts";
import { buildCommit } from "./commit-build.ts";
import { adoptsMerge } from "./commit-merge.ts";
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
    const { sha, subject, files, merge } = buildCommit(request, parent, branch, adopted);
    hooks.beforeUpdateRef?.(attemptNo);
    const moved = git(dir, ["update-ref", "-m", `toli commit: ${subject}`, ref, sha, parent]);
    if (moved.code !== 0) return null;
    // A path the merge touches that ends as in `parent` (a conflict resolved by deleting it) has nothing to check out.
    const merged = merge?.files.filter((file) => files.includes(file)) ?? [];
    return { sha, branch, parent, files, merged, attempts: attemptNo };
}

/** A commit built for export: `patch` is its `git format-patch` text; no ref, index or working tree moved. */
export type PatchExport = { sha: string; parent: string; files: string[]; patch: string };

/**
 * Build the commit for the named paths and/or patch hunks on HEAD (a branch tip or a detached release tag) and
 * return it as `git format-patch` text, writing nothing to the checkout: no ref moves, and every object git writes
 * goes to a private object directory (the checkout's own is an alternate, read only) that is removed afterwards. All
 * the usual checks run. `--merge` has no patch form and is refused.
 */
export function exportPatch(request: CommitRequest): PatchExport {
    if (request.merge !== undefined || request.resolved === true)
        throw new ToliError("--patch-out cannot carry a merge: a patch is one commit on HEAD");
    if (request.paths.length === 0 && (request.patches ?? []).length === 0)
        throw new ToliError(
            'a patch needs paths after -- or --patch <file>: toli commit toli --patch-out <file> -m "..." -- <path>...',
        );
    const { dir } = request;
    const parent = headSha(dir);
    const objects = gitOk(dir, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
    const scratch = mkdtempSync(join(tmpdir(), "toli-patch-"));
    mkdirSync(join(scratch, "objects"));
    const saved = {
        directory: process.env.GIT_OBJECT_DIRECTORY,
        alternates: process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
    };
    process.env.GIT_OBJECT_DIRECTORY = join(scratch, "objects");
    process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = [objects, saved.alternates].filter(Boolean).join(delimiter);
    try {
        const { sha, files } = buildCommit(request, parent, "HEAD", false);
        const patch = gitOk(dir, ["format-patch", "--stdout", "--no-signature", "-1", sha]);
        return { sha, parent, files, patch: `${patch}\n` };
    } finally {
        for (const [key, value] of [
            ["GIT_OBJECT_DIRECTORY", saved.directory],
            ["GIT_ALTERNATE_OBJECT_DIRECTORIES", saved.alternates],
        ] as const) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        rmSync(scratch, { recursive: true, force: true });
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
        // it would fail the whole restore, as git knows it from neither side. The merged names are file names, not
        // patterns: both calls read them literally, so a name holding `*` or `[` matches only itself.
        const pending =
            committed.merged.length === 0
                ? []
                : gitPaths(request.dir, [
                      "--literal-pathspecs",
                      "ls-files",
                      "-z",
                      `--with-tree=${committed.sha}`,
                      "--",
                      ...committed.merged,
                  ]);
        const restored =
            pending.length === 0
                ? null
                : git(request.dir, [
                      "--literal-pathspecs",
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
        if (branch === null)
            throw new ToliError(
                "refusing: toli's checkout is on a detached HEAD (a release install), which commits move nowhere; " +
                    'produce a patch for the development machine instead: bin/toli commit toli --patch-out <file> -m "<message>" -- <paths>. ' +
                    "It leaves HEAD, the branches and the runtime alone (docs/development.md, release installs).",
            );
        if (refExists(root, `refs/heads/${DEVELOP_BRANCH}`) && branch !== DEVELOP_BRANCH)
            throw new ToliError(
                `refusing: toli's checkout is on "${branch}"; toli's own work lands on ${DEVELOP_BRANCH}`,
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

/** Write `exported` to `file` and its sha256 (`sha256sum` format) to `<file>.sha256`, and say what was written. */
function writePatch(exported: PatchExport, file: string): void {
    const sha256 = createHash("sha256").update(exported.patch).digest("hex");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, exported.patch);
    writeFileSync(`${file}.sha256`, `${sha256}  ${basename(file)}\n`);
    out(`patch: ${file}`);
    out(`sha256: ${sha256}`);
    out(`on: ${exported.parent.slice(0, 12)} (${exported.files.length} files: ${exported.files.join(", ")})`);
    out("nothing was committed: HEAD, the branches and the runtime are unchanged; apply with git am on develop");
}

/**
 * `toli commit <project> [--task T<n>] -m "<message>"... [--merge <ref> [--resolved]] [--patch <file>]...
 * [--allow-revert <sha>]... [--patch-out <file>] [-- <path>...]`; repeated `-m` values become separate paragraphs, as
 * with `git commit`, and repeated `--patch` files all apply, in the order given. `--patch-out` (toli's own checkout
 * only) writes the commit as `git format-patch` text to `<file>`, with its sha256 in `<file>.sha256`, instead of
 * committing.
 */
export function commitCommand(argv: string[]): void {
    const args = new Args(argv, {
        booleans: ["resolved"],
        values: ["message", "task", "patch", "allow-revert", "merge", "patch-out"],
    });
    args.maxPositional(1);
    const name = args.pos(0, "project");
    const patchOut = args.str("patch-out");
    const toliRoot = patchOut === undefined ? null : toliSelfCheckout(name);
    if (patchOut !== undefined && toliRoot === null)
        throw new ToliError("--patch-out is for toli's own checkout: bin/toli commit toli --patch-out <file> ...");
    const dir = toliRoot ?? commitDir(name, args.str("task"));
    const paragraphs = args.all("message");
    if (paragraphs.length === 0) throw new ToliError('commit needs -m "<message>"');
    const message = stripAiTrailers(paragraphs.join("\n\n"));
    if (message.trim() === "") throw new ToliError("commit message is empty after removing AI trailers");
    const patches = args
        .all("patch")
        .map((file) => ({ name: file, diff: readFileSync(resolve(process.cwd(), file), "utf8") }));
    const merge = args.str("merge");
    const request: CommitRequest = {
        dir,
        paths: args.rest.filter((file) => file !== ""),
        patches,
        ...(merge === undefined ? {} : { merge }),
        resolved: args.bool("resolved"),
        message,
        allowRevert: args.all("allow-revert"),
    };
    if (patchOut !== undefined) {
        writePatch(exportPatch(request), resolve(process.cwd(), patchOut));
        return;
    }
    const committed = safeCommit(request);
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
