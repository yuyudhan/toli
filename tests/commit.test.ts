import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeCommit } from "../src/projects/commit.ts";
import { parseHunks } from "../src/projects/diff-hunks.ts";
import { git, head, repo, useGitEnv } from "./commit-fixture.ts";

// safeCommit is git plumbing, and these tests prove it against real repos: the slowest --merge test runs ~175 git
// processes and 5 gitleaks scans, 56 s at load 65. That work is what is under test, so allow 3 minutes per test.
setDefaultTimeout(180_000);
useGitEnv();

/** Commit `text` to `file` the way another jawan would, without touching the shared index. */
function otherJawan(dir: string, file: string, text: string, message = `other: ${file}`): string {
    writeFileSync(join(dir, file), text);
    return safeCommit({ dir, paths: [file], message }).sha;
}

const changed = (dir: string, sha: string) => git(dir, ["show", "--name-only", "--format=", sha]).split("\n");

describe("bin/toli commit (R23 safe commits)", () => {
    test("commits only the named paths, from HEAD, ignoring the shared index", () => {
        const dir = repo({ "a.txt": "a\n", "b.txt": "b\n" });
        // Another jawan's half-done work sits staged in the shared index and unstaged in the tree.
        writeFileSync(join(dir, "b.txt"), "b staged by someone else\n");
        git(dir, ["add", "b.txt"]);
        writeFileSync(join(dir, "a.txt"), "a changed\n");
        const committed = safeCommit({ dir, paths: ["a.txt"], message: "Change a" });
        expect(head(dir)).toBe(committed.sha);
        expect(changed(dir, committed.sha)).toEqual(["a.txt"]);
        expect(git(dir, ["status", "--porcelain"])).toBe("M  b.txt");
    });

    test("a stale shared index can no longer revert other commits", () => {
        const dir = repo({ "a.txt": "a\n", "b.txt": "b\n" });
        // The shared index still holds the seed's b.txt while another jawan commits a new one.
        const other = otherJawan(dir, "b.txt", "b from the other jawan\n");
        writeFileSync(join(dir, "a.txt"), "a mine\n");
        const mine = safeCommit({ dir, paths: ["a.txt"], message: "Mine" });
        expect(git(dir, ["show", `${mine.sha}:b.txt`])).toBe("b from the other jawan");
        expect(mine.parent).toBe(other);
    });

    test("HEAD moving once is retried from the fresh tip; moving twice refuses", () => {
        const dir = repo({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
        writeFileSync(join(dir, "a.txt"), "a mine\n");
        let other = "";
        const retried = safeCommit(
            { dir, paths: ["a.txt"], message: "Mine" },
            {
                beforeUpdateRef: (attempt) => {
                    if (attempt === 1) other = otherJawan(dir, "b.txt", "b moved\n");
                },
            },
        );
        expect(retried.attempts).toBe(2);
        expect(retried.parent).toBe(other);
        expect(git(dir, ["show", `${retried.sha}:b.txt`])).toBe("b moved");

        writeFileSync(join(dir, "a.txt"), "a mine again\n");
        let n = 0;
        const before = head(dir);
        expect(() =>
            safeCommit(
                { dir, paths: ["a.txt"], message: "Mine again" },
                { beforeUpdateRef: () => void otherJawan(dir, "c.txt", `c moved ${++n}\n`) },
            ),
        ).toThrow("the branch moved twice");
        // Only the other jawan's two commits landed; mine did not.
        expect(git(dir, ["rev-list", "--count", `${before}..HEAD`])).toBe("2");
        expect(git(dir, ["show", "HEAD:a.txt"])).toBe("a mine");
    });

    test("refuses to revert lines of a recent commit, unless allowed by sha", () => {
        const stale = "fn main() {\n    run();\n}\n";
        const dir = repo({ "main.rs": stale });
        const recent = otherJawan(dir, "main.rs", "fn main() {\n    setup_logging_first();\n    run();\n}\n");
        // A jawan rewrites the file from its stale copy, adding its own line at the end.
        writeFileSync(join(dir, "main.rs"), `${stale}// mine\n`);
        const before = head(dir);
        expect(() => safeCommit({ dir, paths: ["main.rs"], message: "Mine" })).toThrow(
            `would revert main.rs lines from ${recent.slice(0, 7)}`,
        );
        expect(head(dir)).toBe(before);
        const allowed = safeCommit({
            dir,
            paths: ["main.rs"],
            message: "Undo logging",
            allowRevert: [recent.slice(0, 12)],
        });
        expect(allowed.parent).toBe(before);
    });

    test("an ordinary edit of recently changed lines is not a revert", () => {
        const dir = repo({ "a.txt": "first line of a\n" });
        otherJawan(dir, "a.txt", "second version of a\n");
        writeFileSync(join(dir, "a.txt"), "third version of a\n");
        expect(safeCommit({ dir, paths: ["a.txt"], message: "Third" }).files).toEqual(["a.txt"]);
    });

    test("adding back elsewhere a line a recent commit removed is not a revert; restoring it in place is", () => {
        const fields = (...names: string[]) =>
            `fn default() -> Self {\n    Self {\n${names.map((name) => `        ${name}: true,\n`).join("")}    }\n}\n`;
        const dir = repo({ "config.rs": fields("apps", "files", "calc") });
        // The recent commit drops `files` and adds fields after `calc`; mine only adds `files` back after those
        // (quickhop d8f9732 over 730f7dd).
        const recent = otherJawan(dir, "config.rs", fields("apps", "calc", "emoji", "scripts"));
        writeFileSync(join(dir, "config.rs"), fields("apps", "calc", "emoji", "scripts", "files"));
        expect(safeCommit({ dir, paths: ["config.rs"], message: "Files provider" }).parent).toBe(recent);
        // Restoring a recently removed line where it was is still refused.
        const dropped = otherJawan(dir, "config.rs", fields("apps", "calc", "emoji", "files"));
        writeFileSync(join(dir, "config.rs"), fields("apps", "calc", "emoji", "scripts", "files"));
        expect(() => safeCommit({ dir, paths: ["config.rs"], message: "Mine" })).toThrow(
            `would revert config.rs lines from ${dropped.slice(0, 7)}`,
        );
    });

    test("the revert check reads non-ASCII, quoted and spaced file names as stored", () => {
        const name = 'réglages "x" two.rs';
        const lines = (...names: string[]) => names.map((field) => `    ${field}: true,\n`).join("");
        const dir = repo({ [name]: lines("apps", "files", "calc") });
        // As above: adding back elsewhere a line a recent commit removed is a new change, not a revert.
        const recent = otherJawan(dir, name, lines("apps", "calc", "emoji", "scripts"));
        writeFileSync(join(dir, name), lines("apps", "calc", "emoji", "scripts", "files"));
        expect(safeCommit({ dir, paths: [name], message: "Files provider" }).parent).toBe(recent);
        const dropped = otherJawan(dir, name, lines("apps", "calc", "emoji", "files"));
        writeFileSync(join(dir, name), lines("apps", "calc", "emoji", "scripts", "files"));
        expect(() => safeCommit({ dir, paths: [name], message: "Mine" })).toThrow(
            `would revert ${name} lines from ${dropped.slice(0, 7)}`,
        );
    });

    test("--merge: what the merged ref brings is never a revert; edits on top still are", () => {
        const stale = "fn main() {\n    run();\n}\n";
        const dir = repo({ "main.rs": stale });
        const added = otherJawan(dir, "query.json", '{ "query": "select id from tickets" }\n');
        const recent = otherJawan(dir, "main.rs", "fn main() {\n    setup_logging_first();\n    run();\n}\n");
        // Upstream already has the query file and deletes it; the branch has not seen that yet.
        git(dir, ["switch", "--quiet", "-c", "upstream", added]);
        git(dir, ["rm", "--quiet", "query.json"]);
        git(dir, ["commit", "--quiet", "-m", "upstream: drop query.json"]);
        git(dir, ["switch", "--quiet", "main"]);

        // A hand-made revert of a recent commit on top of the merge is still refused.
        writeFileSync(join(dir, "main.rs"), `${stale}// mine\n`);
        const before = head(dir);
        expect(() =>
            safeCommit({ dir, paths: ["main.rs"], merge: "upstream", message: "Merge upstream and mine" }),
        ).toThrow(`would revert main.rs lines from ${recent.slice(0, 7)}`);
        expect(head(dir)).toBe(before);
        git(dir, ["checkout", "--quiet", "--", "main.rs"]);

        const merged = safeCommit({ dir, paths: [], merge: "upstream", message: "Merge upstream" });
        expect(merged.merged).toEqual(["query.json"]);
        expect(git(dir, ["ls-tree", "--name-only", merged.sha])).toBe("main.rs");
    });

    test("--merge --resolved commits a conflict resolved in the working tree, with every check still on", () => {
        const gap = "keep 1\nkeep 2\nkeep 3\nkeep 4\nkeep 5\nkeep 6\n";
        const file = (first: string, second: string) => `${first}\n${gap}${second}\n`;
        const dir = repo({ "app.txt": file("first original line", "second original line") });
        const recent = otherJawan(dir, "app.txt", file("first changed line", "second original line"));
        // Upstream has that commit, undoes it, and changes the second line; the branch changes the second line too.
        git(dir, ["switch", "--quiet", "-c", "upstream", recent]);
        writeFileSync(join(dir, "app.txt"), file("first original line", "second upstream line"));
        writeFileSync(join(dir, "new.txt"), "from upstream\n");
        git(dir, ["add", "--all"]);
        git(dir, ["commit", "--quiet", "-m", "upstream: undo first, change second"]);
        git(dir, ["switch", "--quiet", "main"]);
        const mine = otherJawan(dir, "app.txt", file("first changed line", "second main line"));
        const before = head(dir);

        expect(() => safeCommit({ dir, paths: [], merge: "upstream", message: "Merge" })).toThrow(
            "merging upstream has conflicts in app.txt",
        );
        expect(() => safeCommit({ dir, paths: [], merge: "upstream", message: "Merge" })).toThrow(
            "--resolved -- app.txt",
        );
        expect(() => safeCommit({ dir, paths: [], merge: "upstream", resolved: true, message: "Merge" })).toThrow(
            "conflicted app.txt not named",
        );
        writeFileSync(
            join(dir, "app.txt"),
            `first original line\n${gap}<<<<<<< main\nsecond main line\n=======\nsecond upstream line\n>>>>>>> upstream\n`,
        );
        const resolve = () =>
            safeCommit({ dir, paths: ["app.txt"], merge: "upstream", resolved: true, message: "Merge upstream" });
        expect(resolve).toThrow("app.txt still has a merge conflict marker <<<<<<<");
        // A resolution that hand-undoes the branch's own recent commit is still a revert.
        writeFileSync(join(dir, "app.txt"), file("first original line", "second original line"));
        expect(resolve).toThrow(`would revert app.txt lines from ${mine.slice(0, 7)}`);
        expect(head(dir)).toBe(before);
        expect(() => safeCommit({ dir, paths: ["app.txt"], resolved: true, message: "x" })).toThrow(
            "--resolved goes with --merge",
        );

        // Upstream's undo of `recent`, kept as it is, is what the merge brings, not a revert.
        const resolved = file("first original line", "second resolved line");
        writeFileSync(join(dir, "app.txt"), resolved);
        const merged = resolve();
        expect(git(dir, ["rev-list", "--parents", "-n", "1", merged.sha]).split(" ")).toEqual([
            merged.sha,
            before,
            git(dir, ["rev-parse", "upstream"]),
        ]);
        expect(git(dir, ["show", `${merged.sha}:app.txt`])).toBe(resolved.trimEnd());
        expect(git(dir, ["show", `${merged.sha}:new.txt`])).toBe("from upstream");
        expect(git(dir, ["status", "--porcelain"])).toBe("");

        git(dir, ["switch", "--quiet", "-c", "clean"]);
        writeFileSync(join(dir, "other.txt"), "no conflict\n");
        git(dir, ["add", "other.txt"]);
        git(dir, ["commit", "--quiet", "-m", "clean: other.txt"]);
        git(dir, ["switch", "--quiet", "main"]);
        otherJawan(dir, "main-only.txt", "main\n");
        expect(() => safeCommit({ dir, paths: [], merge: "clean", resolved: true, message: "Merge clean" })).toThrow(
            "merging clean has no conflicts; drop --resolved",
        );
    });

    test("refuses lock files that do not parse", () => {
        const dir = repo();
        writeFileSync(
            join(dir, "Cargo.lock"),
            'version = 4\n<<<<<<< HEAD\n[[package]]\nname = "a"\n=======\n>>>>>>> other\n',
        );
        expect(() => safeCommit({ dir, paths: ["Cargo.lock"], message: "Lock" })).toThrow(
            "the staged Cargo.lock does not parse",
        );
        writeFileSync(join(dir, "bun.lock"), '{\n  "lockfileVersion": 1,\n<<<<<<< HEAD\n}\n');
        expect(() => safeCommit({ dir, paths: ["bun.lock"], message: "Lock" })).toThrow(
            "the staged bun.lock does not parse",
        );
        writeFileSync(join(dir, "bun.lock"), '{\n  "lockfileVersion": 1,\n  "workspaces": {},\n}\n');
        expect(safeCommit({ dir, paths: ["bun.lock"], message: "Lock" }).files).toEqual(["bun.lock"]);
    });

    test("--merge --resolved checks Cargo.lock against the merged tree, including the crates the merge adds", () => {
        const manifest = (members: string[]) =>
            `[workspace]\nmembers = [${members.map((name) => `"${name}"`).join(", ")}]\nresolver = "2"\n`;
        const lock = (members: string[]) =>
            `version = 4\n${members.map((name) => `\n[[package]]\nname = "${name}"\nversion = "0.1.0"\n`).join("")}`;
        const crate = (dir: string, name: string) => {
            mkdirSync(join(dir, name, "src"), { recursive: true });
            writeFileSync(
                join(dir, name, "Cargo.toml"),
                `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n`,
            );
            writeFileSync(join(dir, name, "src", "lib.rs"), "");
        };
        const dir = repo({ "Cargo.toml": manifest(["a"]), "Cargo.lock": lock(["a"]), ".gitignore": "target/\n" });
        crate(dir, "a");
        git(dir, ["add", "--all"]);
        git(dir, ["commit", "--quiet", "-m", "crate a"]);
        // Upstream adds crate b, the branch adds crate c: both change the members and the lock file.
        git(dir, ["switch", "--quiet", "-c", "upstream"]);
        crate(dir, "b");
        writeFileSync(join(dir, "Cargo.toml"), manifest(["a", "b"]));
        writeFileSync(join(dir, "Cargo.lock"), lock(["a", "b"]));
        git(dir, ["add", "--all"]);
        git(dir, ["commit", "--quiet", "-m", "upstream: crate b"]);
        git(dir, ["switch", "--quiet", "main"]);
        crate(dir, "c");
        writeFileSync(join(dir, "Cargo.toml"), manifest(["a", "c"]));
        writeFileSync(join(dir, "Cargo.lock"), lock(["a", "c"]));
        git(dir, ["add", "--all"]);
        git(dir, ["commit", "--quiet", "-m", "main: crate c"]);
        const before = head(dir);

        // Crate b's files reach the working tree only once the merge is committed.
        writeFileSync(join(dir, "Cargo.toml"), manifest(["a", "b", "c"]));
        const resolve = () =>
            safeCommit({
                dir,
                paths: ["Cargo.toml", "Cargo.lock"],
                merge: "upstream",
                resolved: true,
                message: "Merge upstream",
            });
        writeFileSync(join(dir, "Cargo.lock"), lock(["a", "b"]));
        expect(resolve).toThrow("cargo metadata --locked rejects the staged Cargo.lock");
        expect(head(dir)).toBe(before);

        writeFileSync(join(dir, "Cargo.lock"), lock(["a", "b", "c"]));
        const merged = resolve();
        expect(git(dir, ["show", `${merged.sha}:Cargo.lock`])).toBe(lock(["a", "b", "c"]).trimEnd());
        expect(git(dir, ["show", `${merged.sha}:b/Cargo.toml`])).toContain('name = "b"');
        expect(git(dir, ["status", "--porcelain"])).toBe("");
    });

    test("--merge takes a named, regenerated Cargo.lock when the clean merge leaves the lock stale", () => {
        const lock = (members: string[]) =>
            `version = 4\n${members.map((name) => `\n[[package]]\nname = "${name}"\nversion = "0.1.0"\n`).join("")}`;
        const crate = (dir: string, name: string) => {
            mkdirSync(join(dir, "crates", name, "src"), { recursive: true });
            writeFileSync(
                join(dir, "crates", name, "Cargo.toml"),
                `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n`,
            );
            writeFileSync(join(dir, "crates", name, "src", "lib.rs"), "");
        };
        const dir = repo({
            "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\nresolver = "2"\n',
            "Cargo.lock": lock(["a"]),
            ".gitignore": "target/\n",
        });
        crate(dir, "a");
        git(dir, ["add", "--all"]);
        git(dir, ["commit", "--quiet", "-m", "crate a"]);
        // Upstream adds crate b and touches the lock without its entry: the lock merges cleanly yet misses b.
        git(dir, ["switch", "--quiet", "-c", "upstream"]);
        crate(dir, "b");
        writeFileSync(join(dir, "Cargo.lock"), `# upstream\n${lock(["a"])}`);
        git(dir, ["add", "--all"]);
        git(dir, ["commit", "--quiet", "-m", "upstream: crate b"]);
        git(dir, ["switch", "--quiet", "main"]);
        writeFileSync(join(dir, "main.txt"), "main\n");
        git(dir, ["add", "--all"]);
        git(dir, ["commit", "--quiet", "-m", "main: unrelated"]);
        const before = head(dir);
        const merge = (paths: string[]) => () =>
            safeCommit({ dir, paths, merge: "upstream", message: "Merge upstream" });

        expect(merge([])).toThrow("cargo metadata --locked rejects the staged Cargo.lock");
        // A named lock is still checked: a wrong one is refused.
        writeFileSync(join(dir, "Cargo.lock"), lock(["a", "c"]));
        expect(merge(["Cargo.lock"])).toThrow("cargo metadata --locked rejects the staged Cargo.lock");
        expect(head(dir)).toBe(before);

        writeFileSync(join(dir, "Cargo.lock"), lock(["a", "b"]));
        const merged = merge(["Cargo.lock"])();
        expect(git(dir, ["show", `${merged.sha}:Cargo.lock`])).toBe(lock(["a", "b"]).trimEnd());
        expect(git(dir, ["show", `${merged.sha}:crates/b/Cargo.toml`])).toContain('name = "b"');
        expect(git(dir, ["rev-parse", `${merged.sha}^2`])).toBe(git(dir, ["rev-parse", "upstream"]));
        expect(git(dir, ["status", "--porcelain"])).toBe("");
    });

    test("refuses a staged secret (gitleaks) and commits nothing", () => {
        const dir = repo();
        const token = `ghp_${Array.from(crypto.getRandomValues(new Uint8Array(36)), (byte) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[byte % 62]).join("")}`;
        writeFileSync(join(dir, "config.txt"), `token = "${token}"\n`);
        const before = head(dir);
        expect(() => safeCommit({ dir, paths: ["config.txt"], message: "Config" })).toThrow("gitleaks found a secret");
        expect(head(dir)).toBe(before);
    });

    test("--patch commits only the given hunks", () => {
        const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
        const dir = repo({ "f.txt": `${lines.join("\n")}\n` });
        const edited = [...lines];
        edited[1] = "line 2 changed";
        edited[28] = "line 29 changed";
        writeFileSync(join(dir, "f.txt"), `${edited.join("\n")}\n`);
        const full = git(dir, ["diff", "f.txt"]);
        const firstHunk = `${full.split("\n@@").slice(0, 2).join("\n@@")}\n`;
        const committed = safeCommit({
            dir,
            paths: [],
            patches: [{ name: "first.patch", diff: firstHunk }],
            message: "First hunk",
        });
        const blob = git(dir, ["show", `${committed.sha}:f.txt`]);
        expect(blob).toContain("line 2 changed");
        expect(blob).not.toContain("line 29 changed");
        expect(git(dir, ["diff", "--name-only"])).toBe("f.txt");
    });

    test("nothing to commit and no paths are refusals", () => {
        const dir = repo();
        expect(() => safeCommit({ dir, paths: ["README.md"], message: "Same" })).toThrow("nothing to commit");
        expect(() => safeCommit({ dir, paths: [], message: "None" })).toThrow("commit needs paths");
    });

    test("parseHunks reads -U0 diffs per file", () => {
        const diff = [
            "diff --git a/x b/x",
            "--- a/x",
            "+++ b/x",
            "@@ -1 +1 @@",
            "-old",
            "+new",
            "@@ -5,0 +6 @@",
            "+added",
        ].join("\n");
        expect(parseHunks(diff)).toEqual([
            { file: "x", removed: ["old"], added: ["new"], oldStart: 1, newStart: 1 },
            { file: "x", removed: [], added: ["added"], oldStart: 5, newStart: 6 },
        ]);
    });
});
