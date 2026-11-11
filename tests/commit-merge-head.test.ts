import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeCommit } from "../src/projects/commit.ts";
import { git, head, repo, useGitEnv } from "./commit-fixture.ts";
import { GIT_ENV } from "./helpers.ts";

useGitEnv();

/**
 * A repo whose `upstream` branch changes shared.txt and adds new.txt while `main` changes shared.txt too (a conflict
 * when `conflicting`, else a different line) and mine.txt. Returns the repo and main's tip.
 */
function diverged(conflicting: boolean): { dir: string; before: string; upstream: string } {
    const dir = repo({ "shared.txt": "one\ntwo\nthree\n", "mine.txt": "mine\n" });
    git(dir, ["switch", "--quiet", "-c", "upstream"]);
    writeFileSync(join(dir, "shared.txt"), "one upstream\ntwo\nthree\n");
    writeFileSync(join(dir, "new.txt"), "new from upstream\n");
    git(dir, ["add", "--all"]);
    git(dir, ["commit", "--quiet", "-m", "upstream work"]);
    const upstream = head(dir);
    git(dir, ["switch", "--quiet", "main"]);
    writeFileSync(join(dir, "shared.txt"), conflicting ? "one main\ntwo\nthree\n" : "one\ntwo\nthree main\n");
    writeFileSync(join(dir, "mine.txt"), "mine on main\n");
    git(dir, ["commit", "--quiet", "-am", "main work"]);
    return { dir, before: head(dir), upstream };
}

/** `git merge --no-commit upstream` as a jawan runs it; a conflicted merge exits 1 and stays in progress. */
function startMerge(dir: string): void {
    const proc = Bun.spawnSync(["git", "-C", dir, "merge", "--no-ff", "--no-commit", "upstream"], {
        env: { ...process.env, ...GIT_ENV },
        stdout: "pipe",
        stderr: "pipe",
    });
    if (proc.exitCode !== 0 && proc.exitCode !== 1) throw new Error(`git merge: ${proc.stderr.toString()}`);
    expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(true);
}

const parents = (dir: string, sha: string): string[] =>
    git(dir, ["rev-list", "--parents", "-n", "1", sha]).split(" ").slice(1);

describe("bin/toli commit with a git merge in progress (MERGE_HEAD)", () => {
    test("a commit without --merge is refused instead of recording one parent and dropping the merged one", () => {
        const { dir, before, upstream } = diverged(true);
        startMerge(dir);
        writeFileSync(join(dir, "shared.txt"), "one main and upstream\ntwo\nthree\n");
        expect(() => safeCommit({ dir, paths: ["shared.txt"], message: "Merge upstream" })).toThrow(
            `refusing: a git merge of ${upstream.slice(0, 12)} is in progress in ${dir}; a commit without it would record one parent`,
        );
        expect(head(dir)).toBe(before);
        expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(true);
    });

    test("--merge MERGE_HEAD --resolved adopts the conflicted merge: both parents, the merge ended, a clean checkout", () => {
        const { dir, before, upstream } = diverged(true);
        startMerge(dir);
        const resolution = "one main and upstream\ntwo\nthree\n";
        writeFileSync(join(dir, "shared.txt"), resolution);
        const merged = safeCommit({
            dir,
            paths: ["shared.txt"],
            merge: "MERGE_HEAD",
            resolved: true,
            message: "Merge upstream",
        });
        expect(parents(dir, merged.sha)).toEqual([before, upstream]);
        expect(git(dir, ["merge-base", "--is-ancestor", upstream, "HEAD"])).toBe("");
        expect(git(dir, ["show", `${merged.sha}:shared.txt`])).toBe(resolution.trim());
        expect(git(dir, ["show", `${merged.sha}:new.txt`])).toBe("new from upstream");
        expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(false);
        expect(git(dir, ["status", "--porcelain"])).toBe("");
    });

    test("a clean merge in progress lands with --merge <its sha> and no paths", () => {
        const { dir, before, upstream } = diverged(false);
        startMerge(dir);
        const merged = safeCommit({ dir, paths: [], merge: upstream, message: "Merge upstream" });
        expect(parents(dir, merged.sha)).toEqual([before, upstream]);
        expect(git(dir, ["show", `${merged.sha}:shared.txt`])).toBe("one upstream\ntwo\nthree main");
        expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(false);
        expect(git(dir, ["status", "--porcelain"])).toBe("");
    });

    test("another --merge ref, or an unnamed merged file edited after the merge, is refused", () => {
        const { dir, before, upstream } = diverged(false);
        startMerge(dir);
        expect(() => safeCommit({ dir, paths: [], merge: "main~1", message: "Merge" })).toThrow(
            `refusing: a git merge of ${upstream.slice(0, 12)} is in progress in ${dir}, not of main~1`,
        );
        writeFileSync(join(dir, "new.txt"), "new, edited after the merge\n");
        expect(() => safeCommit({ dir, paths: [], merge: upstream, message: "Merge" })).toThrow(
            "refusing: new.txt differ from the result of merging",
        );
        expect(head(dir)).toBe(before);
        const named = safeCommit({ dir, paths: ["new.txt"], merge: upstream, message: "Merge, new.txt edited" });
        expect(parents(dir, named.sha)).toEqual([before, upstream]);
        expect(git(dir, ["show", `${named.sha}:new.txt`])).toBe("new, edited after the merge");
        expect(git(dir, ["status", "--porcelain"])).toBe("");
    });
});
