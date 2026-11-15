import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeCommit } from "../src/projects/commit.ts";
import { git, head, repo, useGitEnv } from "./commit-fixture.ts";

// Real repos, gitleaks scans and several merges per test (see commit.test.ts).
setDefaultTimeout(180_000);
useGitEnv();

/** A diff turning `lib.txt` from `from` into `to`, as `git diff` writes it. */
const libPatch = (from: string, to: string) =>
    `diff --git a/lib.txt b/lib.txt\n--- a/lib.txt\n+++ b/lib.txt\n@@ -1 +1 @@\n-${from}\n+${to}\n`;

/**
 * main and upstream both change app.txt (a conflict when `conflicted`); upstream alone also changes lib.txt and adds
 * new.txt and bun.lock, which merge cleanly. Returns the checkout on main and its tip.
 */
function diverged(conflicted: boolean): { dir: string; before: string; upstream: string } {
    const dir = repo({ "app.txt": "app\n", "lib.txt": "lib\n" });
    git(dir, ["switch", "--quiet", "-c", "upstream"]);
    writeFileSync(join(dir, "app.txt"), "app upstream\n");
    writeFileSync(join(dir, "lib.txt"), "lib upstream\n");
    writeFileSync(join(dir, "new.txt"), "new from upstream\n");
    writeFileSync(join(dir, "bun.lock"), '{\n  "lockfileVersion": 1,\n  "workspaces": {},\n}\n');
    git(dir, ["add", "--all"]);
    git(dir, ["commit", "--quiet", "-m", "upstream: app, lib, new, lock"]);
    git(dir, ["switch", "--quiet", "main"]);
    writeFileSync(join(dir, conflicted ? "app.txt" : "main.txt"), "app main\n");
    git(dir, ["add", "--all"]);
    git(dir, ["commit", "--quiet", "-m", "main: app"]);
    return { dir, before: head(dir), upstream: git(dir, ["rev-parse", "upstream"]) };
}

describe("bin/toli commit --merge --resolved amending paths the merge changed (evil merge)", () => {
    test("one two-parent commit takes named and patched fixes to merge-changed paths, and records them", () => {
        const { dir, before, upstream } = diverged(true);
        writeFileSync(join(dir, "app.txt"), "app main and upstream\n");
        // new.txt, which only upstream adds, needs a fix the bare merge result lacks; so does upstream's lib.txt.
        writeFileSync(join(dir, "new.txt"), "new from upstream, fixed\n");
        const merged = safeCommit({
            dir,
            paths: ["app.txt", "new.txt"],
            patches: [{ name: "lib.patch", diff: libPatch("lib upstream", "lib upstream fixed") }],
            merge: "upstream",
            resolved: true,
            message: "Merge upstream",
        });
        expect(git(dir, ["rev-list", "--parents", "-n", "1", merged.sha]).split(" ")).toEqual([
            merged.sha,
            before,
            upstream,
        ]);
        expect(git(dir, ["show", `${merged.sha}:app.txt`])).toBe("app main and upstream");
        expect(git(dir, ["show", `${merged.sha}:new.txt`])).toBe("new from upstream, fixed");
        expect(git(dir, ["show", `${merged.sha}:lib.txt`])).toBe("lib upstream fixed");
        expect(git(dir, ["show", `${merged.sha}:bun.lock`])).toContain("lockfileVersion");
        // The amended merge-changed paths (not the conflict, not the untouched merged files) are named for review.
        expect(merged.amended).toEqual(["lib.txt", "new.txt"]);
        expect(git(dir, ["log", "-1", "--format=%B", merged.sha])).toBe(
            "Merge upstream\n\nMerge-amended: lib.txt\nMerge-amended: new.txt",
        );
        expect(git(dir, ["status", "--porcelain"])).toBe("");
        expect(readFileSync(join(dir, "lib.txt"), "utf8")).toBe("lib upstream fixed\n");
    });

    test("a resolved merge without amendments records none", () => {
        const { dir } = diverged(true);
        writeFileSync(join(dir, "app.txt"), "app main and upstream\n");
        const merged = safeCommit({
            dir,
            paths: ["app.txt"],
            merge: "upstream",
            resolved: true,
            message: "Merge upstream",
        });
        expect(merged.amended).toEqual([]);
        expect(git(dir, ["log", "-1", "--format=%B", merged.sha])).toBe("Merge upstream");
    });

    test("secrets and unparsable lock files in amended merge-changed paths are still refused", () => {
        const { dir, before } = diverged(true);
        writeFileSync(join(dir, "app.txt"), "app main and upstream\n");
        // A random GitHub token shape that gitleaks' github-pat rule matches on its own.
        const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        const pat = [
            "ghp",
            Array.from(crypto.getRandomValues(new Uint8Array(36)), (byte) => alphabet[byte % 62]).join(""),
        ];
        writeFileSync(join(dir, "new.txt"), `${pat.join("_")}\n`);
        const commit = (paths: string[]) => () =>
            safeCommit({ dir, paths, merge: "upstream", resolved: true, message: "Merge upstream" });
        expect(commit(["app.txt", "new.txt"])).toThrow("gitleaks found a secret");
        writeFileSync(join(dir, "new.txt"), "new from upstream, fixed\n");
        writeFileSync(join(dir, "bun.lock"), '{\n  "lockfileVersion": 1,\n<<<<<<< HEAD\n}\n');
        expect(commit(["app.txt", "new.txt", "bun.lock"])).toThrow("the staged bun.lock does not parse");
        expect(head(dir)).toBe(before);
        expect(readFileSync(join(dir, "lib.txt"), "utf8")).toBe("lib\n");
    });

    test("a clean merge still refuses edits to the paths it changes", () => {
        const { dir, before } = diverged(false);
        expect(() =>
            safeCommit({
                dir,
                paths: [],
                patches: [{ name: "lib.patch", diff: libPatch("lib upstream", "lib upstream fixed") }],
                merge: "upstream",
                message: "Merge upstream",
            }),
        ).toThrow("lib.txt changed by both the merge and the named paths");
        writeFileSync(join(dir, "new.txt"), "new from upstream, fixed\n");
        expect(() => safeCommit({ dir, paths: ["new.txt"], merge: "upstream", message: "Merge upstream" })).toThrow(
            "local changes to files the merge changes: new.txt",
        );
        expect(head(dir)).toBe(before);
    });
});
