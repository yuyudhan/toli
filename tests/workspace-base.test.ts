// Where a task branch starts (fresh from origin's base) and what switching a project's strategy leaves alone (T1779).
import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, sandbox, withProject } from "./helpers.ts";

/** Coordinator m1 with project `app` on `workspace` and one queued task per title; returns the clone path. */
function project(workspace: string, ...titles: string[]): { box: Sandbox; clone: string } {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    const clone = withProject(box, "app");
    box.ok(["project", "set", "app", "--workspace", workspace]);
    for (const title of titles) box.ok(["task", "add", "app", title]);
    return { box, clone };
}

describe("task workspaces across machines", () => {
    test("a task branch starts from origin's base, fetched fresh, never from a clone's stale base, and tracks nothing", () => {
        const { box, clone } = project("worktree-per-task", "Build API");
        box.ok(["project", "set", "app", "--task-branch", "app/<machine>/<id>-<slug>"]);
        // Another machine pushed to origin's main after this clone was made.
        const other = join(box.root, "other");
        box.git(box.root, ["clone", "--quiet", box.git(clone, ["remote", "get-url", "origin"]), other]);
        writeFileSync(join(other, "pushed.txt"), "from another machine\n");
        box.git(other, ["add", "pushed.txt"]);
        box.git(other, ["commit", "-m", "pushed elsewhere"]);
        box.git(other, ["push", "--quiet", "origin", "HEAD:main"]);
        const worktree = join(box.root, "projects", ".worktrees", "app", "T1");
        expect(box.ok(["workspace", "prepare", "T1"])).toBe(
            `worktree-per-task: ${worktree} on app/m1/T1-build-api from main`,
        );
        expect(existsSync(join(worktree, "pushed.txt"))).toBe(true);
        expect(existsSync(join(clone, "pushed.txt"))).toBe(false);
        expect(box.git(clone, ["branch", "-vv", "--list", "app/m1/T1-build-api"])).not.toContain("[origin/");
    });

    test("switching a project to worktree-per-task leaves a live task in the clone where it is", () => {
        const { box, clone } = project("same-branch", "Build API", "Draft docs");
        box.ok(["workspace", "prepare", "T1"]);
        box.ok(["task", "start", "T1"]);
        writeFileSync(join(clone, "wip.txt"), "uncommitted\n");
        box.ok(["project", "set", "app", "--workspace", "worktree-per-task"]);
        expect(box.ok(["workspace", "prepare", "T1"])).toContain(`same-branch: ${clone}`);
        expect(box.git(clone, ["branch", "--show-current"])).toBe("main");
        expect(existsSync(join(clone, "wip.txt"))).toBe(true);
        expect(box.ok(["workspace", "prepare", "T2"])).toContain("worktree-per-task: ");
    });

    test("a live task dispatched before the switch, its clone on its branch, commits from the clone", () => {
        const { box, clone } = project("same-branch", "End to end proof", "Draft docs");
        // Dispatched before any workspace was recorded: the jawan made its branch in the clone itself.
        box.ok(["task", "start", "T1"]);
        box.git(clone, ["switch", "--quiet", "-c", "app/m1/T1-e2e-proof"]);
        writeFileSync(join(clone, "proof.txt"), "proof\n");
        box.ok(["project", "set", "app", "--workspace", "worktree-per-task"]);
        box.ok(["commit", "app", "--task", "T1", "-m", "add proof", "--", "proof.txt"]);
        expect(box.git(clone, ["log", "-1", "--format=%s", "app/m1/T1-e2e-proof"])).toBe("add proof");
        expect(existsSync(join(box.root, "projects", ".worktrees", "app", "T1"))).toBe(false);
        expect(box.ok(["workspace", "prepare", "T1"])).toContain(`branch-per-task: ${clone} on app/m1/T1-e2e-proof`);
        // A task the branch does not name gets its own worktree, never the clone.
        box.ok(["task", "start", "T2"]);
        expect(box.ok(["workspace", "prepare", "T2"])).toContain("worktree-per-task: ");
    });
});
