// `bin/toli workspace prune` never removes a task worktree holding unlanded work (T1218).
import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, sandbox, withProject } from "./helpers.ts";

function coordinator(): Sandbox {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    return box;
}

/** A worktree-per-task project with one queued ship task per title; returns the clone path. */
function project(box: Sandbox, ...titles: string[]): string {
    const dir = withProject(box, "app");
    box.ok(["project", "set", "app", "--workspace", "worktree-per-task"]);
    for (const title of titles) box.ok(["task", "add", "app", title]);
    return dir;
}

describe("workspace prune", () => {
    test("never removes unlanded work and has no --force; a clean, landed worktree still goes", () => {
        const box = coordinator();
        const clone = project(box, "Try idea", "Scratch", "Landed", "Ongoing");
        for (const id of ["T1", "T2", "T3", "T4"]) box.ok(["workspace", "prepare", id]);
        box.ok(["task", "start", "T4"]);
        const holder = join(box.root, "projects", ".worktrees", "app");
        writeFileSync(join(holder, "T1", "idea.txt"), "idea\n");
        box.ok(["commit", "app", "--task", "T1", "-m", "idea", "--", "idea.txt"]);
        writeFileSync(join(holder, "T2", "scratch.txt"), "scratch\n");
        box.ok(["task", "drop", "T1"]);
        box.ok(["task", "drop", "T2"]);
        box.ok(["task", "done", "T3"]);

        const forced = box.toli(["workspace", "prune", "--force"]);
        expect(forced.code).toBe(1);
        expect(forced.stderr).toContain("--force");
        expect(existsSync(join(holder, "T1", "idea.txt"))).toBe(true);

        const pruned = box.ok(["workspace", "prune"]);
        expect(pruned).toContain("kept: projects/.worktrees/app/T1: 1 unlanded commit / 0 dirty files");
        expect(pruned).toContain("kept: projects/.worktrees/app/T2: 0 unlanded commits / 1 dirty file");
        expect(pruned).toMatch(/removed\tapp\/T3\tbranch toli\/T3-landed deleted \(was [0-9a-f]{12}\)/);
        expect(pruned).toContain("kept\tapp/T4\ttask is active");
        expect(existsSync(join(holder, "T1", "idea.txt"))).toBe(true);
        expect(existsSync(join(holder, "T2", "scratch.txt"))).toBe(true);
        expect(existsSync(join(holder, "T3"))).toBe(false);
        expect(box.git(clone, ["branch", "--list", "toli/T1-try-idea"])).toContain("toli/T1-try-idea");
        expect(box.git(clone, ["branch", "--list", "toli/T3-landed"])).toBe("");
        expect(JSON.parse(box.ok(["workspace", "prune", "--json"]))).toContainEqual([
            "kept",
            "app/T1",
            "projects/.worktrees/app/T1: 1 unlanded commit / 0 dirty files",
        ]);
    });
});
