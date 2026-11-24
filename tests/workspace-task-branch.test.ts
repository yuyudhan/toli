// A task branch renamed in its workspace (`git branch -m`, to the project's own naming) is followed (T85): commit,
// push and workspace prepare all act on the renamed branch, and commit and push both refuse any other branch, so a
// push never sends a branch the task's commits are not on.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, sandbox, withProject } from "./helpers.ts";

/** Coordinator m1 with project `app` on `workspace` and one queued task, `T1`; returns the clone. */
function setup(workspace: string, title: string): { box: Sandbox; clone: string } {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    const clone = withProject(box, "app");
    box.ok(["project", "set", "app", "--workspace", workspace]);
    box.ok(["task", "add", "app", title]);
    return { box, clone };
}

function recordedBranch(box: Sandbox, id: string): unknown {
    const tasks = JSON.parse(box.ok(["task", "list", "--json"])) as { id: string; workspace?: { branch: unknown } }[];
    return tasks.find((entry) => entry.id === id)?.workspace?.branch;
}

function refused(box: Sandbox, args: string[], message: string): void {
    const result = box.toli(args);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
}

describe("a renamed task branch", () => {
    test("commit and push follow it and both refuse any other branch", () => {
        const { box } = setup("worktree-per-task", "Fix camera");
        box.ok(["project", "set", "app", "--standing-push", "yes"]);
        const worktree = join(box.root, "projects", ".worktrees", "app", "T1");
        box.ok(["workspace", "prepare", "T1"]);
        // The project's convention asks for another name than the one toli derived: the jawan renames it, twice.
        box.git(worktree, ["branch", "-m", "app/m1/T1-camera"]);
        box.git(worktree, ["branch", "-m", "app/m1/PROJ-7-camera"]);

        writeFileSync(join(worktree, "camera.txt"), "camera\n");
        const sha = box.ok(["commit", "app", "--task", "T1", "-m", "camera", "--", "camera.txt"]);
        expect(box.git(worktree, ["rev-parse", "app/m1/PROJ-7-camera"])).toBe(sha);
        expect(recordedBranch(box, "T1")).toBe("app/m1/PROJ-7-camera");
        box.ok(["push", "app", "--task", "T1"]);
        expect(box.git(worktree, ["ls-remote", "origin", "refs/heads/app/m1/PROJ-7-camera"])).toStartWith(sha);

        // A branch that is not the task's own (a new one, not a rename) is refused by both, pushing nothing.
        box.git(worktree, ["switch", "-c", "scratch"]);
        writeFileSync(join(worktree, "more.txt"), "more\n");
        const mismatch = `is on "scratch", but T1's branch is "app/m1/PROJ-7-camera"`;
        refused(box, ["commit", "app", "--task", "T1", "-m", "more", "--", "more.txt"], mismatch);
        refused(box, ["push", "app", "--task", "T1"], mismatch);
        expect(box.git(worktree, ["ls-remote", "origin", "refs/heads/scratch"])).toBe("");
    });

    test("workspace prepare keeps the renamed branch of a branch-per-task clone", () => {
        const { box, clone } = setup("branch-per-task", "Fix camera");
        box.ok(["workspace", "prepare", "T1"]);
        box.git(clone, ["branch", "-m", "app/m1/PROJ-7-camera"]);
        expect(box.ok(["workspace", "prepare", "T1"])).toBe(
            `branch-per-task: ${clone} on app/m1/PROJ-7-camera from main`,
        );
        expect(recordedBranch(box, "T1")).toBe("app/m1/PROJ-7-camera");
        expect(box.git(clone, ["branch", "--list", "toli/m1/T1-fix-camera"])).toBe("");
    });
});
