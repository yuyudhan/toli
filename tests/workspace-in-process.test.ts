// `project set` and the workspace functions called in this test process, so coverage sees them (workspace.test.ts
// and branch.test.ts drive the same behaviour through bin/toli subprocesses, which coverage cannot see).
import { describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseBranch } from "../src/projects/base-branch.ts";
import { findProject } from "../src/projects/projects.ts";
import { projectSetCommand } from "../src/projects/set.ts";
import { gitWorktrees, holdersText, prepareWorkspace, taskBranch, workDir } from "../src/projects/workspace.ts";
import { workspaceBrief } from "../src/projects/workspace-brief.ts";
import { workspaceCommand } from "../src/projects/workspace-command.ts";
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

        // A per-task strategy keeps the mode: `commit` lands the task branch for the release machine to merge.
        expect(set(["app", "--workspace", "branch-per-task"])).toBe("app: mode=commit workspace=branch-per-task");
        expect(set(["app", "--mode", "pr"])).toBe("app: mode=pr workspace=branch-per-task");
        expect(set(["--all", "--workspace", "branch-per-task"])).toBe("1 project: workspace=branch-per-task");

        // A live task holding the clone on its branch keeps the clone where it is.
        task(["add", "app", "Login page"]);
        inProcess(box.root, () => prepareWorkspace("T1"));
        task(["start", "T1"]);
        expect(set(["app", "--branch", "main"])).toContain(
            "projects/app is still on toli/m1/T1-login-page: T1 (active) is using it on toli/m1/T1-login-page; " +
                `switch it when that is settled: git -C ${dir} switch main`,
        );
        task(["done", "T1"]);
        writeFileSync(join(dir, "stray.txt"), "stray\n");
        expect(set(["app", "--branch", "main"])).toContain(
            "is still on toli/m1/T1-login-page: it has uncommitted changes",
        );
        rmSync(join(dir, "stray.txt"));
        expect(set(["app", "--branch", "nowhere"])).toContain(
            `or create it from toli/m1/T1-login-page: git -C ${dir} switch -c nowhere`,
        );
        expect(set(["app", "--branch", "main"])).toContain("projects/app: switched from toli/m1/T1-login-page to main");
        expect(box.git(dir, ["branch", "--show-current"])).toBe("main");
    });
});

describe("workspace in process", () => {
    test("task branches carry the machine by default, or follow the project's pattern", () => {
        const box = coordinator();
        inProcess(box.root, () => {
            const app = { name: "app" };
            expect(taskBranch({ id: "T3", title: "Fix: the Login page!" }, app)).toBe("toli/m1/T3-fix-the-login-page");
            expect(taskBranch({ id: "T9", title: " *** " }, app)).toBe("toli/m1/T9-task");
            expect(taskBranch({ id: "T4", title: "a".repeat(60) }, app)).toBe(`toli/m1/T4-${"a".repeat(40)}`);
            const pattern = { name: "shop", taskBranch: "<project>/<machine>/<id>-<slug>" };
            expect(taskBranch({ id: "T12", title: "Cart" }, pattern)).toBe("shop/m1/T12-cart");
            expect(() => taskBranch({ id: "T1", title: "x" }, { name: "a", taskBranch: "bad..<id>" })).toThrow(
                "cannot derive a valid branch name",
            );
        });
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
            branch: "toli/m1/T1-build-api",
            base: "main",
        };
        expect(JSON.parse(workspace(["prepare", "T1", "--json"]))).toEqual(prepared);
        expect(workspace(["prepare", "T2"])).toBe(
            `worktree-per-task: ${join(box.root, "projects", ".worktrees", "app", "T2")} on toli/m1/T2-draft-docs from main`,
        );
        inProcess(box.root, () => {
            expect(prepareWorkspace("t1")).toEqual(prepared);
            expect(baseBranch(findProject("app"), clone)).toBe("main");
            expect(gitWorktrees(clone).map((entry) => entry.branch)).toEqual([
                "main",
                "toli/m1/T1-build-api",
                "toli/m1/T2-draft-docs",
            ]);
            expect(workDir("app", "T1")).toMatchObject({ dir: worktree, branch: "toli/m1/T1-build-api" });
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
            "app/T2\tqueued\ttoli/m1/T2-draft-docs\tbase main\tmerged\tclean\tprojects/.worktrees/app/T2",
        );
        const pruned = workspace(["prune"]);
        expect(pruned).toContain("removed\tapp/T1\tbranch toli/m1/T1-build-api deleted");
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

    test("cuts task branches from origin's fetched default branch, never the clone's checked-out branch", () => {
        const box = coordinator();
        const clone = withProject(box, "app");
        const set = commandIn(box.root, projectSetCommand);
        const task = commandIn(box.root, taskCommand);
        const workspace = commandIn(box.root, workspaceCommand);
        set(["app", "--workspace", "worktree-per-task"]);
        // The clone sits on a nightly branch of its own, with no record of origin's HEAD.
        box.git(clone, ["switch", "-c", "nightly"]);
        writeFileSync(join(clone, "nightly.txt"), "nightly\n");
        box.git(clone, ["add", "nightly.txt"]);
        box.git(clone, ["commit", "-m", "nightly work"]);
        box.git(clone, ["push", "origin", "nightly"]);
        box.git(clone, ["remote", "set-head", "origin", "--delete"]);
        // Origin's main moves on after this clone last fetched it.
        const other = join(box.root, "other");
        box.git(box.root, ["clone", "--quiet", join(box.root, ".origin", "app.git"), other]);
        writeFileSync(join(other, "fleet.txt"), "fleet\n");
        box.git(other, ["add", "fleet.txt"]);
        box.git(other, ["commit", "-m", "fleet work"]);
        box.git(other, ["push", "origin", "main"]);
        const originMain = box.git(other, ["rev-parse", "HEAD"]);

        task(["add", "app", "Build API"]);
        expect(JSON.parse(workspace(["prepare", "T1", "--json"]))).toMatchObject({ base: "main" });
        const worktree = join(box.root, "projects", ".worktrees", "app", "T1");
        expect(box.git(worktree, ["rev-parse", "HEAD"])).toBe(originMain);

        // Without origin's HEAD it falls back to origin's main, here as last fetched (origin unreachable).
        box.git(clone, ["remote", "set-head", "origin", "--delete"]);
        box.git(clone, ["remote", "set-url", "origin", join(box.root, "gone.git")]);
        task(["add", "app", "Draft docs"]);
        expect(JSON.parse(workspace(["prepare", "T2", "--json"]))).toMatchObject({ base: "main" });
        expect(box.git(join(box.root, "projects", ".worktrees", "app", "T2"), ["rev-parse", "HEAD"])).toBe(originMain);
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
