// The merge side of `bin/toli commit --merge` (src/projects/commit.ts): the merge-tree result it starts from, and the
// `git merge` in progress (MERGE_HEAD) it adopts.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkoutDirty, git, gitOk, gitPaths, nulPaths, resolveSha } from "../core/git.ts";
import { ToliError } from "../core/util.ts";
import { isLockFile } from "./commit-checks.ts";

/**
 * `conflicts`: the paths `git merge-tree` could not merge; `tree` holds them with conflict markers. `adopted`: the
 * merge is the `git merge` in progress in the checkout, whose result is already in the working tree.
 */
export type Merge = {
    ref: string;
    commit: string;
    tree: string;
    files: string[];
    conflicts: string[];
    adopted: boolean;
};

/**
 * The merge of `ref` into `parent` (`git merge-tree --write-tree`, which touches neither index nor working tree).
 * Refuses a ref already contained in `parent`, a conflicted merge unless `resolved`, `resolved` on a clean merge
 * unless every named path is a lock file, and local changes to the files it changes other than the conflicted ones,
 * the named lock files and, when `resolved`, the named paths (those hold the resolution and its fixes). Named lock
 * files replace the merged text: a lock file can merge cleanly yet miss what both sides added, so the committer's
 * regenerated one goes through `checkLockFiles` instead. An `adopted` merge (`git merge` already wrote it into the
 * working tree) instead refuses merged files not named whose working-tree version differs from the merge result:
 * checking the commit out would overwrite them.
 */
export function cleanMerge(
    dir: string,
    parent: string,
    ref: string,
    options: { resolved: boolean; named: string[]; adopted: boolean },
): Merge {
    const { resolved, named, adopted } = options;
    const commit = resolveSha(dir, ref);
    if (commit === null) throw new ToliError(`--merge ${ref}: no such commit`);
    if (git(dir, ["merge-base", "--is-ancestor", commit, parent]).code === 0)
        throw new ToliError(`nothing to commit: ${ref} (${commit.slice(0, 12)}) is already merged`);
    // -z: names as stored, not C-quoted (core.quotePath), so they match real paths later (see commit.ts).
    const merged = git(dir, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", parent, commit]);
    if (merged.code !== 0 && merged.code !== 1)
        throw new ToliError(`git merge-tree failed: ${(merged.stderr || merged.stdout).trim()}`);
    const [tree = "", ...listed] = nulPaths(merged.stdout);
    const conflicts = [...new Set(listed)];
    if (merged.code === 1 && !resolved)
        throw new ToliError(
            `refusing: merging ${ref} has conflicts in ${conflicts.join(", ")}; nothing was committed. ` +
                `Write the resolved files in the working tree (git show ${tree.slice(0, 12)}:<path> shows each with ` +
                `conflict markers), then run the same commit with --resolved -- ${conflicts.join(" ")}.`,
        );
    if (merged.code === 0 && resolved && (named.length === 0 || !named.every(isLockFile)))
        throw new ToliError(
            `refusing: --resolved, but merging ${ref} has no conflicts; drop --resolved (on a clean merge it takes only fixed lock files)`,
        );
    const files = gitPaths(dir, ["diff", "--name-only", "-z", "--no-renames", parent, tree]);
    const regenerated = files.filter((file) => isLockFile(file) && named.includes(file));
    // Named paths hold the committer's version when the merge is adopted or resolved (an evil merge: fixes the bare
    // merge result needs, committed with it); buildCommit reports them as amended.
    const checked = files.filter(
        (file) =>
            !conflicts.includes(file) &&
            !regenerated.includes(file) &&
            !((adopted || resolved) && named.includes(file)),
    );
    if (adopted) {
        const edited =
            checked.length === 0
                ? []
                : gitPaths(dir, [
                      "--literal-pathspecs",
                      "diff",
                      "--name-only",
                      "-z",
                      "--no-renames",
                      tree,
                      "--",
                      ...checked,
                  ]);
        if (edited.length > 0)
            throw new ToliError(
                `refusing: ${edited.join(", ")} differ from the result of merging ${ref}; name them to commit your version`,
            );
    } else if (checked.length > 0 && checkoutDirty(dir, { ignored: true, paths: checked })) {
        // Whether they differ comes from git exit statuses (checkoutDirty); `git status` only names them below.
        // Raw stdout: gitOk trims, which would eat the first line's leading status column (" M CHANGELOG.md").
        const listed = git(dir, [
            "--no-optional-locks",
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--ignored=matching",
            "--",
            ...checked,
        ]).stdout;
        const names = listed
            .split("\n")
            .filter(Boolean)
            .map((line) => line.slice(3));
        throw new ToliError(
            `refusing: local changes to files the merge changes: ${names.length > 0 ? names.join(", ") : checked.join(", ")}; commit or move them first`,
        );
    }
    return { ref, commit, tree, files, conflicts, adopted };
}

/** The commits a `git merge` in progress in `dir` is merging (MERGE_HEAD); empty when none is. */
function mergeHeads(dir: string): string[] {
    const file = resolve(dir, gitOk(dir, ["rev-parse", "--git-path", "MERGE_HEAD"]));
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

/**
 * Whether a commit with `--merge <merge>` (or none) in `dir` adopts a `git merge` in progress there. It must name that
 * merge: a commit without it would record one parent and drop the merged one, and toli records only two parents. Both
 * sides are peeled to commits: `git merge <annotated tag>` writes the tag object to MERGE_HEAD, and the tag's name,
 * its sha and the commit it tags all name that merge (cleanMerge records the commit as the second parent, as git does).
 */
export function adoptsMerge(dir: string, merge: string | undefined): boolean {
    const pending = mergeHeads(dir);
    const [only] = pending;
    if (only === undefined) return false;
    const shown = pending.map((sha) => sha.slice(0, 12)).join(" ");
    if (pending.length > 1)
        throw new ToliError(
            `refusing: a git merge of ${pending.length} commits (${shown}) is in progress in ${dir}; bin/toli commit records one merged ref. End it (git merge --abort), then land each with --merge <ref>`,
        );
    if (merge === undefined)
        throw new ToliError(
            `refusing: a git merge of ${shown} is in progress in ${dir}; a commit without it would record one parent and drop ${shown}. Land the merge with --merge ${shown} (add --resolved when it had conflicts, naming the conflicted paths), or wait for whoever runs that merge to land it`,
        );
    const pendingCommit = resolveSha(dir, only);
    if (pendingCommit === null || resolveSha(dir, merge) !== pendingCommit)
        throw new ToliError(
            `refusing: a git merge of ${shown} is in progress in ${dir}, not of ${merge}; land that merge first (--merge ${shown}) or end it (git merge --abort)`,
        );
    return true;
}
