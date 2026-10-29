import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, withProject } from "./helpers.ts";

describe("fixed working branch", () => {
    test("commit refuses on a mismatch and succeeds when matching or unset", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const dir = withProject(box, "app");
        expect(box.ok(["project", "set", "app", "--branch", "develop"])).toBe("app: mode=commit branch=develop");
        writeFileSync(join(dir, "a.txt"), "a\n");
        const head = box.git(dir, ["rev-parse", "HEAD"]);
        const refused = box.mate(["commit", "app", "-m", "add a", "--", "a.txt"]);
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
        expect(box.mate(["project", "set", "app", "--branch", "bad..name"]).code).toBe(1);
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
            { ...legacy, branch: null, path: join(box.root, "projects", "old"), cloned: false },
        ]);
        box.ok(["project", "set", "old", "--branch", "main", "--forge", "gitlab", "--forge-host", "Git.Example.com"]);
        expect(JSON.parse(readFileSync(file, "utf8")).projects).toEqual([
            { ...legacy, branch: "main", forge: "gitlab", forgeHost: "git.example.com" },
        ]);
    });
});
