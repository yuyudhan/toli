// `bin/toli push <p> --tag <name>` must not rerun the project's whole pre-push check on a release tag whose tree the
// gate already passed (T2288: a tag of an identical tree ran a 90-minute `just verify all`). Only a push of tags alone,
// through a hook that declares its tag-push gate recipes, each with a sealed pass on the tagged tree, skips the hook;
// a tag on a tree no gate passed, a hook without the declaration, or a push that also carries a branch runs it.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tagPushHookDecision } from "../src/forge/gate-hook.ts";
import { commitFile, gatesLog, recipe, runs, setup } from "./gate-fixture.ts";
import type { Sandbox } from "./helpers.ts";

// Each test runs a real detached gate runner and a real git push.
setDefaultTimeout(60_000);

const savedRoot = process.env.TOLI_ROOT;
afterEach(() => {
    if (savedRoot === undefined) delete process.env.TOLI_ROOT;
    else process.env.TOLI_ROOT = savedRoot;
});

/** Project "app" on branch `feature` with a new commit and a standing push grant. */
function pushable(): { box: Sandbox; dir: string } {
    const { box, dir } = setup();
    box.ok(["project", "set", "app", "--standing-push", "yes"]);
    box.git(dir, ["switch", "-c", "feature"]);
    commitFile(box, dir, "a.txt");
    return { box, dir };
}

function writeHook(dir: string, body: string): string {
    const hook = join(dir, ".git", "hooks", "pre-push");
    writeFileSync(hook, body, { mode: 0o755 });
    return hook;
}

/** A release commit with exactly HEAD's tree (another sha, the same files), tagged `name`; returns the tag object. */
function tagIdenticalTree(box: Sandbox, dir: string, name: string): string {
    box.git(dir, ["commit", "--allow-empty", "-m", `release ${name}`]);
    box.git(dir, ["tag", "-a", name, "-m", name]);
    return box.git(dir, ["rev-parse", `refs/tags/${name}`]);
}

function originTag(box: Sandbox, dir: string, name: string): string {
    return box.git(dir, ["ls-remote", "origin", `refs/tags/${name}`]);
}

describe("push --tag and the pre-push hook", () => {
    test("a tag of a tree the declared gate passed on skips the hook, says why, and pushes exactly that tag", () => {
        const { box, dir } = pushable();
        const verify = recipe(box, "verify", "echo ok");
        writeHook(dir, `#!/bin/sh\n# toli-tag-push-after-gate: ${verify}\nexec ${verify}\n`);
        box.ok(["gate", "run", "app", "--recipe", verify]);
        expect(runs(box)).toBe(1);
        const object = tagIdenticalTree(box, dir, "v1.0.0");
        const pushed = box.ok(["push", "app", "--tag", "v1.0.0"]);
        // The gate ran once, before the tag; the hook never reran it.
        expect(runs(box)).toBe(1);
        expect(pushed).toContain("skipping the pre-push hook");
        expect(pushed).toContain(`${verify} on tree `);
        expect(pushed).toContain("of tag v1.0.0 (proof ");
        expect(gatesLog(box)).toMatch(/ app [0-9a-f]{12} hook-skip: .*only tags/);
        expect(originTag(box, dir, "v1.0.0")).toContain(object);
        // Only the tag moved: the branch was not pushed.
        expect(box.git(dir, ["ls-remote", "origin", "refs/heads/feature"])).toBe("");
        expect(pushed).toContain("refs/tags/v1.0.0 (new)..");
        // Pushing it again changes nothing on origin.
        expect(box.ok(["push", "app", "--tag", "v1.0.0"])).toContain("origin already has tag v1.0.0");
    });

    test("a tag on a tree no gate passed on runs the hook", () => {
        const { box, dir } = pushable();
        const verify = recipe(box, "verify", "echo ok");
        writeHook(dir, `#!/bin/sh\n# toli-tag-push-after-gate: ${verify}\nexec ${verify}\n`);
        box.ok(["gate", "run", "app", "--recipe", verify]);
        commitFile(box, dir, "late.txt");
        box.git(dir, ["tag", "-a", "v1.0.1", "-m", "v1.0.1"]);
        const pushed = box.ok(["push", "app", "--tag", "v1.0.1"]);
        expect(runs(box)).toBe(2);
        expect(pushed).toContain(`running the pre-push hook: no sealed pass of ${verify} on tree`);
        expect(gatesLog(box)).not.toContain("hook-skip");
        expect(originTag(box, dir, "v1.0.1")).not.toBe("");
    });

    test("a hook that declares no tag-push gate runs, even on a passed tree", () => {
        const { box, dir } = pushable();
        const verify = recipe(box, "verify", "echo ok");
        writeHook(dir, `#!/bin/sh\nexec ${verify}\n`);
        box.ok(["gate", "run", "app", "--recipe", verify]);
        tagIdenticalTree(box, dir, "v1.0.2");
        const pushed = box.ok(["push", "app", "--tag", "v1.0.2"]);
        expect(runs(box)).toBe(2);
        expect(pushed).toContain("declares no `# toli-tag-push-after-gate: <recipe>`");
    });

    test("a push that carries a branch beside the tag keeps the hook, even on a passed tree", () => {
        const { box, dir } = pushable();
        const verify = recipe(box, "verify", "echo ok");
        const hook = writeHook(dir, `#!/bin/sh\n# toli-tag-push-after-gate: ${verify}\nexec ${verify}\n`);
        box.ok(["gate", "run", "app", "--recipe", verify]);
        const object = tagIdenticalTree(box, dir, "v1.1.0");
        const head = box.git(dir, ["rev-parse", "HEAD"]);
        process.env.TOLI_ROOT = box.root;
        const tagOnly = [{ object, remote: "refs/tags/v1.1.0" }];
        expect(tagPushHookDecision("app", dir, hook, tagOnly)).toMatchObject({ skip: true });
        const mixed = [{ object: head, remote: "refs/heads/feature" }, ...tagOnly];
        expect(tagPushHookDecision("app", dir, hook, mixed)).toEqual({
            skip: false,
            reason: "the push also carries refs/heads/feature, not only tags",
        });
        expect(tagPushHookDecision("app", dir, hook, [])).toMatchObject({ skip: false });
    });

    test("a tag origin holds at another object is refused, and --gate is refused beside --tag", () => {
        const { box, dir } = pushable();
        box.git(dir, ["tag", "v2.0.0"]);
        box.ok(["push", "app", "--tag", "v2.0.0"]);
        box.git(dir, ["tag", "-d", "v2.0.0"]);
        commitFile(box, dir, "moved.txt");
        box.git(dir, ["tag", "v2.0.0"]);
        const moved = box.toli(["push", "app", "--tag", "v2.0.0"]);
        expect(moved.code).toBe(1);
        expect(moved.stderr).toContain("a pushed tag is never moved");
        const gated = box.toli(["push", "app", "--tag", "v2.0.0", "--gate", "true"]);
        expect(gated.code).toBe(1);
        expect(gated.stderr).toContain("push --tag runs no gate");
        expect(box.toli(["push", "app", "--tag", "nope"]).stderr).toContain("has no tag nope");
    });
});
