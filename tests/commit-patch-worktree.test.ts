import { describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeCommit } from "../src/projects/commit.ts";
import { git, head, repo, useGitEnv } from "./commit-fixture.ts";
import { tempDir } from "./helpers.ts";

// T2106: `bin/toli commit --patch` must leave the patched files in the working tree at the new HEAD, as a commit of
// named paths does, without touching other uncommitted work or the user's own edits in those files.
setDefaultTimeout(180_000);
useGitEnv();

const SEED = { "edit.txt": "one\ntwo\n", "gone.txt": "gone\n", "other.txt": "other\n" };

/**
 * The patch of an edit, a new file and a deletion, made in `dir` and then undone so the working tree is clean;
 * also written to a file outside the repo for `git apply`.
 */
function patchOf(dir: string): { diff: string; file: string } {
    writeFileSync(join(dir, "edit.txt"), "one\ntwo patched\n");
    writeFileSync(join(dir, "new.txt"), "new\n");
    rmSync(join(dir, "gone.txt"));
    git(dir, ["add", "--all"]);
    const diff = `${git(dir, ["diff", "--cached", "--binary"])}\n`;
    git(dir, ["reset", "--quiet", "--hard", "HEAD"]);
    const file = join(tempDir("patch"), "p.diff");
    writeFileSync(file, diff);
    return { diff, file };
}

/** Run `body`, returning what it wrote to stderr. */
function stderrOf(body: () => void): string {
    const lines: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
        lines.push(String(chunk));
        return true;
    });
    try {
        body();
    } finally {
        spy.mockRestore();
    }
    return lines.join("");
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");

describe("bin/toli commit --patch: the working tree follows the commit (T2106)", () => {
    test("patched files not in the working tree are brought to the new HEAD; other uncommitted work stays", () => {
        const dir = repo(SEED);
        const { diff } = patchOf(dir);
        writeFileSync(join(dir, "other.txt"), "other, the user's uncommitted edit\n");
        const stderr = stderrOf(() => {
            const committed = safeCommit({ dir, paths: [], patches: [{ name: "p.diff", diff }], message: "Patch" });
            expect(head(dir)).toBe(committed.sha);
        });
        expect(stderr).toBe("");
        expect(read(dir, "edit.txt")).toBe("one\ntwo patched\n");
        expect(read(dir, "new.txt")).toBe("new\n");
        expect(existsSync(join(dir, "gone.txt"))).toBe(false);
        expect(read(dir, "other.txt")).toBe("other, the user's uncommitted edit\n");
        expect(git(dir, ["status", "--porcelain", "--untracked-files=all"])).toBe("M other.txt");
    });

    test("patched files already in the working tree stay as they are, with a clean status", () => {
        const dir = repo(SEED);
        const { diff, file } = patchOf(dir);
        git(dir, ["apply", file]);
        const stderr = stderrOf(() => {
            safeCommit({ dir, paths: [], patches: [{ name: "p.diff", diff }], message: "Patch" });
        });
        expect(stderr).toBe("");
        expect(read(dir, "edit.txt")).toBe("one\ntwo patched\n");
        expect(read(dir, "new.txt")).toBe("new\n");
        expect(existsSync(join(dir, "gone.txt"))).toBe(false);
        expect(git(dir, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
    });

    test("a patched file the user changed otherwise is left alone, with a warning naming it", () => {
        const dir = repo(SEED);
        const { diff } = patchOf(dir);
        writeFileSync(join(dir, "edit.txt"), "one, the user's own edit\ntwo\n");
        writeFileSync(join(dir, "new.txt"), "the user's untracked new.txt\n");
        const stderr = stderrOf(() => {
            safeCommit({ dir, paths: [], patches: [{ name: "p.diff", diff }], message: "Patch" });
        });
        expect(read(dir, "edit.txt")).toBe("one, the user's own edit\ntwo\n");
        expect(read(dir, "new.txt")).toBe("the user's untracked new.txt\n");
        expect(existsSync(join(dir, "gone.txt"))).toBe(false);
        expect(stderr).toContain("edit.txt");
        expect(stderr).toContain("new.txt");
        expect(stderr).not.toContain("gone.txt");
        // The edits stay unstaged against the new HEAD; nothing else is changed or staged.
        expect(git(dir, ["diff", "--name-only"])).toBe("edit.txt\nnew.txt");
        expect(git(dir, ["diff", "--cached", "--name-only"])).toBe("");
        expect(git(dir, ["ls-files", "--others"])).toBe("");
    });

    // T2362: a rename landed as a `--patch` (a `git diff -M` of migration files, the old paths named too) left the old
    // files in the working tree, untracked and byte-identical to what the commit removed.
    describe("a rename (T2362)", () => {
        const seed = { "old.sql": "one\ntwo\nthree\nfour\nfive\n", "other.txt": "other\n" };

        /** The rename of old.sql to new.sql with one line changed, as `git diff -M` writes it; the tree is left clean. */
        function renamePatch(dir: string): string {
            git(dir, ["mv", "old.sql", "new.sql"]);
            writeFileSync(join(dir, "new.sql"), "one\ntwo\nthree\nfour\nfive renumbered\n");
            git(dir, ["add", "--all"]);
            const diff = `${git(dir, ["diff", "--cached", "-M"])}\n`;
            git(dir, ["reset", "--quiet", "--hard", "HEAD"]);
            expect(diff).toContain("rename from old.sql");
            return diff;
        }

        /**
         * The seed commit added old.sql, so deleting it reads as undoing that commit's lines: allowed, as a rename of a
         * file added in the last commits must be (`--allow-revert`).
         */
        const seeded = (dir: string) => ({ allowRevert: [head(dir)] });

        /** The working tree and index match the commit for both paths: old gone, new tracked, nothing untracked. */
        function expectClean(dir: string): void {
            expect(existsSync(join(dir, "old.sql"))).toBe(false);
            expect(read(dir, "new.sql")).toBe("one\ntwo\nthree\nfour\nfive renumbered\n");
            expect(git(dir, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe("new.sql\nother.txt");
            expect(git(dir, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
        }

        test("patched, with the old path named too: the old file is removed from the working tree", () => {
            const dir = repo(seed);
            const diff = renamePatch(dir);
            const stderr = stderrOf(() => {
                const committed = safeCommit({
                    dir,
                    paths: ["old.sql"],
                    patches: [{ name: "rename.patch", diff }],
                    message: "Rename",
                    ...seeded(dir),
                });
                expectClean(dir);
                expect(committed.patched).toEqual(["new.sql", "old.sql"]);
            });
            expect(stderr).toBe("");
        });

        test("patched alone: both sides of the rename are the patch's own paths", () => {
            const dir = repo(seed);
            const diff = renamePatch(dir);
            const stderr = stderrOf(() => {
                safeCommit({
                    dir,
                    paths: [],
                    patches: [{ name: "rename.patch", diff }],
                    message: "Rename",
                    ...seeded(dir),
                });
            });
            expect(stderr).toBe("");
            expectClean(dir);
        });

        test("moved in the working tree (git mv), both paths named", () => {
            const dir = repo(seed);
            git(dir, ["mv", "old.sql", "new.sql"]);
            writeFileSync(join(dir, "new.sql"), "one\ntwo\nthree\nfour\nfive renumbered\n");
            const stderr = stderrOf(() => {
                safeCommit({ dir, paths: ["old.sql", "new.sql"], message: "Rename", ...seeded(dir) });
            });
            expect(stderr).toBe("");
            expectClean(dir);
        });
    });
});
