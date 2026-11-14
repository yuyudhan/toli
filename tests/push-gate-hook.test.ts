// `bin/toli push --gate "<recipe>"` must not run the same gate twice on one push (T1418): when the repo's pre-push hook
// runs exactly the gate's recipe and nothing else, and the gate passed (sealed proof) on exactly the commit being
// pushed from a clean checkout, the push skips that hook's identical run, says so, and pushes exactly that commit. Any
// other sha, a dirty checkout, another command, or a hook that does more keeps the hook.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookCommand, pushHookDecision } from "../src/forge/gate-hook.ts";
import { commitFile, gatesLog, recipe, runs, setup } from "./gate-fixture.ts";
import type { Sandbox } from "./helpers.ts";

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
        box.ok(["push", "app", "--gate", verify]);
        expect(runs(box)).toBe(2);
        expect(existsSync(seen)).toBe(true);
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
