// A per-task project that also runs a release train (T1980): one task pinned to the clone on the project's fixed
// branch (`workspace prepare --same-branch`), and task worktrees starting from another base (`--base-branch`).
import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, sandbox, withProject } from "./helpers.ts";

/**
 * Coordinator m1 with worktree-per-task project `app` whose fixed branch is `nightly` (one commit ahead of main, on
 * origin too) and one queued task per title; returns the clone path.
 */
function trainProject(...titles: string[]): { box: Sandbox; clone: string } {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    const clone = withProject(box, "app");
    box.git(clone, ["switch", "--quiet", "-c", "nightly"]);
    writeFileSync(join(clone, "nightly.txt"), "nightly\n");
    box.git(clone, ["add", "nightly.txt"]);
    box.git(clone, ["commit", "-m", "nightly"]);
    box.git(clone, ["push", "--quiet", "origin", "nightly"]);
    box.ok(["project", "set", "app", "--workspace", "worktree-per-task", "--branch", "nightly"]);
    for (const title of titles) box.ok(["task", "add", "app", title]);
    return { box, clone };
}

describe("a task pinned to the clone on a per-task project", () => {
    test("commits with --task in the clone on the fixed branch, while other tasks keep their worktrees", () => {
        const { box, clone } = trainProject("Release train", "Build API");
        expect(box.ok(["workspace", "prepare", "T1", "--same-branch"])).toBe(
            `same-branch: ${clone} on nightly (pinned)`,
        );
        // The pin holds whatever the task's status: a queued train is prepared on the clone again.
        expect(box.ok(["workspace", "prepare", "T1"])).toBe(`same-branch: ${clone} on nightly (pinned)`);
        writeFileSync(join(clone, "release.txt"), "release\n");
        box.ok(["commit", "app", "--task", "T1", "-m", "cut release", "--", "release.txt"]);
        expect(box.git(clone, ["log", "-1", "--format=%s", "nightly"])).toBe("cut release");
        // Without --task the clone is still refused: only the pinned task commits there.
        writeFileSync(join(clone, "other.txt"), "other\n");
        const refused = box.toli(["commit", "app", "-m", "stray", "--", "other.txt"]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("pass --task <T-id>");
        expect(box.ok(["workspace", "prepare", "T2"])).toContain("worktree-per-task: ");
        // --reset drops the pin and re-derives the workspace from the project's strategy.
        expect(box.ok(["workspace", "prepare", "T1", "--reset"])).toContain("worktree-per-task: ");
    });

    test("refuses to pin a task whose worktree holds its own commits, and keeps the worktree", () => {
        const { box } = trainProject("Release train");
        box.ok(["workspace", "prepare", "T1"]);
        const worktree = join(box.root, "projects", ".worktrees", "app", "T1");
        writeFileSync(join(worktree, "api.txt"), "api\n");
        box.git(worktree, ["add", "api.txt"]);
        box.git(worktree, ["commit", "-m", "api"]);
        const refused = box.toli(["workspace", "prepare", "T1", "--same-branch"]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("1 commit on toli/m1/T1-release-train not on nightly");
        expect(existsSync(worktree)).toBe(true);
        expect(box.toli(["workspace", "prepare", "T1", "--same-branch", "--reset"]).stderr).toContain(
            "--same-branch and --reset",
        );
    });
});

describe("project set --base-branch", () => {
    test("task worktrees start from the base branch, not the fixed branch, until it is cleared", () => {
        const { box } = trainProject("Build API", "Draft docs");
        expect(box.ok(["project", "set", "app", "--base-branch", "main"])).toBe(
            "app: mode=commit workspace=worktree-per-task branch=nightly base-branch=main",
        );
        const worktree = join(box.root, "projects", ".worktrees", "app", "T1");
        expect(box.ok(["workspace", "prepare", "T1"])).toBe(
            `worktree-per-task: ${worktree} on toli/m1/T1-build-api from main`,
        );
        expect(existsSync(join(worktree, "nightly.txt"))).toBe(false);
        expect(box.toli(["project", "set", "app", "--base-branch", "origin/main"]).stderr).toContain(
            'takes the branch name ("main")',
        );
        box.ok(["project", "set", "app", "--base-branch", "none"]);
        expect(box.ok(["workspace", "prepare", "T2"])).toContain("from nightly");
    });
});
