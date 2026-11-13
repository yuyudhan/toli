// The commit `bin/toli commit` and `--patch-out` build (see commit.ts): stage the named paths and patch hunks in a
// private index on `parent`, run every check, and write the commit object. No ref moves here.
import { git, gitOk, gitPaths, nulPaths } from "../core/git.ts";
import { ToliError } from "../core/util.ts";
import type { CommitRequest } from "./commit.ts";
import {
    Attempt,
    absentPaths,
    applyPatches,
    checkLockFiles,
    checkResolved,
    checkReverts,
    commitMsgHook,
    scanLeaks,
} from "./commit-checks.ts";
import { cleanMerge, type Merge } from "./commit-merge.ts";
import { parseHunks } from "./diff-hunks.ts";

/** The commit built on `parent` before any ref moves; `merge` is the clean merge it starts from, if any. */
export type Built = { sha: string; subject: string; files: string[]; merge: Merge | null };

/** `attempt.gitOk` for a `-z` path listing, untrimmed (see nulPaths in core/git.ts). */
function attemptPaths(attempt: Attempt, args: string[]): string[] {
    const result = attempt.git(args);
    if (result.code !== 0)
        throw new ToliError(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
    return nulPaths(result.stdout);
}

/**
 * Build the commit for `request` on `parent` (the tip of `label`, a branch or HEAD) in a private index: stage, check
 * and `commit-tree`. Moves no ref; every refusal throws.
 */
export function buildCommit(request: CommitRequest, parent: string, label: string, adopted: boolean): Built {
    const { dir } = request;
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
        // Path listings use -z throughout: git C-quotes non-ASCII names otherwise, and those match no real path.
        const files = gitPaths(dir, ["diff", "--name-only", "-z", "--no-renames", parent, tree]);
        if (files.length === 0 && merge === null)
            throw new ToliError(`nothing to commit: the named paths match ${label} (${parent.slice(0, 12)})`);
        const own = gitPaths(dir, ["diff", "--name-only", "-z", "--no-renames", start, tree]);
        const named = new Set(
            own.length === 0
                ? []
                : gitPaths(dir, [
                      "diff",
                      "--name-only",
                      "-z",
                      "--no-renames",
                      start,
                      tree,
                      "--",
                      ...request.paths,
                      ...fromPatch,
                  ]),
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
                request.paths.length === 0 ? [] : attemptPaths(attempt, ["ls-files", "-z", "--", ...request.paths]),
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
        return { sha, subject: message.split("\n")[0] ?? "", files, merge };
    } finally {
        attempt.dispose();
    }
}
