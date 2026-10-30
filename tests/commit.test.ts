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
