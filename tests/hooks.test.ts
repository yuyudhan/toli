import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { run } from "../src/core/util.ts";
import { ensureHooks, type HookCheck, hookChecks, installHooks } from "../src/projects/hooks.ts";
import { type Sandbox, sandbox, tempDir, withProject } from "./helpers.ts";

// The CLI tests clone a project and run several bin/toli commands; allow for a loaded machine.
setDefaultTimeout(60_000);

/** A fresh `git init` checkout (with git's sample hooks in .git/hooks, as a real clone has). */
function repo(): string {
    const dir = join(tempDir("hooks"), "repo");
    mkdirSync(dir);
    expect(run(["git", "init", "-q", dir]).code).toBe(0);
    return dir;
}

function put(dir: string, path: string, text: string, mode = 0o644): void {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    chmodSync(file, mode);
}

function hooksPath(dir: string): string | null {
    const result = run(["git", "-C", dir, "config", "--get", "core.hooksPath"]);
    return result.code === 0 ? result.stdout.trim() : null;
}

/** tool, source, declared and missing hooks, installable: the parts each test pins. */
function summary(checks: HookCheck[]): [string, string, string[], string[], boolean][] {
    return checks.map((check) => [check.tool, check.source, check.hooks, check.missing, check.installable]);
}

const SCRIPT = "#!/bin/sh\nexit 0\n";

describe("declared hooks", () => {
    test("a repo that declares nothing is silent, git's sample hooks included", () => {
        const dir = repo();
        put(dir, "README.md", "nothing about hooks\n");
        expect(hookChecks(dir)).toEqual([]);
        expect(ensureHooks(dir, "bin/toli project setup x")).toEqual([]);
        expect(hooksPath(dir)).toBeNull();
    });

    test("husky 9: declared and not installed is reported; installing points core.hooksPath at .husky/_", () => {
        const dir = repo();
        put(dir, ".husky/pre-push", "just verify\n");
        put(dir, ".husky/_/h", SCRIPT, 0o755);
        put(dir, ".husky/_/pre-push", SCRIPT, 0o755);
        expect(summary(hookChecks(dir))).toEqual([["husky", ".husky", ["pre-push"], ["pre-push"], true]]);
        expect(installHooks(dir)).toEqual(["hooks: husky (.husky): installed (git config core.hooksPath .husky/_)"]);
        expect(hooksPath(dir)).toBe(".husky/_");
        expect(summary(hookChecks(dir))).toEqual([["husky", ".husky", ["pre-push"], [], true]]);
        // Declared and installed: nothing more to do.
        expect(installHooks(dir)).toEqual([]);
        expect(ensureHooks(dir, "setup")).toEqual(["hooks: husky (.husky): pre-push active"]);
    });

    test("husky through the repo's own binary, with the arguments its prepare script gives", () => {
        const dir = repo();
        put(dir, ".husky/pre-commit", "npm test\n");
        put(dir, "package.json", JSON.stringify({ scripts: { prepare: "npx husky install && echo done" } }));
        put(
            dir,
            "node_modules/.bin/husky",
            `#!/bin/sh\necho "$@" > husky-args\nmkdir -p .husky/_\nprintf '#!/bin/sh\\n' > .husky/_/husky.sh\nprintf '#!/bin/sh\\n' > .husky/pre-commit\nchmod +x .husky/pre-commit\ngit config core.hooksPath .husky\n`,
            0o755,
        );
        expect(hookChecks(dir)[0]?.fix).toBe("node_modules/.bin/husky install");
        expect(installHooks(dir)).toEqual(["hooks: husky (.husky): installed (node_modules/.bin/husky install)"]);
        expect(run(["cat", join(dir, "husky-args")]).stdout.trim()).toBe("install");
        expect(summary(hookChecks(dir))).toEqual([["husky", ".husky", ["pre-commit"], [], true]]);
    });

    test("husky with self-contained executable hook files: core.hooksPath .husky", () => {
        const dir = repo();
        put(dir, ".husky/pre-push", SCRIPT, 0o755);
        installHooks(dir);
        expect(hooksPath(dir)).toBe(".husky");
        expect(hookChecks(dir)[0]?.missing).toEqual([]);
    });

    test("husky without its dependencies installed: reports the install, changes nothing", () => {
        const dir = repo();
        put(dir, ".husky/pre-push", "just verify\n");
        put(dir, "package.json", JSON.stringify({ scripts: { prepare: "husky" } }));
        put(dir, "bun.lock", "{}\n");
        expect(installHooks(dir)).toEqual([]);
        expect(hooksPath(dir)).toBeNull();
        expect(ensureHooks(dir, "bin/toli project setup x")).toEqual([
            "hooks: husky (.husky) declares pre-push, not installed: run `bun install` in the clone",
        ]);
    });

    test("a hooks directory a recipe sets core.hooksPath to is installed", () => {
        const dir = repo();
        put(dir, "scripts/hooks/pre-push", SCRIPT, 0o755);
        put(dir, "scripts/hooks/notes.txt", "not a hook\n");
        put(dir, "Justfile", "hooks:\n    git config core.hooksPath ./scripts/hooks/\n");
        expect(summary(hookChecks(dir))).toEqual([["hooks-dir", "scripts/hooks", ["pre-push"], ["pre-push"], true]]);
        expect(ensureHooks(dir, "setup")).toEqual([
            "hooks: scripts/hooks: installed (git config core.hooksPath scripts/hooks)",
            "hooks: scripts/hooks: pre-push active",
        ]);
        expect(hooksPath(dir)).toBe("scripts/hooks");
    });

    test(".githooks that nothing names is reported with its command; a doc naming it installs it", () => {
        const dir = repo();
        put(dir, ".githooks/commit-msg", SCRIPT, 0o755);
        expect(ensureHooks(dir, "setup")).toEqual([
            "hooks: .githooks declares commit-msg, not installed: run `git config core.hooksPath .githooks` in the clone",
        ]);
        expect(hooksPath(dir)).toBeNull();
        put(dir, "docs/contributing.md", "Run `git config core.hooksPath .githooks` once.\n");
        expect(installHooks(dir)).toEqual(["hooks: .githooks: installed (git config core.hooksPath .githooks)"]);
        expect(hookChecks(dir)[0]?.missing).toEqual([]);
    });

    test("never replaces a core.hooksPath set to something else", () => {
        const dir = repo();
        put(dir, ".githooks/pre-push", SCRIPT, 0o755);
        put(dir, "Makefile", "hooks:\n\tgit config core.hooksPath .githooks\n");
        expect(run(["git", "-C", dir, "config", "core.hooksPath", "elsewhere"]).code).toBe(0);
        expect(installHooks(dir)).toEqual([
            "hooks: .githooks: not installed: core.hooksPath is already elsewhere; left as it is",
        ]);
        expect(hooksPath(dir)).toBe("elsewhere");
        expect(hookChecks(dir)[0]?.missing).toEqual(["pre-push"]);
    });

    test("pre-commit: its install hook types are reported until installed", () => {
        const dir = repo();
        put(dir, ".pre-commit-config.yaml", "default_install_hook_types:\n  - pre-commit\n  - pre-push\nrepos: []\n");
        expect(installHooks(dir)).toEqual([]);
        expect(summary(hookChecks(dir))).toEqual([
            ["pre-commit", ".pre-commit-config.yaml", ["pre-commit", "pre-push"], ["pre-commit", "pre-push"], false],
        ]);
        expect(ensureHooks(dir, "setup")).toEqual([
            "hooks: pre-commit (.pre-commit-config.yaml) declares pre-commit, pre-push, not installed: run `pre-commit install` in the clone",
        ]);
        put(dir, ".git/hooks/pre-commit", SCRIPT, 0o755);
        put(dir, ".git/hooks/pre-push", SCRIPT, 0o755);
        expect(hookChecks(dir)[0]?.missing).toEqual([]);
    });

    test("pre-commit without install types declares pre-commit; an inline list is read too", () => {
        const dir = repo();
        put(dir, ".pre-commit-config.yaml", "repos: []\n");
        expect(hookChecks(dir)[0]?.hooks).toEqual(["pre-commit"]);
        put(dir, ".pre-commit-config.yaml", "default_install_hook_types: [commit-msg, 'pre-push']\n");
        expect(hookChecks(dir)[0]?.hooks).toEqual(["commit-msg", "pre-push"]);
    });

    test("lefthook: its hook sections are reported until installed; a config without hooks is silent", () => {
        const dir = repo();
        put(dir, "lefthook.yml", "pre-push:\n  commands:\n    verify:\n      run: just verify\noutput: [summary]\n");
        expect(summary(hookChecks(dir))).toEqual([["lefthook", "lefthook.yml", ["pre-push"], ["pre-push"], false]]);
        expect(hookChecks(dir)[0]?.fix).toBe("lefthook install");
        put(dir, ".git/hooks/pre-push", SCRIPT, 0o755);
        expect(hookChecks(dir)[0]?.missing).toEqual([]);
        put(dir, "lefthook.yml", "output: [summary]\n");
        expect(hookChecks(dir)).toEqual([]);
    });

    test("a declared hook git would find but cannot execute counts as missing", () => {
        const dir = repo();
        put(dir, "lefthook.yml", "pre-commit:\n  jobs: []\n");
        put(dir, ".git/hooks/pre-commit", SCRIPT, 0o644);
        expect(hookChecks(dir)[0]?.missing).toEqual(["pre-commit"]);
    });
});

/** A worker with project "app" on branch "feature" one commit ahead, a standing push grant, and `.githooks/pre-push`. */
function appWithPrePush(): { box: Sandbox; dir: string } {
    const box = sandbox();
    box.ok(["init", "--name", "mini", "--role", "worker", "--coordinator-ssh", "mac", "--coordinator-root", "/r"]);
    const dir = withProject(box, "app");
    box.ok(["project", "set", "app", "--standing-push", "yes"]);
    box.git(dir, ["switch", "-c", "feature"]);
    put(dir, ".githooks/pre-push", `#!/bin/sh\necho ran >> "${join(dir, "..", "app-pre-push-ran")}"\n`, 0o755);
    box.git(dir, ["add", ".githooks"]);
    box.git(dir, ["commit", "-m", "add hooks"]);
    return { box, dir };
}

describe("hooks in the CLI", () => {
    test("push refuses while a declared pre-push hook is not installed; --no-hooks-ok pushes anyway", () => {
        const { box, dir } = appWithPrePush();
        const refused = box.toli(["push", "app"]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain(
            "refusing to push app: .githooks declares pre-push, not installed: run `git config core.hooksPath .githooks` in the clone",
        );
        expect(box.git(dir, ["ls-remote", "origin", "refs/heads/feature"])).toBe("");
        expect(box.ok(["push", "app", "--no-hooks-ok"])).toContain("push log:");
        expect(box.git(dir, ["ls-remote", "origin", "refs/heads/feature"])).toContain(
            box.git(dir, ["rev-parse", "HEAD"]),
        );
    });

    test("push goes through once the hook is installed; other missing hooks only warn", () => {
        const { box, dir } = appWithPrePush();
        box.git(dir, ["config", "core.hooksPath", ".githooks"]);
        put(dir, "lefthook.yml", "pre-commit:\n  jobs: []\n");
        const pushed = box.toli(["push", "app"]);
        expect(pushed.code).toBe(0);
        expect(pushed.stderr).toContain("toli: lefthook (lefthook.yml) declares pre-commit, not installed");
        expect(run(["cat", join(dir, "..", "app-pre-push-ran")]).stdout.trim()).toBe("ran");
    });

    test("ensure installs a recipe's hooks dir, setup and doctor report what stays missing, silent when none", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const dir = withProject(box, "x");
        const url = box.git(dir, ["remote", "get-url", "origin"]);
        const hooksChecks = (): { level: string; detail: string }[] =>
            (JSON.parse(box.toli(["doctor", "--json"]).stdout) as { name: string; level: string; detail: string }[])
                .filter((check) => check.name === "hooks")
                .map(({ level, detail }) => ({ level, detail }));
        const setupHooks = (): { status: string; detail: string }[] =>
            (
                JSON.parse(box.ok(["project", "setup", "x", "--json"])) as {
                    checks: { key: string; status: string; detail: string }[];
                }
            ).checks
                .filter((check) => check.key === "hooks")
                .map(({ status, detail }) => ({ status, detail }));

        expect(box.ok(["project", "ensure", "x", url])).not.toContain("hooks:");
        expect(hooksChecks()).toEqual([]);
        expect(setupHooks()).toEqual([]);

        put(dir, ".githooks/pre-push", SCRIPT, 0o755);
        put(dir, "justfile", "hooks:\n    git config core.hooksPath .githooks\n");
        put(dir, ".pre-commit-config.yaml", "repos: []\n");
        expect(hooksChecks()).toEqual([
            {
                level: "warn",
                detail: "x: .githooks declares pre-push, not installed: run bin/toli project setup x",
            },
            {
                level: "warn",
                detail: "x: pre-commit (.pre-commit-config.yaml) declares pre-commit, not installed: run `pre-commit install` in the clone",
            },
        ]);
        const ensured = box.ok(["project", "ensure", "x", url]);
        expect(ensured).toContain("hooks: .githooks: installed (git config core.hooksPath .githooks)");
        expect(ensured).toContain("hooks: .githooks: pre-push active");
        expect(box.git(dir, ["config", "core.hooksPath"])).toBe(".githooks");
        expect(setupHooks()).toEqual([
            { status: "ok", detail: ".githooks: pre-push active" },
            {
                status: "missing",
                detail: "pre-commit (.pre-commit-config.yaml) declares pre-commit, not installed: run `pre-commit install` in the clone",
            },
        ]);
        rmSync(join(dir, ".pre-commit-config.yaml"));
        expect(hooksChecks()).toEqual([{ level: "ok", detail: "declared git hooks active in 1 clone" }]);
    });
});
