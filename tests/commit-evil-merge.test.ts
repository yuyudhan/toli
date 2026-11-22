import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
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

    test("a clean merge without --resolved still refuses edits to the paths it changes", () => {
        const { dir, before } = diverged(false);
        expect(() =>
            safeCommit({
                dir,
                paths: [],
                patches: [{ name: "lib.patch", diff: libPatch("lib upstream", "lib upstream fixed") }],
                merge: "upstream",
                message: "Merge upstream",
            }),
        ).toThrow("lib.txt changed by both the merge and the named paths; name them with --resolved");
        writeFileSync(join(dir, "new.txt"), "new from upstream, fixed\n");
        expect(() => safeCommit({ dir, paths: ["new.txt"], merge: "upstream", message: "Merge upstream" })).toThrow(
            "local changes to files the merge changes: new.txt",
        );
        expect(head(dir)).toBe(before);
    });

    test("a clean merge with --resolved takes named and patched fixes in one two-parent commit, and records them", () => {
        const { dir, before, upstream } = diverged(false);
        writeFileSync(join(dir, "new.txt"), "new from upstream, fixed\n");
        // A path the merge does not touch is committed as on a conflicted merge: staged, not an amendment.
        writeFileSync(join(dir, "notes.txt"), "notes\n");
        const merged = safeCommit({
            dir,
            paths: ["new.txt", "notes.txt"],
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
        expect(git(dir, ["show", `${merged.sha}:app.txt`])).toBe("app upstream");
        expect(git(dir, ["show", `${merged.sha}:new.txt`])).toBe("new from upstream, fixed");
        expect(git(dir, ["show", `${merged.sha}:lib.txt`])).toBe("lib upstream fixed");
        expect(git(dir, ["show", `${merged.sha}:notes.txt`])).toBe("notes");
        expect(merged.amended).toEqual(["lib.txt", "new.txt"]);
        expect(git(dir, ["log", "-1", "--format=%B", merged.sha])).toBe(
            "Merge upstream\n\nMerge-amended: lib.txt\nMerge-amended: new.txt",
        );
        expect(git(dir, ["status", "--porcelain"])).toBe("");
    });

    test("a clean merge with --resolved keeps every refusal: secrets, reverts, a --resolved naming no fix", () => {
        const { dir } = diverged(false);
        writeFileSync(join(dir, "main.txt"), "app main, second\n");
        git(dir, ["commit", "--quiet", "-am", "main: second"]);
        const recent = head(dir);
        const commit = (paths: string[]) => () =>
            safeCommit({ dir, paths, merge: "upstream", resolved: true, message: "Merge upstream" });
        expect(commit([])).toThrow(
            "refusing: --resolved, but merging upstream has no conflicts and names no fixes; drop --resolved",
        );
        const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        const pat = [
            "ghp",
            Array.from(crypto.getRandomValues(new Uint8Array(36)), (byte) => alphabet[byte % 62]).join(""),
        ];
        writeFileSync(join(dir, "new.txt"), `${pat.join("_")}\n`);
        expect(commit(["new.txt"])).toThrow("gitleaks found a secret");
        writeFileSync(join(dir, "new.txt"), "new from upstream, fixed\n");
        // A stale copy of the branch's own recent main.txt, named with the fix, is still a revert.
        writeFileSync(join(dir, "main.txt"), "app main\n");
        expect(commit(["new.txt", "main.txt"])).toThrow(`would revert main.txt lines from ${recent.slice(0, 7)}`);
        expect(head(dir)).toBe(recent);
    });

    test("a clean merge leaving an allowlist stale lands with its fix past the pre-commit guard", () => {
        // main moved old.txt to moved.txt and fixed the allowlist; upstream, branched before, allows a line of
        // old.txt in a hunk apart. The merge is clean, yet its allowlist names a file that no longer exists.
        const spacer = "# keep\n".repeat(6);
        const dir = repo({ "allow.txt": `old.txt:1\n${spacer}`, "old.txt": "one\ntwo\n" });
        git(dir, ["switch", "--quiet", "-c", "upstream"]);
        writeFileSync(join(dir, "allow.txt"), `old.txt:1\n${spacer}old.txt:2\n`);
        git(dir, ["commit", "--quiet", "-am", "upstream: allow old.txt:2"]);
        const upstream = head(dir);
        git(dir, ["switch", "--quiet", "main"]);
        git(dir, ["mv", "old.txt", "moved.txt"]);
        writeFileSync(join(dir, "allow.txt"), `moved.txt:1\n${spacer}`);
        git(dir, ["commit", "--quiet", "-am", "main: move old.txt"]);
        const before = head(dir);
        const hook = join(dir, ".git", "hooks", "pre-commit");
        writeFileSync(
            hook,
            [
                "#!/bin/sh",
                'grep -v "^#" allow.txt | while IFS= read -r line; do',
                '    [ -e "${line%%:*}" ] || { echo "stale allowlist entry: $line" >&2; exit 1; }',
                "done",
                "",
            ].join("\n"),
        );
        chmodSync(hook, 0o755);

        expect(() => safeCommit({ dir, paths: [], merge: "upstream", message: "Merge upstream" })).toThrow(
            "stale allowlist entry: old.txt:2",
        );
        writeFileSync(join(dir, "allow.txt"), `moved.txt:1\n${spacer}moved.txt:2\n`);
        expect(() => safeCommit({ dir, paths: ["allow.txt"], merge: "upstream", message: "Merge upstream" })).toThrow(
            "local changes to files the merge changes: allow.txt",
        );
        expect(head(dir)).toBe(before);

        const merged = safeCommit({
            dir,
            paths: ["allow.txt"],
            merge: "upstream",
            resolved: true,
            message: "Merge upstream",
        });
        expect(git(dir, ["rev-list", "--parents", "-n", "1", merged.sha]).split(" ")).toEqual([
            merged.sha,
            before,
            upstream,
        ]);
        expect(git(dir, ["show", `${merged.sha}:allow.txt`])).toBe(`moved.txt:1\n${spacer}moved.txt:2`);
        expect(git(dir, ["log", "-1", "--format=%B", merged.sha])).toBe("Merge upstream\n\nMerge-amended: allow.txt");
        expect(git(dir, ["status", "--porcelain"])).toBe("");
    });
});
