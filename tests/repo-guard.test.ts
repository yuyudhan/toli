import { describe, expect, test } from "bun:test";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_ENV, tempDir } from "./helpers.ts";
import { isolateGit, REAL_REPO, realRefs, refProblems, TEST_AUTHOR_EMAIL } from "./repo-guard.ts";

/** A repo with one commit on main by someone other than the test author. */
function repo(): { dir: string; git: (args: string[], env?: Record<string, string>) => string } {
    const dir = tempDir("guard");
    const git = (args: string[], env: Record<string, string> = GIT_ENV) => {
        const proc = Bun.spawnSync(["git", "-C", dir, ...args], {
            env: { ...process.env, ...env },
            stdout: "pipe",
            stderr: "pipe",
        });
        if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
        return proc.stdout.toString().trim();
    };
    const agent = { ...GIT_ENV, GIT_AUTHOR_EMAIL: "agent@example.org", GIT_COMMITTER_EMAIL: "agent@example.org" };
    git(["init", "--quiet", "-b", "main"]);
    writeFileSync(join(dir, "a"), "a\n");
    git(["add", "a"]);
    git(["commit", "--quiet", "-m", "first"], agent);
    git(["branch", "develop"]);
    return { dir, git: (args, env = agent) => git(args, env) };
}

describe("the test run cannot touch the real repository (T897)", () => {
    test("the preload left no inherited GIT_* variable, a temp HOME and a ceiling at the temp dir", () => {
        for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"])
            expect(process.env[name]).toBeUndefined();
        const temp = realpathSync(tmpdir());
        expect(process.env.GIT_CEILING_DIRECTORIES?.split(":")).toContain(temp);
        expect(realpathSync(process.env.HOME ?? "")).toStartWith(temp);
        expect(process.env.HOME).not.toBe(REAL_REPO);
    });

    test("isolateGit drops a hook's GIT_DIR, so a temp repo's commit stays in the temp repo", () => {
        const fake = repo();
        const saved = { ...process.env };
        process.env.GIT_DIR = join(fake.dir, ".git");
        process.env.GIT_INDEX_FILE = join(fake.dir, ".git", "index");
        const home = isolateGit();
        try {
            expect(process.env.GIT_DIR).toBeUndefined();
            expect(process.env.GIT_INDEX_FILE).toBeUndefined();
            const before = realRefs(join(fake.dir, ".git"));
            const scratch = tempDir("scratch");
            const git = (args: string[]) =>
                Bun.spawnSync(["git", ...args], { cwd: scratch, env: { ...process.env, ...GIT_ENV } }).exitCode;
            expect(git(["init", "--quiet", "-b", "main"])).toBe(0);
            writeFileSync(join(scratch, "b"), "b\n");
            expect(git(["add", "b"])).toBe(0);
            expect(git(["commit", "--quiet", "-m", "seed"])).toBe(0);
            expect(git(["tag", "v1.2.3"])).toBe(0);
            expect(realRefs(join(fake.dir, ".git"))).toEqual(before);
        } finally {
            rmSync(home, { recursive: true, force: true });
            for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
            Object.assign(process.env, saved);
        }
    });

    test("the guard flags test commits, tags and deleted branches but not other agents' commits", () => {
        const { dir, git } = repo();
        const gitDir = join(dir, ".git");
        const before = realRefs(gitDir);
        if (before === null) throw new Error("no refs");
        git(["switch", "--quiet", "develop"]);
        writeFileSync(join(dir, "c"), "c\n");
        git(["add", "c"]);
        git(["commit", "--quiet", "-m", "another agent's work"]);
        expect(refProblems(before, realRefs(gitDir) ?? new Map(), gitDir)).toEqual([]);

        git(["switch", "--quiet", "main"]);
        writeFileSync(join(dir, "d"), "d\n");
        git(["add", "d"]);
        git(["commit", "--quiet", "-m", "crate a"], GIT_ENV);
        git(["tag", "v1.2.3"]);
        git(["branch", "--quiet", "-D", "develop"]);
        const problems = refProblems(before, realRefs(gitDir) ?? new Map(), gitDir);
        expect(problems).toHaveLength(3);
        expect(problems.join("\n")).toContain("refs/heads/develop was deleted");
        expect(problems.join("\n")).toContain(`refs/heads/main gained 1 test commit(s)`);
        expect(problems.join("\n")).toContain(TEST_AUTHOR_EMAIL);
        expect(problems.join("\n")).toContain("refs/tags/v1.2.3 was created");
    });
});
