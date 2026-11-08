import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
function repo(files: Record<string, string> = { "README.md": "# app\n" }): string {
    const dir = mkdtempSync(join(tmpdir(), "toli-commit-hooks-"));
    temps.push(dir);
    git(dir, ["init", "--quiet", "-b", "main"]);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    git(dir, ["add", "--all"]);
    git(dir, ["commit", "--quiet", "-m", "seed"]);
    return dir;
}

const head = (dir: string) => git(dir, ["rev-parse", "HEAD"]);

/** Install an executable commit-msg hook (`body` is bash) under `hooksDir`, relative to the repo. */
function commitMsgHook(dir: string, hooksDir: string, body: string): void {
    const hooks = join(dir, hooksDir);
    mkdirSync(hooks, { recursive: true });
    const file = join(hooks, "commit-msg");
    writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
    chmodSync(file, 0o755);
}

describe("bin/toli commit runs the project's commit-msg hook", () => {
    test("on the private index: a rejection refuses the commit with the hook's output", () => {
        const dir = repo({ "guard.txt": "limit 1\n", "b.txt": "b\n" });
        // Like VelocityFSS's guard hook: a change to guard.txt needs a Quality-change: line. It reads the staged set,
        // so it must see toli's private index (only the named path), not the shared one.
        commitMsgHook(
            dir,
            ".git/hooks",
            [
                'git diff --cached --name-only > "$(git rev-parse --git-dir)/hook-saw"',
                'if git diff --cached --name-only | grep -qx guard.txt && ! grep -q "^Quality-change:" "$1"; then',
                '    echo "commit-msg: guard.txt changed; add a Quality-change: line" >&2',
                "    exit 1",
                "fi",
            ].join("\n"),
        );
        writeFileSync(join(dir, "b.txt"), "b staged by someone else\n");
        git(dir, ["add", "b.txt"]);
        writeFileSync(join(dir, "guard.txt"), "limit 2\n");
        const before = head(dir);
        expect(() => safeCommit({ dir, paths: ["guard.txt"], message: "Raise the limit" })).toThrow(
            "guard.txt changed; add a Quality-change: line",
        );
        expect(head(dir)).toBe(before);
        expect(git(dir, ["show", "HEAD:guard.txt"])).toBe("limit 1");
        const committed = safeCommit({
            dir,
            paths: ["guard.txt"],
            message: "Raise the limit\n\nQuality-change: limit 1 -> 2 for the new load",
        });
        expect(head(dir)).toBe(committed.sha);
        expect(git(dir, ["show", "HEAD:guard.txt"])).toBe("limit 2");
        expect(readFileSync(join(dir, ".git", "hook-saw"), "utf8")).toBe("guard.txt\n");
    });

    test("commits the message as the hook edited it", () => {
        const dir = repo();
        commitMsgHook(dir, ".git/hooks", 'printf "\\nTicket: T1\\n" >> "$1"');
        writeFileSync(join(dir, "README.md"), "# app changed\n");
        const committed = safeCommit({ dir, paths: ["README.md"], message: "Change the readme" });
        expect(git(dir, ["log", "-1", "--format=%B", committed.sha])).toBe("Change the readme\n\nTicket: T1");
    });

    test("finds the hook through core.hooksPath", () => {
        const dir = repo();
        commitMsgHook(dir, ".githooks", 'echo "commit-msg: rejected by .githooks" >&2; exit 1');
        git(dir, ["config", "core.hooksPath", ".githooks"]);
        writeFileSync(join(dir, "README.md"), "# app changed\n");
        const before = head(dir);
        expect(() => safeCommit({ dir, paths: ["README.md"], message: "Change the readme" })).toThrow(
            "rejected by .githooks",
        );
        expect(head(dir)).toBe(before);
    });
});
