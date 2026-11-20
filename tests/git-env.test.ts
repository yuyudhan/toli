import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dropInheritedGitEnv } from "../src/core/git-env.ts";
import { sandbox, tempDir, withProject } from "./helpers.ts";

// T2052: a shell that exported GIT_INDEX_FILE (or GIT_DIR / GIT_WORK_TREE) and kept it set made toli's own git calls
// read a scratch index or another repository. Toli addresses every repository by path, so it ignores them.

describe("toli ignores inherited repository-locating git variables (T2052)", () => {
    test("bin/toli commit with GIT_INDEX_FILE at a scratch file commits from the project and leaves the scratch alone", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const dir = withProject(box, "app");
        writeFileSync(join(dir, "a.txt"), "a\n");
        writeFileSync(join(dir, "b.txt"), "b\n");
        const scratch = join(tempDir("scratch-index"), "index");
        const result = box.toli(["commit", "app", "-m", "Add a", "--", "a.txt"], {
            env: { GIT_INDEX_FILE: scratch },
        });
        expect(result.code).toBe(0);
        expect(existsSync(scratch)).toBe(false);
        expect(box.git(dir, ["show", "--name-only", "--format=", "HEAD"])).toBe("a.txt");
        expect(box.git(dir, ["status", "--porcelain"])).toBe("?? b.txt");
        const warnings = result.stderr.split("\n").filter((line) => line.includes("GIT_INDEX_FILE"));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("ignoring");
    });

    test("bin/toli commit with GIT_DIR and GIT_WORK_TREE at another repository commits in the named project", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const dir = withProject(box, "app");
        const decoy = tempDir("decoy");
        box.git(decoy, ["init", "--quiet", "-b", "main"]);
        writeFileSync(join(decoy, "d.txt"), "d\n");
        box.git(decoy, ["add", "d.txt"]);
        box.git(decoy, ["commit", "--quiet", "-m", "decoy"]);
        const decoyHead = box.git(decoy, ["rev-parse", "HEAD"]);
        writeFileSync(join(dir, "a.txt"), "a\n");
        const result = box.toli(["commit", "app", "-m", "Add a", "--", "a.txt"], {
            env: { GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy },
        });
        expect(result.code).toBe(0);
        expect(result.stdout.trim()).toBe(box.git(dir, ["rev-parse", "HEAD"]));
        expect(box.git(dir, ["show", "--name-only", "--format=", "HEAD"])).toBe("a.txt");
        expect(box.git(decoy, ["rev-parse", "HEAD"])).toBe(decoyHead);
        expect(result.stderr).toContain("GIT_DIR");
        expect(result.stderr).toContain("GIT_WORK_TREE");
    });

    test("bin/toli push warns about an inherited GIT_INDEX_FILE", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        withProject(box, "app");
        const scratch = join(tempDir("scratch-index"), "index");
        const result = box.toli(["push", "app"], { env: { GIT_INDEX_FILE: scratch } });
        expect(result.stderr.split("\n").filter((line) => line.includes("GIT_INDEX_FILE"))).toHaveLength(1);
        expect(existsSync(scratch)).toBe(false);
    });

    test("dropInheritedGitEnv removes only the repository-locating variables and names the ones that were set", () => {
        const env: Record<string, string | undefined> = {
            GIT_INDEX_FILE: "/tmp/scratch",
            GIT_DIR: "/tmp/other/.git",
            GIT_PREFIX: "",
            GIT_NAMESPACE: "ns",
            GIT_AUTHOR_NAME: "Dev",
            GIT_CEILING_DIRECTORIES: "/tmp",
            PATH: "/bin",
        };
        expect(dropInheritedGitEnv(env)).toEqual(["GIT_DIR", "GIT_INDEX_FILE", "GIT_NAMESPACE"]);
        expect(env).toEqual({ GIT_AUTHOR_NAME: "Dev", GIT_CEILING_DIRECTORIES: "/tmp", PATH: "/bin" });
        expect(dropInheritedGitEnv(env)).toEqual([]);
    });

    test("other commands drop them silently", () => {
        const box = sandbox();
        const result = box.toli(["task", "list"], { env: { GIT_INDEX_FILE: join(tempDir("scratch-index"), "index") } });
        expect(result.code).toBe(0);
        expect(result.stderr).not.toContain("GIT_INDEX_FILE");
    });

    test("doctor's worker sections ignore an inherited GIT_DIR: no false build-place warnings", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        withProject(box, "app");
        const decoy = tempDir("decoy");
        box.git(decoy, ["init", "--quiet", "-b", "main"]);
        box.git(decoy, ["commit", "--quiet", "--allow-empty", "-m", "decoy"]);
        box.git(decoy, ["worktree", "add", "--quiet", "--detach", join(tempDir("decoy-tree"), "tree")]);
        const env = { TOLI_BUILD_SCAN_ROOTS: tempDir("scan"), GIT_DIR: join(decoy, ".git") };
        const checks = JSON.parse(box.toli(["doctor", "--json"], { env }).stdout) as { name: string; level: string }[];
        expect(checks.filter((check) => check.name === "build-place").map((check) => check.level)).toEqual(["ok"]);
    }, 60_000);
});
