import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeCommit } from "../src/projects/commit.ts";
import { git, head, repo, useGitEnv } from "./commit-fixture.ts";
import { GIT_ENV, tempDir } from "./helpers.ts";

// Real repos and cargo metadata per attempt; see commit.test.ts on the timeout.
setDefaultTimeout(180_000);
useGitEnv();

/** A workspace member that takes the workspace version, so a version bump on one side reaches it on merge. */
function crate(dir: string, name: string, dependency?: string): void {
    mkdirSync(join(dir, "crates", name, "src"), { recursive: true });
    const dependencies =
        dependency === undefined ? "" : `\n[dependencies]\n${dependency} = { path = "../${dependency}" }\n`;
    writeFileSync(
        join(dir, "crates", name, "Cargo.toml"),
        `[package]\nname = "${name}"\nversion.workspace = true\nedition = "2021"\n${dependencies}`,
    );
    writeFileSync(join(dir, "crates", name, "src", "lib.rs"), "");
}

const manifest = (version: string) =>
    `[workspace]\nmembers = ["crates/*"]\nresolver = "2"\n\n[workspace.package]\nversion = "${version}"\n`;

/**
 * The Cargo.lock entry of a member, in cargo's name order; `util` is every other member's dependency, so their
 * entries end in a dependency list that keeps the branch's new entry apart from the bumped version lines.
 */
const entry = (name: string, version: string) =>
    `\n[[package]]\nname = "${name}"\nversion = "${version}"\n${name === "util" ? "" : 'dependencies = [\n "util",\n]\n'}`;

/**
 * The upstream side bumps the workspace version (every member's lock entry with it); the checked-out branch adds a
 * crate. Both edit Cargo.lock in hunks apart, so the merge is clean, yet the branch's crate keeps the old version
 * in the merged lock file: `cargo metadata --locked` rejects it until one line is fixed.
 */
function staleLockMerge(): { dir: string; before: string; upstream: string; stale: string; fixed: string } {
    const lock = (version: string, piece: string | null) =>
        `version = 4\n${entry("app", version)}${piece === null ? "" : entry("piece", piece)}${entry("util", version)}`;
    const dir = repo({ "Cargo.toml": manifest("0.1.0"), "Cargo.lock": lock("0.1.0", null), ".gitignore": "target/\n" });
    crate(dir, "util");
    crate(dir, "app", "util");
    git(dir, ["add", "--all"]);
    git(dir, ["commit", "--quiet", "-m", "workspace"]);
    git(dir, ["switch", "--quiet", "-c", "upstream"]);
    writeFileSync(join(dir, "Cargo.toml"), manifest("0.2.0"));
    writeFileSync(join(dir, "Cargo.lock"), lock("0.2.0", null));
    git(dir, ["commit", "--quiet", "-am", "upstream: bump the workspace to 0.2.0"]);
    const upstream = head(dir);
    git(dir, ["switch", "--quiet", "main"]);
    crate(dir, "piece", "util");
    writeFileSync(join(dir, "Cargo.lock"), lock("0.1.0", "0.1.0"));
    git(dir, ["add", "--all"]);
    git(dir, ["commit", "--quiet", "-m", "piece: a new crate"]);
    return { dir, before: head(dir), upstream, stale: lock("0.2.0", "0.1.0"), fixed: lock("0.2.0", "0.2.0") };
}

const parents = (dir: string, sha: string): string[] =>
    git(dir, ["rev-list", "--parents", "-n", "1", sha]).split(" ").slice(1);

describe("bin/toli commit --merge of a clean merge that leaves Cargo.lock stale", () => {
    test("the bare merge fails the lock check; the fixed lock lands with it as one merge commit", () => {
        const { dir, before, upstream, stale, fixed } = staleLockMerge();
        const merge = (paths: string[], resolved = false) =>
            safeCommit({ dir, paths, merge: "upstream", resolved, message: "Merge upstream" });
        // The merged lock file is the stale one: upstream's bump with the branch's crate still at 0.1.0.
        const result = git(dir, ["merge-tree", "--write-tree", "main", "upstream"]);
        expect(git(dir, ["show", `${result}:Cargo.lock`])).toBe(stale.trimEnd());
        expect(() => merge([])).toThrow("cargo metadata --locked rejects the staged Cargo.lock");
        expect(() => merge([])).toThrow("name the fixed lock file: -- Cargo.lock");
        // A still-broken lock named on the clean merge, with or without --resolved, is refused just the same.
        writeFileSync(join(dir, "Cargo.lock"), stale);
        expect(() => merge(["Cargo.lock"])).toThrow("cargo metadata --locked rejects the staged Cargo.lock");
        expect(() => merge(["Cargo.lock"], true)).toThrow("cargo metadata --locked rejects the staged Cargo.lock");
        expect(head(dir)).toBe(before);

        writeFileSync(join(dir, "Cargo.lock"), fixed);
        const merged = merge(["Cargo.lock"], true);
        expect(parents(dir, merged.sha)).toEqual([before, upstream]);
        expect(merged.amended).toEqual(["Cargo.lock"]);
        expect(git(dir, ["show", "--no-patch", "--format=%B", merged.sha])).toBe(
            "Merge upstream\n\nMerge-amended: Cargo.lock",
        );
        expect(git(dir, ["show", `${merged.sha}:Cargo.lock`])).toBe(fixed.trimEnd());
        expect(git(dir, ["show", `${merged.sha}:Cargo.toml`])).toBe(manifest("0.2.0").trimEnd());
        expect(git(dir, ["status", "--porcelain"])).toBe("");
    });

    test("--resolved on a clean merge still refuses paths other than lock files", () => {
        const { dir, before } = staleLockMerge();
        writeFileSync(join(dir, "crates", "piece", "src", "lib.rs"), "pub fn piece() {}\n");
        expect(() =>
            safeCommit({
                dir,
                paths: ["crates/piece/src/lib.rs"],
                merge: "upstream",
                resolved: true,
                message: "Merge upstream",
            }),
        ).toThrow(
            "merging upstream has no conflicts; drop --resolved (on a clean merge it takes only fixed lock files)",
        );
        expect(head(dir)).toBe(before);
    });

    test("a fixed lock as a --patch on the clean merge lands in the merge commit; a broken one is refused", () => {
        const { dir, before, upstream, stale, fixed } = staleLockMerge();
        // The patch is made against the merge result, as `git diff` shows it after `git merge --no-commit`.
        const lockPatch = (to: string): string => {
            const scratch = tempDir("lock-patch");
            mkdirSync(join(scratch, "a"));
            mkdirSync(join(scratch, "b"));
            writeFileSync(join(scratch, "a", "Cargo.lock"), stale);
            writeFileSync(join(scratch, "b", "Cargo.lock"), to);
            // Empty prefixes over the a/ and b/ directories give the repo's own a/Cargo.lock b/Cargo.lock headers.
            return Bun.spawnSync(
                ["git", "diff", "--no-index", "--src-prefix=", "--dst-prefix=", "a/Cargo.lock", "b/Cargo.lock"],
                { cwd: scratch, env: { ...process.env, ...GIT_ENV }, stdout: "pipe", stderr: "pipe" },
            ).stdout.toString();
        };
        const patched = (diff: string) =>
            safeCommit({
                dir,
                paths: [],
                patches: [{ name: "lock.diff", diff }],
                merge: "upstream",
                message: "Merge upstream",
            });
        // A patch that leaves the lock file wrong (the new crate at a version no manifest gives) is still refused.
        const broken = fixed.replace('name = "piece"\nversion = "0.2.0"', 'name = "piece"\nversion = "0.9.0"');
        expect(broken).not.toBe(fixed);
        expect(() => patched(lockPatch(broken))).toThrow("cargo metadata --locked rejects the staged Cargo.lock");
        expect(head(dir)).toBe(before);

        const diff = lockPatch(fixed);
        expect(diff).toContain('+version = "0.2.0"');
        const committed = patched(diff);
        expect(parents(dir, committed.sha)).toEqual([before, upstream]);
        expect(committed.amended).toEqual(["Cargo.lock"]);
        expect(git(dir, ["show", "--no-patch", "--format=%B", committed.sha])).toBe(
            "Merge upstream\n\nMerge-amended: Cargo.lock",
        );
        expect(git(dir, ["show", `${committed.sha}:Cargo.lock`])).toBe(fixed.trimEnd());
    });
});
