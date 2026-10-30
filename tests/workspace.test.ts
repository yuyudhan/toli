import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GIT_ENV, type Sandbox, sandbox, TOLI_BIN, withProject } from "./helpers.ts";

type ProjectJson = {
    name: string;
    mode: string;
    workspace: string;
    workspaceSetAt?: string;
    standing: { push: boolean; pr: boolean };
    linkedTo: string | null;
    brokenLink: string | null;
};

function coordinator(): Sandbox {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    return box;
}

function projects(box: Sandbox): ProjectJson[] {
    return JSON.parse(box.ok(["project", "list", "--json"])) as ProjectJson[];
}

function setMachineDefault(box: Sandbox, workspace: string): void {
    const file = join(box.root, "config", "machine.json");
    const machine = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...machine, defaults: { workspace } }));
}

function refused(box: Sandbox, args: string[], message: string): void {
    const result = box.toli(args);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
}

/** A project with the given strategy and one queued ship task per title; returns the clone path. */
function project(box: Sandbox, workspace: string, ...titles: string[]): string {
    const dir = withProject(box, "app");
    box.ok(["project", "set", "app", "--workspace", workspace]);
    for (const title of titles) box.ok(["task", "add", "app", title]);
    return dir;
}

function task(box: Sandbox, id: string): Record<string, unknown> & { workspace?: Record<string, unknown> } {
    const tasks = JSON.parse(box.ok(["task", "list", "--json"])) as { id: string }[];
    return tasks.find((entry) => entry.id === id) as Record<string, unknown> & { workspace?: Record<string, unknown> };
}

describe("workspace config", () => {
    test("validates strategies and standing grants, and --all sets every project", () => {
        const box = coordinator();
        withProject(box, "app");
        withProject(box, "web");
        expect(projects(box).map((entry) => entry.workspace)).toEqual(["same-branch", "same-branch"]);
        expect(projects(box)[0]?.workspaceSetAt).toBeUndefined();
        refused(box, ["project", "set", "app", "--workspace", "worktrees"], "--workspace must be one of same-branch");
        refused(box, ["project", "set", "app", "--standing-push", "maybe"], "--standing-push must be yes or no");
        refused(box, ["project", "set", "app", "--standing-pr", "yes"], "needs a standing push grant");
        refused(box, ["project", "set", "--all"], "--all needs --workspace");
        refused(
            box,
            ["project", "set", "--all", "--workspace", "same-branch", "--mode", "pr"],
            "sets only --workspace",
        );

        expect(box.ok(["project", "set", "app", "--workspace", "worktree-per-task", "--standing-push", "yes"])).toBe(
            "app: mode commit -> pr (worktree-per-task lands each task through a PR/MR)\n" +
                "app: mode=pr workspace=worktree-per-task standing=push",
        );
        refused(box, ["project", "set", "app", "--mode", "commit"], "mode commit does not fit");
        expect(box.ok(["project", "set", "app", "--standing-pr", "yes"])).toContain("standing=push+pr");
        expect(projects(box)[0]).toMatchObject({
            workspace: "worktree-per-task",
            workspaceSetAt: expect.any(String),
            standing: { push: true, pr: true },
        });
        expect(box.ok(["project", "set", "app", "--standing-push", "no", "--standing-pr", "no"])).not.toContain(
            "standing=",
        );
        expect(projects(box)[0]?.standing).toEqual({ push: false, pr: false });

        expect(box.ok(["project", "set", "--all", "--workspace", "same-branch"])).toBe(
            "2 projects: workspace=same-branch",
        );
        expect(projects(box).map((entry) => [entry.workspace, entry.mode])).toEqual([
            ["same-branch", "pr"],
            ["same-branch", "commit"],
        ]);
        expect(box.ok(["project", "list"])).toContain("workspace=same-branch");
    });

    test("the machine default applies to new projects and is reported as defaulted by project setup", () => {
        const box = coordinator();
        setMachineDefault(box, "worktree-per-task");
        withProject(box, "app");
        expect(projects(box)[0]).toMatchObject({ workspace: "worktree-per-task", mode: "pr" });
        const report = JSON.parse(box.ok(["project", "setup", "app", "--json"])) as {
            checks: { key: string; status: string; detail: string }[];
        };
        expect(report.checks.find((check) => check.key === "workspace")).toMatchObject({
            status: "missing",
            detail: expect.stringContaining("never chosen; defaulted to worktree-per-task"),
        });
        box.ok(["project", "set", "app", "--workspace", "worktree-per-task"]);
        expect(box.ok(["project", "setup", "app"])).toContain("[x] workspace");

        setMachineDefault(box, "nonsense");
        const origin = join(box.root, ".origin", "app.git");
        refused(box, ["project", "ensure", "web", origin], "config/machine.json defaults.workspace must be one of");
    });

    test("migrate records each legacy project's current behaviour", () => {
        const box = coordinator();
        mkdirSync(join(box.root, "data"), { recursive: true });
        const file = join(box.root, "data", "projects.json");
        const entry = (name: string, mode: string, branch?: string) => ({
            name,
            url: `git@example.com:a/${name}.git`,
            mode,
            addedAt: "2026-01-01T00:00:00.000Z",
            ...(branch === undefined ? {} : { branch }),
        });
        writeFileSync(
            file,
            JSON.stringify({
                projects: [
                    entry("kalki", "commit", "ankur/nightly"),
                    entry("reviewed", "pr"),
                    entry("gated", "no-mistakes"),
                    entry("gated-fixed", "no-mistakes", "release"),
                ],
            }),
        );
        const dry = box.ok(["migrate", "--dry-run"]);
        expect(dry).toContain("would record the workspace strategy of 4 projects");
        expect(dry).toContain("  kalki: same-branch");
        expect(JSON.parse(readFileSync(file, "utf8")).projects[0].workspace).toBeUndefined();
        expect(box.ok(["migrate"])).toContain("recorded the workspace strategy of 4 projects");
        const stored = JSON.parse(readFileSync(file, "utf8")).projects as { name: string; workspace: string }[];
        expect(stored.map((project) => [project.name, project.workspace])).toEqual([
            ["kalki", "same-branch"],
            ["reviewed", "branch-per-task"],
            ["gated", "branch-per-task"],
            ["gated-fixed", "same-branch"],
        ]);
        expect(box.ok(["migrate"])).not.toContain("workspace strategy");
    });
});

describe("branch-per-task", () => {
    test("switches the clone to a task branch and refuses while another live task holds it", () => {
        const box = coordinator();
        const dir = project(box, "branch-per-task", "Add login page", "Fix footer");
        expect(box.ok(["workspace", "prepare", "T1"])).toBe(
            `branch-per-task: ${dir} on toli/T1-add-login-page from main`,
        );
        expect(box.git(dir, ["branch", "--show-current"])).toBe("toli/T1-add-login-page");
        box.ok(["task", "start", "T1"]);
        expect(task(box, "T1").workspace).toEqual({
            strategy: "branch-per-task",
            path: dir,
            branch: "toli/T1-add-login-page",
            base: "main",
        });
        expect(box.ok(["workspace", "prepare", "T1"])).toContain("toli/T1-add-login-page");

        const conflict = box.toli(["workspace", "prepare", "T2"]);
        expect(conflict.code).toBe(1);
        expect(conflict.stderr).toContain("T1 (active) is using it on toli/T1-add-login-page");
        expect(conflict.stderr).toContain("--workspace same-branch");
        expect(box.git(dir, ["branch", "--show-current"])).toBe("toli/T1-add-login-page");

        writeFileSync(join(dir, "login.txt"), "login\n");
        refused(box, ["commit", "app", "-m", "add login", "--", "login.txt"], "pass --task <T-id>");
        box.ok(["commit", "app", "--task", "T1", "-m", "add login", "--", "login.txt"]);
        box.ok(["task", "done", "T1"]);

        writeFileSync(join(dir, "stray.txt"), "uncommitted\n");
        refused(box, ["workspace", "prepare", "T2"], "the clone has uncommitted changes");
        box.git(dir, ["add", "stray.txt"]);
        box.git(dir, ["commit", "-m", "stray"]);
        expect(box.ok(["workspace", "prepare", "T2"])).toContain("toli/T2-fix-footer from main");
        expect(existsSync(join(dir, "login.txt"))).toBe(false);
    });
});

describe("worktree-per-task", () => {
    test("adds a worktree per task, commits inside it, and prune removes only merged, finished, clean ones", () => {
        const box = coordinator();
        const clone = project(box, "worktree-per-task", "Build API", "Draft docs", "Spike cache");
        const worktree = join(box.root, "projects", ".worktrees", "app", "T1");
        expect(box.ok(["workspace", "prepare", "T1"])).toBe(
            `worktree-per-task: ${worktree} on toli/T1-build-api from main`,
        );
        expect(box.git(worktree, ["branch", "--show-current"])).toBe("toli/T1-build-api");
        expect(box.git(clone, ["branch", "--show-current"])).toBe("main");
        box.ok(["workspace", "prepare", "T2"]);
        box.ok(["workspace", "prepare", "T3"]);

        writeFileSync(join(worktree, "api.txt"), "api\n");
        refused(box, ["commit", "app", "-m", "api", "--", "api.txt"], "pass --task <T-id>");
        const sha = box.ok(["commit", "app", "--task", "T1", "-m", "add api", "--", "api.txt"]);
        expect(box.git(worktree, ["rev-parse", "HEAD"])).toBe(sha);
        expect(box.git(clone, ["log", "--oneline", "main"])).not.toContain("add api");

        // From inside the worktree, the task is found from the working directory.
        writeFileSync(join(worktree, "more.txt"), "more\n");
        const inside = Bun.spawnSync([process.execPath, TOLI_BIN, "commit", "app", "-m", "more", "--", "more.txt"], {
            cwd: worktree,
            env: { ...process.env, ...GIT_ENV, TOLI_ROOT: box.root },
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(inside.stderr.toString()).toBe("");
        expect(box.git(worktree, ["log", "-1", "--format=%s"])).toBe("more");

        writeFileSync(join(box.root, "projects", ".worktrees", "app", "T3", "wip.txt"), "wip\n");
        box.ok(["task", "done", "T1"]);
        box.ok(["task", "drop", "T3"]);
        const list = box.ok(["workspace", "list"]);
        expect(list).toContain(
            "app/T1\tdone\ttoli/T1-build-api\tbase main\tunmerged 2\tclean\tprojects/.worktrees/app/T1",
        );
        expect(list).toContain("app/T2\tqueued\ttoli/T2-draft-docs\tbase main\tmerged\tclean");
        expect(list).toContain("app/T3\tdropped\ttoli/T3-spike-cache\tbase main\tmerged\tdirty");

        const first = box.ok(["workspace", "prune"]);
        expect(first).toContain(
            "kept\tapp/T1\ttoli/T1-build-api has 2 commits not on main; abandon it only on Malik's word: --force",
        );
        expect(first).toContain("kept\tapp/T2\ttask is queued");
        expect(first).toContain("kept\tapp/T3\tuncommitted changes");
        expect(existsSync(worktree)).toBe(true);

        box.git(clone, ["merge", "--no-ff", "-m", "merge T1", "toli/T1-build-api"]);
        const second = box.ok(["workspace", "prune", "--project", "app"]);
        expect(second).toContain("removed\tapp/T1\tbranch toli/T1-build-api deleted");
        expect(existsSync(worktree)).toBe(false);
        expect(box.git(clone, ["branch", "--list", "toli/T1-build-api"])).toBe("");
        expect(existsSync(join(box.root, "projects", ".worktrees", "app", "T3", "wip.txt"))).toBe(true);
        expect(box.ok(["workspace", "prune", "--force"])).toContain("kept\tapp/T3\tuncommitted changes");
    });

    test("--force abandons an unmerged finished worktree; live tasks are never pruned", () => {
        const box = coordinator();
        const clone = project(box, "worktree-per-task", "Try idea", "Ongoing");
        box.ok(["workspace", "prepare", "T1"]);
        box.ok(["workspace", "prepare", "T2"]);
        box.ok(["task", "start", "T2"]);
        const worktree = join(box.root, "projects", ".worktrees", "app", "T1");
        writeFileSync(join(worktree, "idea.txt"), "idea\n");
        box.ok(["commit", "app", "--task", "T1", "-m", "idea", "--", "idea.txt"]);
        box.ok(["task", "drop", "T1"]);
        const pruned = box.ok(["workspace", "prune", "--force"]);
        expect(pruned).toMatch(/removed\tapp\/T1\tbranch toli\/T1-try-idea deleted \(was [0-9a-f]{12}\)/);
        expect(pruned).toContain("kept\tapp/T2\ttask is active");
        expect(box.git(clone, ["branch", "--list", "toli/T2-ongoing"])).toContain("toli/T2-ongoing");
    });
});

describe("briefs carry the workspace", () => {
    test("both templates name strategy, path and branch, and spawn appends the prepared workspace", () => {
        for (const template of ["brief-template.md", "verify-brief-template.md"]) {
            const text = readFileSync(resolve(import.meta.dir, "..", "docs", template), "utf8");
            expect(text).toContain("- Workspace: <same-branch | branch-per-task | worktree-per-task>");
            expect(text).toContain("- Path: <");
            expect(text).toContain("- Branch: <");
        }
        const box = coordinator();
        project(box, "worktree-per-task", "Build API");
        box.stub("omp", "echo done");
        const brief = join(box.root, "brief.md");
        writeFileSync(brief, "TOLI_BRIEF v1\nbuild it\n");
        const run = JSON.parse(box.ok(["spawn", "--task", "T1", "--brief", brief, "--harness", "omp", "--json"])) as {
            cwd: string;
            briefPath: string;
        };
        const worktree = join(box.root, "projects", ".worktrees", "app", "T1");
        expect(run.cwd).toBe(worktree);
        const sent = readFileSync(run.briefPath, "utf8");
        expect(sent).toContain("## Workspace (prepared by bin/toli spawn)");
        expect(sent).toContain("- Strategy: worktree-per-task");
        expect(sent).toContain(`- Path: ${worktree}`);
        expect(sent).toContain("- Branch: toli/T1-build-api, from main");
        expect(sent).toContain("bin/toli commit app --task T1");
    });
});

describe("project link", () => {
    test("links an existing checkout, flags a broken link, and drop removes only the symlink", () => {
        const box = coordinator();
        withProject(box, "seedsource");
        const checkout = join(box.root, ".mine", "shop");
        mkdirSync(join(box.root, ".mine"), { recursive: true });
        box.git(join(box.root, ".mine"), ["clone", join(box.root, ".origin", "seedsource.git"), checkout]);
        box.git(checkout, ["switch", "-c", "feature"]);

        refused(box, ["project", "link", "shop", join(box.root, "nowhere")], "does not exist");
        mkdirSync(join(box.root, ".mine", "plain"));
        refused(box, ["project", "link", "shop", join(box.root, ".mine", "plain")], "is not a git checkout");
        refused(box, ["project", "link", "shop", join(box.root, "projects", "seedsource")], "inside toli's projects/");

        const linked = box.ok(["project", "link", "shop", checkout]);
        const target = realpathSync(checkout);
        expect(linked).toContain(`linked shop: projects/shop -> ${target} (mode commit, workspace same-branch)`);
        expect(linked).toContain(`origin: ${join(box.root, ".origin", "seedsource.git")}`);
        expect(linked).toContain("branch: feature");
        const link = join(box.root, "projects", "shop");
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(projects(box).find((entry) => entry.name === "shop")).toMatchObject({
            linkedTo: target,
            brokenLink: null,
        });
        expect(box.ok(["project", "list"])).toContain(`linked -> ${target}`);
        refused(box, ["project", "link", "shop", checkout], 'project "shop" already exists');

        // Worktrees of a linked project live under toli's projects/.worktrees, not in the user's checkout.
        box.ok(["project", "set", "shop", "--workspace", "worktree-per-task", "--branch", "main"]);
        box.ok(["task", "add", "shop", "Linked work"]);
        box.ok(["workspace", "prepare", "T1"]);
        expect(existsSync(join(box.root, "projects", ".worktrees", "shop", "T1", "README"))).toBe(true);
        box.git(checkout, ["worktree", "remove", join(box.root, "projects", ".worktrees", "shop", "T1")]);

        renameSync(checkout, `${checkout}-moved`);
        expect(box.ok(["project", "setup", "shop"])).toContain("is broken: that checkout was moved or deleted");
        expect(box.ok(["digest"])).toContain("shop: link to");
        expect(box.ok(["project", "list"])).toContain("broken link");
        renameSync(`${checkout}-moved`, checkout);

        writeFileSync(join(checkout, "dirty.txt"), "user's own work\n");
        expect(box.ok(["project", "drop", "shop", "--delete-clone", "--delete-data"])).toContain(
            `the symlink projects/shop (its checkout ${target} is untouched)`,
        );
        expect(existsSync(link)).toBe(false);
        expect(readFileSync(join(checkout, "dirty.txt"), "utf8")).toBe("user's own work\n");
        expect(existsSync(join(checkout, ".git"))).toBe(true);
    });
});
