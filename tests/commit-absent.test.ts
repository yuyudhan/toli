import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeCommit } from "../src/projects/commit.ts";
import { git, head, repo, useGitEnv } from "./commit-fixture.ts";

useGitEnv();

describe("bin/toli commit with named paths absent from the working tree", () => {
    test("--merge --resolved commits conflicted paths resolved by deleting them, absent from the merge result", () => {
        const query = "line 1\nline 2\nline 3\nline 4\nline 5\n";
        const dir = repo({ "query.json": query, "old.json": "old\n" });
        // Both sides rename query.json (rename/rename: merge-tree drops query.json from its result) and upstream
        // deletes old.json, which the branch modifies (modify/delete).
        git(dir, ["switch", "--quiet", "-c", "upstream"]);
        git(dir, ["mv", "query.json", "upstream.json"]);
        git(dir, ["rm", "--quiet", "old.json"]);
        git(dir, ["commit", "--quiet", "-m", "upstream: rename query, drop old"]);
        git(dir, ["switch", "--quiet", "main"]);
        git(dir, ["mv", "query.json", "main.json"]);
        writeFileSync(join(dir, "old.json"), "old, changed on main\n");
        git(dir, ["commit", "--quiet", "-am", "main: rename query, change old"]);
        const before = head(dir);
        // Resolved: keep main.json; query.json, upstream.json and old.json are gone from the working tree.
        rmSync(join(dir, "old.json"));
        const paths = ["query.json", "main.json", "upstream.json", "old.json"];
        expect(() =>
            safeCommit({ dir, paths: [...paths, "nope.json"], merge: "upstream", resolved: true, message: "Merge" }),
        ).toThrow(
            "refusing: nope.json not in the working tree or the commit, and not among the paths merging upstream",
        );
        expect(head(dir)).toBe(before);
        const merged = safeCommit({ dir, paths, merge: "upstream", resolved: true, message: "Merge upstream" });
        expect(git(dir, ["rev-list", "--parents", "-n", "1", merged.sha]).split(" ")).toEqual([
            merged.sha,
            before,
            git(dir, ["rev-parse", "upstream"]),
        ]);
        expect(git(dir, ["ls-tree", "--name-only", merged.sha])).toBe("main.json");
        expect(git(dir, ["status", "--porcelain"])).toBe("");
    });

    test("a named path in neither the working tree nor the commit is refused", () => {
        const dir = repo({ "a.txt": "a\n" });
        writeFileSync(join(dir, "a.txt"), "a changed\n");
        const before = head(dir);
        expect(() => safeCommit({ dir, paths: ["a.txt", "missing.txt"], message: "Change a" })).toThrow(
            "refusing: missing.txt not in the working tree or the commit; nothing was committed",
        );
        expect(head(dir)).toBe(before);
    });
});
