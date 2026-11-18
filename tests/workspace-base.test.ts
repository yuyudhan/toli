// Where a task branch starts (fresh from origin's base) and what switching a project's strategy leaves alone (T1779).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

// T1804: a task prepared while its project was briefly toggled to another strategy keeps that record; `--reset`
// re-derives it from the current strategy when the recorded workspace holds none of the task's own work.
describe("workspace prepare --reset", () => {
    test("re-derives a record made under a toggled strategy", () => {
        const { box, clone } = project("worktree-per-task", "Build API");
        box.ok(["task", "start", "T1"]);
        box.ok(["project", "set", "app", "--workspace", "same-branch"]);
        expect(box.ok(["workspace", "prepare", "T1"])).toContain(`same-branch: ${clone}`);
        box.ok(["project", "set", "app", "--workspace", "worktree-per-task"]);
        expect(box.ok(["workspace", "prepare", "T1"])).toContain(`same-branch: ${clone}`);
        const worktree = join(box.root, "projects", ".worktrees", "app", "T1");
        expect(box.ok(["workspace", "prepare", "T1", "--reset"])).toBe(
            `worktree-per-task: ${worktree} on toli/m1/T1-build-api from main`,
        );
        expect(box.git(clone, ["branch", "--show-current"])).toBe("main");
    });

    test("refuses while the recorded workspace holds the task's commits, and keeps the record", () => {
        const { box, clone } = project("branch-per-task", "Build API");
        box.ok(["task", "start", "T1"]);
        box.ok(["workspace", "prepare", "T1"]);
        writeFileSync(join(clone, "api.txt"), "api\n");
        box.git(clone, ["add", "api.txt"]);
        box.git(clone, ["commit", "-m", "api"]);
        box.ok(["project", "set", "app", "--workspace", "worktree-per-task"]);
        const refused = box.toli(["workspace", "prepare", "T1", "--reset"]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("1 commit on toli/m1/T1-build-api not on main");
        expect(box.ok(["workspace", "prepare", "T1"])).toContain(`branch-per-task: ${clone} on toli/m1/T1-build-api`);
    });

    // T1904: a jawan toggled its worktree project to same-branch to push; a task prepared meanwhile landed on the clone.
    test("refuses to prepare a new task while a per-task project is toggled to same-branch under a live task", () => {
        const { box, clone } = project("worktree-per-task", "Build API", "Draft docs");
        box.ok(["task", "start", "T1"]);
        box.ok(["workspace", "prepare", "T1"]);
        expect(box.ok(["project", "set", "app", "--workspace", "same-branch"])).toContain(
            "T1 (active) still works in its worktree-per-task workspace",
        );
        const refused = box.toli(["workspace", "prepare", "T2"]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain(
            "refusing to prepare T2: projects/app is toggled from worktree-per-task to same-branch",
        );
        expect(refused.stderr).toContain("--workspace same-branch --keep");
        expect(box.ok(["workspace", "prepare", "T1"])).toContain("worktree-per-task: ");
        // Switching back ends the toggle: T2 gets its own worktree, never the clone.
        box.ok(["project", "set", "app", "--workspace", "worktree-per-task"]);
        expect(box.ok(["workspace", "prepare", "T2"])).toContain("worktree-per-task: ");
        // A switch the user means to keep applies to new tasks.
        box.ok(["task", "add", "app", "Ship it"]);
        box.ok(["project", "set", "app", "--workspace", "same-branch"]);
        expect(box.toli(["workspace", "prepare", "T3"]).code).toBe(1);
        expect(box.toli(["project", "set", "app", "--keep"]).stderr).toContain("--keep goes with --workspace");
        expect(box.ok(["project", "set", "app", "--workspace", "same-branch", "--keep"])).toBe(
            "app: mode=commit workspace=same-branch",
        );
        expect(box.ok(["workspace", "prepare", "T3"])).toContain(`same-branch: ${clone}`);
    });

    test("a strategy switch waits for a prepare in progress (the workspace lock)", () => {
        const { box } = project("worktree-per-task", "Build API");
        mkdirSync(join(box.root, "state"), { recursive: true });
        writeFileSync(join(box.root, "state", "workspace-app.lock"), String(process.pid));
        const blocked = box.toli(["project", "set", "app", "--workspace", "same-branch"]);
        expect(blocked.code).toBe(1);
        expect(blocked.stderr).toContain("timed out waiting for lock");
        expect(box.ok(["project", "list"])).toContain("worktree-per-task");
    }, 30_000);
});
