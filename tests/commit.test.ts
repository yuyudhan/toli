import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeCommit } from "../src/projects/commit.ts";
import { parseHunks } from "../src/projects/commit-checks.ts";
import { GIT_ENV } from "./helpers.ts";

const temps: string[] = [];
const saved = Object.keys(GIT_ENV).map((key) => [key, process.env[key]] as const);

beforeAll(() => Object.assign(process.env, GIT_ENV));
afterAll(() => {
    for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, args: string[]): string {
    const proc = Bun.spawnSync(["git", "-C", dir, ...args], {
        env: { ...process.env, ...GIT_ENV },
        stdout: "pipe",
        stderr: "pipe",
    });
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
    return proc.stdout.toString().trim();
}

/** A repo on `main` with one commit holding `files`. */
function repo(files: Record<string, string> = { "README.md": "# app\n" }): string {
    const dir = mkdtempSync(join(tmpdir(), "toli-commit-"));
    temps.push(dir);
    git(dir, ["init", "--quiet", "-b", "main"]);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    git(dir, ["add", "--all"]);
    git(dir, ["commit", "--quiet", "-m", "seed"]);
    return dir;
}

/** Commit `text` to `file` the way another jawan would, without touching the shared index. */
function otherJawan(dir: string, file: string, text: string, message = `other: ${file}`): string {
    writeFileSync(join(dir, file), text);
    return safeCommit({ dir, paths: [file], message }).sha;
}

const head = (dir: string) => git(dir, ["rev-parse", "HEAD"]);
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
        const committed = safeCommit({ dir, paths: [], patch: firstHunk, message: "First hunk" });
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
            { file: "x", removed: ["old"], added: ["new"] },
            { file: "x", removed: [], added: ["added"] },
        ]);
    });
});
