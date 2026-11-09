import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GIT_ENV, tempDir } from "./helpers.ts";

const HOOK = resolve(import.meta.dir, "..", ".githooks", "pre-push");

// Each test builds a repo and runs a real `git push` through the hook; on a loaded machine that passes 5 s.
setDefaultTimeout(60_000);

type Pushed = { code: number; stdout: string; stderr: string; calls: string[] };

/**
 * A clone carrying toli's real pre-push hook and a stub `bin/toli` (both committed, so the checkout is clean): the
 * stub logs each call and answers `gate check` / `gate run` with the exit codes in `<state>/check` and `<state>/run`.
 * A stub `bun` on PATH logs its calls the same way and exits with `<state>/bun`.
 */
function clone(): { dir: string; push: (check: number, run: number, bun?: number) => Pushed } {
    const root = tempDir("prepush");
    const stubs = join(root, "stubs");
    const state = join(root, "state");
    const origin = join(root, "origin.git");
    const dir = join(root, "clone");
    for (const path of [stubs, state, origin, join(dir, ".githooks"), join(dir, "bin")])
        mkdirSync(path, { recursive: true });
    writeFileSync(join(stubs, "gitleaks"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(stubs, "gitleaks"), 0o755);
    writeFileSync(
        join(stubs, "bun"),
        `#!/bin/sh\necho "bun $*" >> "${join(state, "calls")}"\nexit "$(cat "${join(state, "bun")}")"\n`,
    );
    chmodSync(join(stubs, "bun"), 0o755);
    copyFileSync(HOOK, join(dir, ".githooks", "pre-push"));
    chmodSync(join(dir, ".githooks", "pre-push"), 0o755);
    writeFileSync(
        join(dir, "bin", "toli"),
        [
            "#!/bin/sh",
            `echo "TOLI_DEV=\${TOLI_DEV:-} $*" >> "${join(state, "calls")}"`,
            'case "$1 $2" in',
            `"gate check") exit "$(cat "${join(state, "check")}")" ;;`,
            `"gate run") exit "$(cat "${join(state, "run")}")" ;;`,
            "esac",
            "",
        ].join("\n"),
    );
    chmodSync(join(dir, "bin", "toli"), 0o755);
    const env = {
        ...process.env,
        ...GIT_ENV,
        PATH: [stubs, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    };
    const git = (cwd: string, args: string[]): string => {
        const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { env, stdout: "pipe", stderr: "pipe" });
        if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
        return proc.stdout.toString().trim();
    };
    git(origin, ["init", "--bare", "--initial-branch=main"]);
    git(dir, ["init", "--initial-branch=main"]);
    git(dir, ["config", "core.hooksPath", ".githooks"]);
    git(dir, ["remote", "add", "origin", origin]);
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "seed"]);
    const push = (check: number, run: number, bun = 0): Pushed => {
        writeFileSync(join(state, "check"), String(check));
        writeFileSync(join(state, "run"), String(run));
        writeFileSync(join(state, "bun"), String(bun));
        const calls = join(state, "calls");
        writeFileSync(calls, "");
        const proc = Bun.spawnSync(["git", "-C", dir, "push", "origin", "main"], {
            env,
            stdout: "pipe",
            stderr: "pipe",
        });
        return {
            code: proc.exitCode ?? 1,
            stdout: proc.stdout.toString(),
            stderr: proc.stderr.toString(),
            calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : [],
        };
    };
    return { dir, push };
}

describe("pre-push hook", () => {
    test("a commit that already passed its gate is not checked again, even with other changes in the checkout", () => {
        const { dir, push } = clone();
        writeFileSync(join(dir, "wip.ts"), "half done\n");
        const pushed = push(0, 1);
        expect(pushed.code).toBe(0);
        expect(pushed.stdout + pushed.stderr).toContain("already passed on");
        expect(pushed.calls.some((call) => call.includes("gate run") || call.startsWith("bun "))).toBe(false);
    });

    test("a clean checkout of the pushed commit runs the checks as a recorded gate", () => {
        const { push } = clone();
        const pushed = push(1, 0);
        expect(pushed.code).toBe(0);
        expect(pushed.calls).toContain("TOLI_DEV=1 gate run toli --recipe bun run check");
        expect(pushed.calls).not.toContain("bun run check");
    });

    test("a failing gate refuses the push", () => {
        const { push } = clone();
        expect(push(1, 1).code).not.toBe(0);
    });

    test("a checkout that is not exactly the pushed commit lists the differences and checks the working tree", () => {
        const { dir, push } = clone();
        writeFileSync(join(dir, "wip.ts"), "half done\n");
        const pushed = push(1, 0);
        expect(pushed.code).toBe(0);
        expect(pushed.stdout + pushed.stderr).toContain("not exactly the pushed commit");
        expect(pushed.stdout + pushed.stderr).toContain("wip.ts");
        expect(pushed.calls).toContain("bun run check");
        expect(pushed.calls.some((call) => call.includes("gate run"))).toBe(false);
    });

    test("a failing working-tree check refuses the push", () => {
        const { dir, push } = clone();
        writeFileSync(join(dir, "wip.ts"), "half done\n");
        expect(push(1, 0, 1).code).not.toBe(0);
    });
});
