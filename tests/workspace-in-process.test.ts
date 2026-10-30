// `project set` and the workspace functions called in this test process, so coverage sees them (workspace.test.ts
// and branch.test.ts drive the same behaviour through bin/toli subprocesses, which coverage cannot see).
import { describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findProject } from "../src/projects/projects.ts";
import { projectSetCommand } from "../src/projects/set.ts";
import {
    baseBranch,
    gitWorktrees,
    holdersText,
    prepareWorkspace,
    taskBranch,
    workDir,
    workspaceBrief,
    workspaceCommand,
} from "../src/projects/workspace.ts";
import { type TaskWorkspace, taskCommand } from "../src/records/backlog.ts";
import { commandIn, inProcess, type Sandbox, sandbox, withProject } from "./helpers.ts";

function coordinator(): Sandbox {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    return box;
}

describe("project set in process", () => {
    test("records overrides and grants, switches the clone, and refuses bad values", () => {
        const box = coordinator();
        const dir = withProject(box, "app");
        box.git(dir, ["branch", "develop"]);
        const set = commandIn(box.root, projectSetCommand);
        const task = commandIn(box.root, taskCommand);
        expect(
            set([
                "app",
                "--branch",
                "develop",
                "--forge",
                "gitlab",
                "--forge-host",
                "Git.Example.com:8443",
                "--standing-push",
                "yes",
                "--standing-pr",
                "yes",
            ]).split("\n"),
        ).toEqual([
            "app: mode=commit workspace=same-branch branch=develop forge=gitlab forge-host=git.example.com:8443 standing=push+pr",
            "projects/app: switched from main to develop",
        ]);
        const cleared = ["--forge", "none", "--forge-host", "none", "--standing-push", "no", "--standing-pr", "no"];
        expect(() => set(["app", "--standing-push", "no"])).toThrow("needs a standing push grant too");
        expect(set(["app", "--branch", "none", ...cleared])).toBe("app: mode=commit workspace=same-branch");

        const refusals: [string[], string][] = [
            [["app", "--forge", "svn"], "--forge must be one of"],
            [["app", "--forge-host", "https://git.example.com"], "--forge-host must be a host name"],
            [["app", "--branch", "bad..name"], '--branch "bad..name" is not a valid branch name'],
            [["app", "--standing-push", "maybe"], "--standing-push must be yes or no"],
            [["app", "--standing-pr", "yes"], "needs a standing push grant too"],
            [["app"], "nothing to set"],
            [["ghost", "--mode", "pr"], 'unknown project "ghost"'],
            [["app", "--all", "--workspace", "same-branch"], "takes a name or --all, not both"],
            [["--all"], "--all needs --workspace"],
            [["--all", "--workspace", "same-branch", "--forge", "github"], "set --forge per project"],
        ];
        for (const [argv, message] of refusals) expect(() => set(argv)).toThrow(message);

        expect(set(["app", "--workspace", "branch-per-task"]).split("\n")).toEqual([
            "app: mode commit -> pr (branch-per-task lands each task through a PR/MR)",
            "app: mode=pr workspace=branch-per-task",
        ]);
        expect(() => set(["app", "--mode", "commit"])).toThrow("mode commit does not fit");
        expect(set(["--all", "--workspace", "branch-per-task"])).toBe("1 project: workspace=branch-per-task");

        // A live task holding the clone on its branch keeps the clone where it is.
        task(["add", "app", "Login page"]);
        inProcess(box.root, () => prepareWorkspace("T1"));
        task(["start", "T1"]);
        expect(set(["app", "--branch", "main"])).toContain(
            "projects/app is still on toli/T1-login-page: T1 (active) is using it on toli/T1-login-page; " +
                `switch it when that is settled: git -C ${dir} switch main`,
        );
        task(["done", "T1"]);
        writeFileSync(join(dir, "stray.txt"), "stray\n");
        expect(set(["app", "--branch", "main"])).toContain(
            "is still on toli/T1-login-page: it has uncommitted changes",
        );
        rmSync(join(dir, "stray.txt"));
        expect(set(["app", "--branch", "nowhere"])).toContain(
            `or create it from toli/T1-login-page: git -C ${dir} switch -c nowhere`,
        );
        expect(set(["app", "--branch", "main"])).toContain("projects/app: switched from toli/T1-login-page to main");
        expect(box.git(dir, ["branch", "--show-current"])).toBe("main");
    });
});

describe("workspace in process", () => {
    test("task branches are derived from the id and a slug of the title", () => {
        expect(taskBranch({ id: "T3", title: "Fix: the Login page!" })).toBe("toli/T3-fix-the-login-page");
        expect(taskBranch({ id: "T9", title: " *** " })).toBe("toli/T9-task");
        expect(taskBranch({ id: "T4", title: "a".repeat(60) })).toBe(`toli/T4-${"a".repeat(40)}`);
    });

    test("prepares, finds, lists and prunes task worktrees", () => {
        const box = coordinator();
        const clone = withProject(box, "app");
        const set = commandIn(box.root, projectSetCommand);
        const task = commandIn(box.root, taskCommand);
        const workspace = commandIn(box.root, workspaceCommand);
        set(["app", "--workspace", "worktree-per-task"]);
        task(["add", "app", "Build API"]);
        task(["add", "app", "Draft docs"]);
        const worktree = join(box.root, "projects", ".worktrees", "app", "T1");

        const prepared: TaskWorkspace = {
            strategy: "worktree-per-task",
            path: worktree,
            branch: "toli/T1-build-api",
            base: "main",
        };
        expect(JSON.parse(workspace(["prepare", "T1", "--json"]))).toEqual(prepared);
        expect(workspace(["prepare", "T2"])).toBe(
            `worktree-per-task: ${join(box.root, "projects", ".worktrees", "app", "T2")} on toli/T2-draft-docs from main`,
        );
        inProcess(box.root, () => {
            expect(prepareWorkspace("t1")).toEqual(prepared);
            expect(baseBranch(findProject("app"), clone)).toBe("main");
            expect(gitWorktrees(clone).map((entry) => entry.branch)).toEqual([
                "main",
                "toli/T1-build-api",
                "toli/T2-draft-docs",
            ]);
            expect(workDir("app", "T1")).toMatchObject({ dir: worktree, branch: "toli/T1-build-api" });
            expect(workDir("app", undefined, worktree).task?.id).toBe("T1");
            expect(workDir("app", undefined, box.root)).toEqual({ dir: clone, task: null, branch: null });
            expect(() => workDir("app", "T9")).toThrow('unknown task "T9"');
            const brief = workspaceBrief("app", "T1", prepared);
            expect(brief).toContain("- Strategy: worktree-per-task");
            expect(brief).toContain(`- Path: ${worktree}`);
            expect(brief).toContain("bin/toli commit app --task T1");
        });

        task(["done", "T1"]);
        expect(JSON.parse(workspace(["list", "--json"]))).toHaveLength(2);
        expect(workspace(["list", "--project", "app"])).toContain(
            "app/T2\tqueued\ttoli/T2-draft-docs\tbase main\tmerged\tclean\tprojects/.worktrees/app/T2",
        );
        const pruned = workspace(["prune"]);
        expect(pruned).toContain("removed\tapp/T1\tbranch toli/T1-build-api deleted");
        expect(pruned).toContain("kept\tapp/T2\ttask is queued");
        expect(existsSync(worktree)).toBe(false);
        expect(() => workspace(["prepare", "T9"])).toThrow('unknown task "T9"');
        expect(() => workspace(["move"])).toThrow("usage: toli workspace prepare");

        set(["app", "--workspace", "same-branch"]);
        task(["add", "app", "Tweak copy"]);
        expect(JSON.parse(workspace(["prepare", "T3", "--json"]))).toEqual({
            strategy: "same-branch",
            path: clone,
            branch: "main",
            base: null,
        });
    });

    test("holdersText names each holder's status and branch", () => {
        const at = "2026-01-01T00:00:00.000Z";
        const base = { project: "app", shape: "ship" as const, notes: [], createdAt: at, updatedAt: at };
        expect(
            holdersText([
                {
                    ...base,
                    id: "T1",
                    title: "a",
                    status: "active",
                    workspace: { strategy: "branch-per-task", path: "/c", branch: "toli/T1-a", base: "main" },
                },
                { ...base, id: "T2", title: "b", status: "held" },
            ]),
        ).toBe("T1 (active) is using it on toli/T1-a, T2 (held) is using it on its branch");
    });
});
