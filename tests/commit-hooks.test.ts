import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeCommit } from "../src/projects/commit.ts";
import { git, head, repo, useGitEnv } from "./commit-fixture.ts";

useGitEnv();

/** Install an executable `name` hook (`body` is bash) under `hooksDir`, relative to the repo. */
function installHook(dir: string, hooksDir: string, name: string, body: string): void {
    const hooks = join(dir, hooksDir);
    mkdirSync(hooks, { recursive: true });
    const file = join(hooks, name);
    writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
    chmodSync(file, 0o755);
}

function commitMsgHook(dir: string, hooksDir: string, body: string): void {
    installHook(dir, hooksDir, "commit-msg", body);
}

/** Like a project's format check: every tracked file with a trailing space fails it, read from the working tree. */
const FORMAT_CHECK = [
    'git diff --cached --name-only > "$(git rev-parse --git-common-dir)/pre-commit-saw"',
    "bad=$(git ls-files -z | xargs -0 grep -l ' $' || true)",
    'if [[ -n "$bad" ]]; then echo "pre-commit: not formatted: $bad" >&2; exit 1; fi',
].join("\n");

describe("bin/toli commit runs the project's commit-msg hook", () => {
    test("on the private index: a rejection refuses the commit with the hook's output", () => {
        const dir = repo({ "guard.txt": "limit 1\n", "b.txt": "b\n" });
        // Like a client project's guard hook: a change to guard.txt needs a Quality-change: line. It reads the staged set,
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

describe("bin/toli commit runs the project's pre-commit hook", () => {
    test("a failing check refuses the commit with the hook's output", () => {
        const dir = repo();
        installHook(dir, ".git/hooks", "pre-commit", FORMAT_CHECK);
        writeFileSync(join(dir, "README.md"), "# app changed \n");
        const before = head(dir);
        expect(() => safeCommit({ dir, paths: ["README.md"], message: "Change the readme" })).toThrow(
            "pre-commit: not formatted: README.md",
        );
        expect(head(dir)).toBe(before);
        expect(git(dir, ["show", "HEAD:README.md"])).toBe("# app");
        writeFileSync(join(dir, "README.md"), "# app changed\n");
        const committed = safeCommit({ dir, paths: ["README.md"], message: "Change the readme" });
        expect(head(dir)).toBe(committed.sha);
    });

    test("checks exactly the commit: other jawans' staged and unstaged files do not fail it", () => {
        const dir = repo({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
        installHook(dir, ".git/hooks", "pre-commit", FORMAT_CHECK);
        writeFileSync(join(dir, "a.txt"), "a staged by someone else \n");
        git(dir, ["add", "a.txt"]);
        writeFileSync(join(dir, "c.txt"), "c half-edited by someone else \n");
        writeFileSync(join(dir, "b.txt"), "b changed\n");
        const committed = safeCommit({ dir, paths: ["b.txt"], message: "Change b" });
        expect(head(dir)).toBe(committed.sha);
        expect(readFileSync(join(dir, ".git", "pre-commit-saw"), "utf8")).toBe("b.txt\n");
        expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("a staged by someone else \n");
        expect(readFileSync(join(dir, "c.txt"), "utf8")).toBe("c half-edited by someone else \n");
    });

    test("a hook that unsets GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE still sees a repository and only the commit", () => {
        const dir = repo({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
        installHook(
            dir,
            ".git/hooks",
            "pre-commit",
            [
                'cd "$(git rev-parse --show-toplevel)"',
                "unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE",
                'git diff --cached --name-only > "$(git rev-parse --git-common-dir)/pre-commit-saw"',
                'git status --porcelain >> "$(git rev-parse --git-common-dir)/pre-commit-saw"',
                'git rev-parse --abbrev-ref HEAD >> "$(git rev-parse --git-common-dir)/pre-commit-saw"',
            ].join("\n"),
        );
        writeFileSync(join(dir, "a.txt"), "a staged by someone else\n");
        git(dir, ["add", "a.txt"]);
        writeFileSync(join(dir, "c.txt"), "c half-edited by someone else\n");
        writeFileSync(join(dir, "b.txt"), "b changed\n");
        const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
        const committed = safeCommit({ dir, paths: ["b.txt"], message: "Change b" });
        expect(head(dir)).toBe(committed.sha);
        expect(readFileSync(join(dir, ".git", "pre-commit-saw"), "utf8")).toBe(`b.txt\nM  b.txt\n${branch}\n`);
        expect(git(dir, ["diff", "--cached", "--name-only"])).toBe("a.txt");
        expect(readFileSync(join(dir, "c.txt"), "utf8")).toBe("c half-edited by someone else\n");
    });

    test("refuses a hook that changes the files being committed, leaving the working tree as it was", () => {
        const dir = repo();
        installHook(dir, ".git/hooks", "pre-commit", "printf '# formatted\\n' > README.md\ngit add README.md");
        writeFileSync(join(dir, "README.md"), "#   app changed\n");
        const before = head(dir);
        expect(() => safeCommit({ dir, paths: ["README.md"], message: "Change the readme" })).toThrow(
            "the pre-commit hook .git/hooks/pre-commit changed README.md",
        );
        expect(head(dir)).toBe(before);
        expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("#   app changed\n");
    });

    test("runs the committed hook through core.hooksPath, with the clone's ignored tools at hand", () => {
        const dir = repo({ ".gitignore": "node_modules/\n", "README.md": "# app\n" });
        installHook(dir, ".githooks", "pre-commit", "node_modules/.bin/check");
        git(dir, ["config", "core.hooksPath", ".githooks"]);
        git(dir, ["add", ".githooks"]);
        git(dir, ["commit", "--quiet", "--no-verify", "-m", "hooks"]);
        installHook(dir, "node_modules/.bin", "check", 'echo "pre-commit: check rejects this tree" >&2; exit 1');
        writeFileSync(join(dir, "README.md"), "# app changed\n");
        expect(() => safeCommit({ dir, paths: ["README.md"], message: "Change the readme" })).toThrow(
            "check rejects this tree",
        );
        installHook(dir, "node_modules/.bin", "check", "exit 0");
        // Someone else's half-edited hook in the working tree is not what this commit runs.
        installHook(dir, ".githooks", "pre-commit", "exit 1");
        const committed = safeCommit({ dir, paths: ["README.md"], message: "Change the readme" });
        expect(head(dir)).toBe(committed.sha);
    });
});
