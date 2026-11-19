import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeCommit } from "../src/projects/commit.ts";
import { git, head, repo, useGitEnv } from "./commit-fixture.ts";
import { GIT_ENV, tempDir } from "./helpers.ts";

useGitEnv();

// T1910: a `--merge` commit must record the merge result (main's side of every path only main changed), never the
// branch's older copies, in a plain clone and in a linked worktree (own git dir, MERGE_HEAD and index; shared objects).

type Layout = "clone" | "worktree";

/**
 * A repo whose `main` changes a.txt (and, when `conflicting`, shared.txt) in two commits after `feature` forks, while
 * `feature` changes b.txt (and shared.txt). Returns the checkout `feature` is in (the clone itself, or a linked
 * worktree of it) and main's tip.
 */
function diverged(layout: Layout, conflicting: boolean): { dir: string; main: string } {
    const root = repo({ "a.txt": "a\n", "b.txt": "b\n", "shared.txt": "one\ntwo\nthree\n" });
    git(root, ["branch", "feature"]);
    writeFileSync(join(root, "a.txt"), "a from main\n");
    git(root, ["commit", "--quiet", "-am", "main: a"]);
    writeFileSync(join(root, "a.txt"), "a from main, again\n");
    if (conflicting) writeFileSync(join(root, "shared.txt"), "one main\ntwo\nthree\n");
    git(root, ["commit", "--quiet", "-am", "main: a again"]);
    const main = head(root);
    let dir = root;
    if (layout === "worktree") {
        dir = join(tempDir("commit-wt"), "feature");
        git(root, ["worktree", "add", "--quiet", dir, "feature"]);
    } else {
        git(root, ["switch", "--quiet", "feature"]);
    }
    writeFileSync(join(dir, "b.txt"), "b from feature\n");
    if (conflicting) writeFileSync(join(dir, "shared.txt"), "one feature\ntwo\nthree\n");
    git(dir, ["commit", "--quiet", "-am", "feature: b"]);
    return { dir, main };
}

/** `git merge --no-ff --no-commit <sha>` in `dir`; a conflicted merge exits 1 and stays in progress. */
function startMerge(dir: string, sha: string): void {
    const proc = Bun.spawnSync(["git", "-C", dir, "merge", "--no-ff", "--no-commit", sha], {
        env: { ...process.env, ...GIT_ENV },
        stdout: "pipe",
        stderr: "pipe",
    });
    if (proc.exitCode !== 0 && proc.exitCode !== 1) throw new Error(`git merge: ${proc.stderr.toString()}`);
    expect(git(dir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).toBe(sha);
}

const RESOLUTION = "one main and feature\ntwo\nthree\n";

/** `tree` with `file` replaced by its working-tree version in `dir`, built in a throwaway index. */
function withFile(dir: string, tree: string, file: string): string {
    const env = { ...process.env, ...GIT_ENV, GIT_INDEX_FILE: join(tempDir("commit-index"), "index") };
    const run = (args: string[]): string => {
        const proc = Bun.spawnSync(["git", "-C", dir, ...args], { env, stdout: "pipe", stderr: "pipe" });
        if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
        return proc.stdout.toString().trim();
    };
    run(["read-tree", tree]);
    run(["add", "--", file]);
    return run(["write-tree"]);
}

describe("bin/toli commit --merge records the merge result, in a clone and in a linked worktree (T1910)", () => {
    for (const layout of ["clone", "worktree"] as const) {
        for (const adopted of [true, false]) {
            for (const conflicting of [false, true]) {
                const name = `${layout}, ${adopted ? "git merge in progress" : "no git merge"}, ${conflicting ? "conflicted (--resolved)" : "clean"}`;
                test(name, () => {
                    const { dir, main } = diverged(layout, conflicting);
                    const before = head(dir);
                    if (adopted) startMerge(dir, main);
                    if (conflicting) writeFileSync(join(dir, "shared.txt"), RESOLUTION);
                    // The expected tree: what `git merge` left (resolution staged), or merge-tree's clean result
                    // with the resolution in place of its conflict markers.
                    let expected: string;
                    if (adopted) {
                        git(dir, ["add", "--", "shared.txt"]);
                        expected = git(dir, ["write-tree"]);
                    } else {
                        const merged = Bun.spawnSync(
                            ["git", "-C", dir, "merge-tree", "--write-tree", "--no-messages", before, main],
                            { env: { ...process.env, ...GIT_ENV }, stdout: "pipe" },
                        );
                        const tree = merged.stdout.toString().split("\n")[0] ?? "";
                        expected = conflicting ? withFile(dir, tree, "shared.txt") : tree;
                    }
                    const committed = safeCommit({
                        dir,
                        paths: conflicting ? ["shared.txt"] : [],
                        merge: main,
                        resolved: conflicting,
                        message: `merge main ${main.slice(0, 12)} into feature`,
                    });
                    expect(git(dir, ["rev-list", "--parents", "-n", "1", committed.sha]).split(" ").slice(1)).toEqual([
                        before,
                        main,
                    ]);
                    expect(git(dir, ["show", `${committed.sha}:a.txt`])).toBe("a from main, again");
                    expect(git(dir, ["show", `${committed.sha}:b.txt`])).toBe("b from feature");
                    expect(git(dir, ["rev-parse", `${committed.sha}^{tree}`])).toBe(expected);
                    expect(git(dir, ["rev-parse", "-q", "--verify", "--end-of-options", "HEAD"])).toBe(committed.sha);
                    expect(git(dir, ["status", "--porcelain"])).toBe("");
                });
            }
        }
    }
});
