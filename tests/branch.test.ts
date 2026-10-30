import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, sandbox, withProject } from "./helpers.ts";

describe("fixed working branch", () => {
    test("commit refuses on a mismatch and succeeds when matching or unset", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const dir = withProject(box, "app");
        const set = box.ok(["project", "set", "app", "--branch", "develop"]).split("\n");
        expect(set[0]).toBe("app: mode=commit workspace=same-branch branch=develop");
        expect(set[1]).toContain("projects/app is still on main: branch develop exists neither locally nor on origin");
        writeFileSync(join(dir, "a.txt"), "a\n");
        const head = box.git(dir, ["rev-parse", "HEAD"]);
        const refused = box.toli(["commit", "app", "-m", "add a", "--", "a.txt"]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain('is on "main", but its working branch is "develop"');
        expect(refused.stderr).toContain(`git -C ${dir} switch develop`);
        expect(refused.stderr).toContain("ask Malik");
        expect(box.git(dir, ["rev-parse", "HEAD"])).toBe(head);

        const digest = JSON.parse(box.ok(["digest", "--json"]));
        expect(digest.projects[0]).toMatchObject({ branch: "develop", branchMismatch: true });
        expect(box.ok(["digest"])).toContain("BRANCH MISMATCH: working branch is develop");
        expect(box.ok(["project", "list"])).toContain("branch=develop");

        box.ok(["project", "set", "app", "--branch", "main"]);
        box.ok(["commit", "app", "-m", "add a", "--", "a.txt"]);
        expect(JSON.parse(box.ok(["digest", "--json"])).projects[0].branchMismatch).toBe(false);

        box.git(dir, ["switch", "-c", "other"]);
        box.ok(["project", "set", "app", "--branch", "none"]);
        writeFileSync(join(dir, "b.txt"), "b\n");
        box.ok(["commit", "app", "-m", "add b", "--", "b.txt"]);
        expect(JSON.parse(box.ok(["project", "list", "--json"]))[0].branch).toBeNull();
        expect(box.toli(["project", "set", "app", "--branch", "bad..name"]).code).toBe(1);
    });

    test("a legacy projects.json without the new fields still loads and gains them on write", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        mkdirSync(join(box.root, "data"), { recursive: true });
        const file = join(box.root, "data", "projects.json");
        const legacy = {
            name: "old",
            url: "git@example.com:a/old.git",
            mode: "pr",
            addedAt: "2026-01-01T00:00:00.000Z",
        };
        writeFileSync(file, JSON.stringify({ projects: [{ ...legacy, owner: "someone" }] }));
        expect(JSON.parse(box.ok(["project", "list", "--json"]))).toEqual([
            {
                ...legacy,
                branch: null,
                workspace: "branch-per-task",
                standing: { push: false, pr: false },
                path: join(box.root, "projects", "old"),
                cloned: false,
                linkedTo: null,
                brokenLink: null,
            },
        ]);
        box.ok(["project", "set", "old", "--branch", "main", "--forge", "gitlab", "--forge-host", "Git.Example.com"]);
        expect(JSON.parse(readFileSync(file, "utf8")).projects).toEqual([
            {
                ...legacy,
                branch: "main",
                workspace: "branch-per-task",
                forge: "gitlab",
                forgeHost: "git.example.com",
                deliverySetAt: expect.any(String),
            },
        ]);
    });
});

describe("project set --branch switches the clone", () => {
    function setUp(): { box: Sandbox; dir: string } {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        return { box, dir: withProject(box, "app") };
    }
    const head = (box: Sandbox, dir: string) => box.git(dir, ["branch", "--show-current"]);

    test("a clean clone switches to an existing local branch", () => {
        const { box, dir } = setUp();
        box.git(dir, ["branch", "develop"]);
        expect(box.ok(["project", "set", "app", "--branch", "develop"])).toBe(
            "app: mode=commit workspace=same-branch branch=develop\nprojects/app: switched from main to develop",
        );
        expect(head(box, dir)).toBe("develop");
        expect(box.ok(["project", "set", "app", "--branch", "develop"])).toBe(
            "app: mode=commit workspace=same-branch branch=develop",
        );
    });

    test("a branch only on origin becomes a local branch tracking it", () => {
        const { box, dir } = setUp();
        box.git(dir, ["switch", "-c", "release"]);
        box.git(dir, ["push", "origin", "release"]);
        box.git(dir, ["switch", "main"]);
        box.git(dir, ["branch", "-D", "release"]);
        expect(box.ok(["project", "set", "app", "--branch", "release"])).toContain(
            "projects/app: switched from main to release (tracking origin/release)",
        );
        expect(head(box, dir)).toBe("release");
        expect(box.git(dir, ["rev-parse", "--abbrev-ref", "release@{upstream}"])).toBe("origin/release");
    });

    test("a clone with uncommitted changes stays put and prints the command", () => {
        const { box, dir } = setUp();
        box.git(dir, ["branch", "develop"]);
        writeFileSync(join(dir, "README"), "edited\n");
        const output = box.ok(["project", "set", "app", "--branch", "develop"]);
        expect(output).toContain("projects/app is still on main: it has uncommitted changes");
        expect(output).toContain(`git -C ${dir} switch develop`);
        expect(head(box, dir)).toBe("main");
        expect(readFileSync(join(dir, "README"), "utf8")).toBe("edited\n");
        expect(JSON.parse(box.ok(["project", "list", "--json"]))[0].branch).toBe("develop");
    });

    test("a branch that exists neither locally nor on origin is not created", () => {
        const { box, dir } = setUp();
        const output = box.ok(["project", "set", "app", "--branch", "nowhere"]);
        expect(output).toContain("projects/app is still on main: branch nowhere exists neither locally nor on origin");
        expect(output).toContain(`git -C ${dir} fetch origin nowhere`);
        expect(output).toContain(`git -C ${dir} switch nowhere`);
        expect(output).toContain(`git -C ${dir} switch -c nowhere`);
        expect(head(box, dir)).toBe("main");
        expect(box.git(dir, ["branch", "--list", "nowhere"])).toBe("");
        expect(JSON.parse(box.ok(["project", "list", "--json"]))[0].branch).toBe("nowhere");
    });

    test("a live task holding the clone on its branch keeps it there", () => {
        const { box, dir } = setUp();
        box.ok(["project", "set", "app", "--workspace", "branch-per-task"]);
        box.ok(["task", "add", "app", "Login page"]);
        box.ok(["workspace", "prepare", "T1"]);
        box.ok(["task", "start", "T1"]);
        const output = box.ok(["project", "set", "app", "--branch", "main"]);
        expect(output).toContain("projects/app is still on toli/T1-login-page: T1 (active) is using it");
        expect(output).toContain(`git -C ${dir} switch main`);
        expect(head(box, dir)).toBe("toli/T1-login-page");
    });

    test("a linked checkout counts as the clone", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        withProject(box, "seed");
        const checkout = join(box.root, ".mine", "shop");
        mkdirSync(join(box.root, ".mine"), { recursive: true });
        box.git(join(box.root, ".mine"), ["clone", join(box.root, ".origin", "seed.git"), checkout]);
        box.git(checkout, ["branch", "develop"]);
        box.ok(["project", "link", "shop", checkout]);
        expect(box.ok(["project", "set", "shop", "--branch", "develop"])).toContain(
            "projects/shop: switched from main to develop",
        );
        expect(head(box, realpathSync(checkout))).toBe("develop");
    });
});
