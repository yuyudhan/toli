import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeCommit } from "../src/projects/commit.ts";
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
function repo(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "toli-commit-absent-"));
    temps.push(dir);
    git(dir, ["init", "--quiet", "-b", "main"]);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    git(dir, ["add", "--all"]);
    git(dir, ["commit", "--quiet", "-m", "seed"]);
    return dir;
}

const head = (dir: string) => git(dir, ["rev-parse", "HEAD"]);

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
