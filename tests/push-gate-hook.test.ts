// `bin/toli push --gate "<recipe>"` must not run the same gate twice on one push (T1418): when the repo's pre-push hook
// runs exactly the gate's recipe and nothing else, and the gate passed (sealed proof) on exactly the commit being
// pushed from a clean checkout, the push skips that hook's identical run, says so, and pushes exactly that commit. Any
// other sha, a dirty checkout, another command, or a hook that does more keeps the hook.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookCommand, pushHookDecision } from "../src/forge/gate-hook.ts";
import { commitFile, gatesLog, recipe, runs, setup } from "./gate-fixture.ts";
import { type Sandbox, TOLI_BIN } from "./helpers.ts";

// Each push runs a real detached gate runner and a real git push.
setDefaultTimeout(60_000);

const savedRoot = process.env.TOLI_ROOT;
afterEach(() => {
    if (savedRoot === undefined) delete process.env.TOLI_ROOT;
    else process.env.TOLI_ROOT = savedRoot;
});

/** Project "app" on branch `feature` with a new commit and a standing push grant; returns the clone and that commit. */
function pushable(): { box: Sandbox; dir: string; sha: string } {
    const { box, dir } = setup();
    box.ok(["project", "set", "app", "--standing-push", "yes"]);
    box.git(dir, ["switch", "-c", "feature"]);
    return { box, dir, sha: commitFile(box, dir, "a.txt") };
}

function writeHook(dir: string, body: string): void {
    writeFileSync(join(dir, ".git", "hooks", "pre-push"), body, { mode: 0o755 });
}

function originHas(box: Sandbox, dir: string): string {
    return box.git(dir, ["ls-remote", "origin", "refs/heads/feature"]);
}

describe("push --gate and an identical pre-push hook", () => {
    test("same sha and command: the hook's run is skipped, logged, and exactly the gated commit is pushed", () => {
        const { box, dir, sha } = pushable();
        const verify = recipe(box, "verify", "echo ok");
        writeHook(dir, `#!/bin/sh\nset -eu\n# the full check\nexec ${verify}\n`);
        const pushed = box.ok(["push", "app", "--gate", verify]);
        // The recipe counts its runs: the gate ran it once and the hook not at all.
        expect(runs(box)).toBe(1);
        expect(pushed).toContain(`skipping the pre-push hook`);
        expect(pushed).toContain(`it runs only ${verify}, which passed on ${sha.slice(0, 12)}`);
        expect(gatesLog(box)).toMatch(/ app [0-9a-f]{12} hook-skip: /);
        expect(originHas(box, dir)).toContain(sha);
        expect(box.git(dir, ["rev-parse", "--abbrev-ref", "feature@{upstream}"])).toBe("origin/feature");
    });

    test("a failed gate pushes nothing and never reaches the hook", () => {
        const { box, dir } = pushable();
        const failing = recipe(box, "broken", "exit 1");
        writeHook(dir, `#!/bin/sh\nexec ${failing}\n`);
        const refused = box.toli(["push", "app", "--gate", failing]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("refusing to push");
        expect(runs(box)).toBe(1);
        expect(originHas(box, dir)).toBe("");
    });

    test("a hook running another command still runs", () => {
        const { box, dir, sha } = pushable();
        const verify = recipe(box, "verify", "echo ok");
        writeHook(dir, `#!/bin/sh\nexec ${verify} --more\n`);
        const pushed = box.ok(["push", "app", "--gate", verify]);
        expect(runs(box)).toBe(2);
        expect(pushed).toContain("running the pre-push hook");
        expect(originHas(box, dir)).toContain(sha);
    });

    test("a hook that does more than the gate still runs", () => {
        const { box, dir } = pushable();
        const verify = recipe(box, "verify", "echo ok");
        const seen = join(box.root, "secret-scan");
        writeHook(dir, `#!/bin/sh\necho scanned > ${seen}\n${verify}\n`);
        const pushed = box.ok(["push", "app", "--gate", verify]);
        expect(runs(box)).toBe(2);
        expect(existsSync(seen)).toBe(true);
        // It never asks gate check, so its gate step reran; the push names the guard that would skip it.
        expect(pushed).toContain("never asks bin/toli gate check, so a gate step in it reruns");
        expect(pushed).toContain(
            `guard that step with bin/toli gate check app --sha <pushed sha> --recipe "${verify}"`,
        );
    });

    test("a hook that does more than the gate skips only its gate step, by gate check, on the passed tree", () => {
        const { box, dir } = pushable();
        box.ok(["project", "set", "app", "--workspace", "worktree-per-task"]);
        box.ok(["task", "add", "app", "Fix the bug"]);
        box.ok(["workspace", "prepare", "T1"]);
        const worktree = join(box.root, "projects", ".worktrees", "app", "T1");
        const verify = recipe(box, "verify", "echo ok");
        const scans = join(box.root, "secret-scan");
        mkdirSync(join(box.root, "bin"));
        writeFileSync(join(box.root, "bin", "toli"), `#!/bin/sh\nexec "${process.execPath}" "${TOLI_BIN}" "$@"\n`, {
            mode: 0o755,
        });
        // The multi-command hook docs/delivery.md gives: its other steps always run, its gate step asks gate check.
        writeHook(
            dir,
            [
                "#!/bin/sh",
                "set -eu",
                "refs=$(cat)",
                `echo scanned >> ${scans}`,
                'common="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)"',
                `toli="\${common%/projects/*}/bin/toli"`,
                "zero=0000000000000000000000000000000000000000",
                "total=0",
                "passed=0",
                "while read -r _ sha _ _; do",
                '    [ -n "$sha" ] || continue',
                "    total=$((total + 1))",
                '    if [ "$sha" = "$zero" ] ||',
                `        { [ -x "$toli" ] && "$toli" gate check app --sha "$sha" --recipe '${verify}' >/dev/null 2>&1; }; then`,
                "        passed=$((passed + 1))",
                "    fi",
                "done <<EOF",
                "$refs",
                "EOF",
                'if [ "$total" -gt 0 ] && [ "$passed" -eq "$total" ]; then',
                `    echo "pre-push: '${verify}' already passed on every pushed tip; skipping it"`,
                "else",
                `    ${verify}`,
                "fi",
                "",
            ].join("\n"),
        );
        commitFile(box, worktree, "fix.txt");
        const pushed = box.ok(["push", "app", "--task", "T1", "--gate", verify]);
        expect(pushed).toContain(`is not only the gate ${verify}, so it runs; its gate step is skipped where it asks`);
        // The gate ran once, the hook's gate step not at all, and its other step still ran.
        expect(runs(box)).toBe(1);
        expect(readFileSync(scans, "utf8").trim().split("\n")).toEqual(["scanned"]);
        // A tree no gate passed on: the gate step runs, and so does the other step.
        commitFile(box, worktree, "more.txt");
        box.ok(["push", "app", "--task", "T1"]);
        expect(runs(box)).toBe(2);
        expect(readFileSync(scans, "utf8").trim().split("\n")).toEqual(["scanned", "scanned"]);
    });

    test("a different sha, a dirty checkout, another recipe or no proof keeps the hook", () => {
        const { box, dir, sha } = pushable();
        const verify = recipe(box, "verify", "echo ok");
        writeHook(dir, `#!/bin/sh\nexec ${verify}\n`);
        box.ok(["gate", "run", "app", "--recipe", verify]);
        process.env.TOLI_ROOT = box.root;
        const decide = (gated: string, gate = verify) =>
            pushHookDecision({ project: "app", dir, recipe: gate, sha: gated });
        expect(decide(sha)).toMatchObject({ skip: true });

        const other = recipe(box, "other", "echo other");
        expect(decide(sha, other)).toMatchObject({ skip: false });
        writeHook(dir, `#!/bin/sh\nexec ${other}\n`);
        expect(decide(sha, other)).toMatchObject({ skip: false, reason: expect.stringContaining("no sealed pass") });
        writeHook(dir, `#!/bin/sh\nexec ${verify}\n`);

        writeFileSync(join(dir, "stray.txt"), "uncommitted\n");
        expect(decide(sha)).toMatchObject({ skip: false, reason: expect.stringContaining("stray.txt") });
        commitFile(box, dir, "stray.txt");
        expect(decide(sha)).toMatchObject({ skip: false, reason: expect.stringContaining("HEAD is now") });
        expect(readFileSync(join(dir, ".git", "hooks", "pre-push"), "utf8")).toContain(verify);
    });
});

describe("hookCommand", () => {
    test("reads the one command a plain shell hook runs", () => {
        expect(hookCommand("#!/bin/sh\nexec just verify push\n")).toBe("just verify push");
        expect(hookCommand("#!/usr/bin/env bash\nset -euo pipefail\n\n# gate\njust verify push\n")).toBe(
            "just verify push",
        );
        expect(hookCommand("just verify push")).toBe("just verify push");
        // One command, but not the bare recipe: the push compares it with the gate's recipe and keeps the hook.
        expect(hookCommand("#!/bin/sh\ncd sub && just verify push\n")).toBe("cd sub && just verify push");
    });

    test("anything more, or a non-shell hook, is not one command", () => {
        expect(hookCommand("#!/bin/sh\ngitleaks protect\njust verify push\n")).toBeNull();
        expect(hookCommand("#!/bin/sh\n")).toBeNull();
        expect(hookCommand("#!/usr/bin/env python3\njust verify push\n")).toBeNull();
    });
});
