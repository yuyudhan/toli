import { afterAll, beforeAll } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { GIT_ENV, tempDir } from "./helpers.ts";

/**
 * Put the GIT_ENV identity into process.env for the calling test file and restore it after: safeCommit runs in the
 * test process, so its git calls read it from there. Call at the top level of each file.
 */
export function useGitEnv(): void {
    const saved = Object.keys(GIT_ENV).map((key) => [key, process.env[key]] as const);
    beforeAll(() => Object.assign(process.env, GIT_ENV));
    afterAll(() => {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
}

/** `git -C dir ...` that must succeed; returns trimmed stdout. */
export function git(dir: string, args: string[]): string {
    const proc = Bun.spawnSync(["git", "-C", dir, ...args], {
        env: { ...process.env, ...GIT_ENV },
        stdout: "pipe",
        stderr: "pipe",
    });
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
    return proc.stdout.toString().trim();
}

/** A repo on `main` with one commit holding `files`. */
export function repo(files: Record<string, string> = { "README.md": "# app\n" }): string {
    const dir = tempDir("commit");
    git(dir, ["init", "--quiet", "-b", "main"]);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    git(dir, ["add", "--all"]);
    git(dir, ["commit", "--quiet", "-m", "seed"]);
    return dir;
}

export const head = (dir: string): string => git(dir, ["rev-parse", "HEAD"]);
