import { describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
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

/** Move `main` by one empty commit the way another committer would, leaving the shared index and working tree. */
function moveMain(dir: string): string {
    const moved = git(dir, ["commit-tree", "main^{tree}", "-p", "main", "-m", "other: moved"]);
    git(dir, ["update-ref", "refs/heads/main", moved]);
    return moved;
}

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

    test("--merge --resolved clears the conflict stages of a path resolved to the branch's side, keeping unrelated staged work", () => {
        const { dir, before, upstream } = diverged(true);
        startMerge(dir);
        expect(git(dir, ["ls-files", "-u"])).not.toBe("");
        // Resolved to main's side, so shared.txt ends as in the first parent and is not among the changed files.
        git(dir, ["checkout", "--ours", "--", "shared.txt"]);
        writeFileSync(join(dir, "other.txt"), "staged, not named\n");
        git(dir, ["add", "--", "other.txt"]);
        const merged = safeCommit({
            dir,
            paths: ["shared.txt"],
            merge: "MERGE_HEAD",
            resolved: true,
            message: "Merge upstream, keeping main's shared.txt",
        });
        expect(parents(dir, merged.sha)).toEqual([before, upstream]);
        expect(git(dir, ["show", `${merged.sha}:shared.txt`])).toBe("one main\ntwo\nthree");
        expect(git(dir, ["ls-files", "-u"])).toBe("");
        expect(git(dir, ["status", "--porcelain", "--", "shared.txt", "new.txt"])).toBe("");
        expect(git(dir, ["status", "--porcelain"])).toBe("A  other.txt");
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

    test("a merge that deletes a file commits without a warning, adopted or not, leaving index and tree at HEAD", () => {
        const stderr: string[] = [];
        const spy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
            stderr.push(String(chunk));
            return true;
        });
        try {
            for (const adopt of [true, false]) {
                const dir = repo({ "gone.txt": "gone\n", "kept.txt": "kept\n", "mine.txt": "mine\n" });
                git(dir, ["switch", "--quiet", "-c", "upstream"]);
                git(dir, ["rm", "--quiet", "--", "gone.txt"]);
                writeFileSync(join(dir, "kept.txt"), "kept upstream\n");
                git(dir, ["commit", "--quiet", "-am", "upstream deletes gone.txt"]);
                git(dir, ["switch", "--quiet", "main"]);
                writeFileSync(join(dir, "mine.txt"), "mine on main\n");
                git(dir, ["commit", "--quiet", "-am", "main work"]);
                if (adopt) startMerge(dir);
                const merged = safeCommit({ dir, paths: [], merge: "upstream", message: "Merge upstream" });
                expect(git(dir, ["ls-tree", "--name-only", merged.sha])).toBe("kept.txt\nmine.txt");
                expect(existsSync(join(dir, "gone.txt"))).toBe(false);
                expect(git(dir, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
            }
        } finally {
            spy.mockRestore();
        }
        expect(stderr).toEqual([]);
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

    test("an adopted merge keeps every refusal (secrets, lock files, reverts, the commit-msg hook, a branch moved twice) and commits only named paths", () => {
        const { dir, before, upstream } = diverged(false);
        startMerge(dir);
        const land = (paths: string[]) => () => safeCommit({ dir, paths, merge: upstream, message: "Merge upstream" });
        const untouched = (tip: string) => {
            expect(head(dir)).toBe(tip);
            expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(true);
        };

        // A random GitHub token shape, generated per run, for gitleaks to find.
        const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        const generated = Array.from(crypto.getRandomValues(new Uint8Array(36)), (byte) => alphabet[byte % 62]);
        writeFileSync(join(dir, "config.txt"), `ghp_${generated.join("")}\n`);
        expect(land(["config.txt"])).toThrow("gitleaks found a secret");
        untouched(before);
        rmSync(join(dir, "config.txt"));

        writeFileSync(join(dir, "bun.lock"), '{\n  "lockfileVersion": 1,\n<<<<<<< HEAD\n}\n');
        expect(land(["bun.lock"])).toThrow("the staged bun.lock does not parse");
        untouched(before);
        rmSync(join(dir, "bun.lock"));

        // Undoing main's own recent "three main" line on top of the merge is still a revert.
        writeFileSync(join(dir, "shared.txt"), "one upstream\ntwo\nthree\n");
        expect(land(["shared.txt"])).toThrow(`would revert shared.txt lines from ${before.slice(0, 7)}`);
        untouched(before);
        git(dir, ["checkout", "--", "shared.txt"]);

        const hook = join(dir, ".git", "hooks", "commit-msg");
        writeFileSync(hook, "#!/bin/sh\necho 'merges need a ticket' >&2\nexit 1\n");
        chmodSync(hook, 0o755);
        expect(land([])).toThrow("the commit-msg hook");
        untouched(before);
        rmSync(hook);

        let moved = before;
        expect(() =>
            safeCommit(
                { dir, paths: [], merge: upstream, message: "Merge upstream" },
                {
                    beforeUpdateRef: () => {
                        moved = moveMain(dir);
                    },
                },
            ),
        ).toThrow("the branch moved twice");
        untouched(moved);

        // Moved once, it retries from the new tip; unnamed local edits outside the merge stay out of the commit.
        writeFileSync(join(dir, "mine.txt"), "mine, not named\n");
        writeFileSync(join(dir, "stray.txt"), "untracked, not named\n");
        const merged = safeCommit(
            { dir, paths: [], merge: upstream, message: "Merge upstream" },
            {
                beforeUpdateRef: (attempt) => {
                    if (attempt === 1) moved = moveMain(dir);
                },
            },
        );
        expect(merged.attempts).toBe(2);
        expect(parents(dir, merged.sha)).toEqual([moved, upstream]);
        expect(git(dir, ["show", `${merged.sha}:mine.txt`])).toBe("mine on main");
        expect(git(dir, ["ls-tree", "--name-only", merged.sha])).toBe("mine.txt\nnew.txt\nshared.txt");
        expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(false);
        expect(git(dir, ["status", "--porcelain"])).toBe("M mine.txt\n?? stray.txt");
    }, 180_000);
});
