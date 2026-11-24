import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeCommit } from "../src/projects/commit.ts";
import { parseHunks, parseRenames } from "../src/projects/diff-hunks.ts";
import { git, head, repo, useGitEnv } from "./commit-fixture.ts";

// Real repos and real git, as in commit.test.ts: allow 3 minutes per test under load.
setDefaultTimeout(180_000);
useGitEnv();

describe("bin/toli commit: renames and the revert check (T2633)", () => {
    test("renaming a file a recent commit added or renamed is not a revert; renaming it back is", () => {
        const migration = (name: string) =>
            `-- FilePath: ${name}.sql\n-- Adds the proof of posting.\n\nalter table reviews add column decision text;\n`;
        const dir = repo({ "0129_proof.sql": migration("0129_proof") });
        const move = (from: string, to: string, message: string) => {
            git(dir, ["mv", `${from}.sql`, `${to}.sql`]);
            writeFileSync(join(dir, `${to}.sql`), migration(to));
            return () => safeCommit({ dir, paths: [`${from}.sql`, `${to}.sql`], message }).sha;
        };
        // The migration's timestamp is bumped twice, each rename changing only the FilePath header (T765, T842).
        const bumped = move("0129_proof", "0130_proof", "Bump the migration")();
        expect(move("0130_proof", "0131_proof", "Bump it again")()).not.toBe(bumped);
        // Renaming it back to where the last commit took it from, header and all, restores that commit's state.
        const last = head(dir);
        expect(move("0131_proof", "0130_proof", "Undo the bump")).toThrow(
            `would revert 0130_proof.sql lines from ${last.slice(0, 7)}`,
        );
        expect(head(dir)).toBe(last);
        git(dir, ["reset", "-q", "--hard", "HEAD"]);
        // So does a pure rename back with the content unchanged.
        git(dir, ["mv", "0131_proof.sql", "0131_copy.sql"]);
        const pure = safeCommit({ dir, paths: ["0131_proof.sql", "0131_copy.sql"], message: "Pure rename" }).sha;
        git(dir, ["mv", "0131_copy.sql", "0131_proof.sql"]);
        expect(() =>
            safeCommit({ dir, paths: ["0131_copy.sql", "0131_proof.sql"], message: "Pure rename back" }),
        ).toThrow(`would revert 0131_proof.sql lines from ${pure.slice(0, 7)}`);
    });

    test("parseHunks reads -U0 diffs per file, with both paths of a rename; parseRenames reads the renames", () => {
        const diff = [
            "diff --git a/x b/x",
            "--- a/x",
            "+++ b/x",
            "@@ -1 +1 @@",
            "-old",
            "+new",
            "@@ -5,0 +6 @@",
            "+added",
            "diff --git a/y b/z",
            "similarity index 75%",
            "rename from y",
            "rename to z",
            "--- a/y",
            "+++ b/z",
            "@@ -1 +1 @@",
            "--- FilePath: y",
            "+-- FilePath: z",
            "diff --git a/gone b/gone",
            "deleted file mode 100644",
            "--- a/gone",
            "+++ /dev/null",
            "@@ -1 +0,0 @@",
            "-bye",
        ].join("\n");
        expect(parseHunks(diff)).toEqual([
            { file: "x", oldFile: "x", removed: ["old"], added: ["new"], oldStart: 1, newStart: 1 },
            { file: "x", oldFile: "x", removed: [], added: ["added"], oldStart: 5, newStart: 6 },
            {
                file: "z",
                oldFile: "y",
                removed: ["-- FilePath: y"],
                added: ["-- FilePath: z"],
                oldStart: 1,
                newStart: 1,
            },
            { file: "gone", oldFile: "gone", removed: ["bye"], added: [], oldStart: 1, newStart: 0 },
        ]);
        expect(parseRenames(diff)).toEqual([{ from: "y", to: "z" }]);
    });
});
