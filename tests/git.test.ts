import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripAiTrailers } from "../src/projects/commit.ts";
import { sandbox, withProject } from "./helpers.ts";

describe("toli commit", () => {
    test("strips AI trailers but keeps human sign-offs", () => {
        const message = [
            "Fix parser",
            "",
            "Body line about AI support.",
            "",
            "Signed-off-by: Dev Person <dev@gmail.com>",
            "Co-authored-by: Claude <noreply@anthropic.com>",
            "co-authored-by: Someone <a@b.c>",
            "Generated-by: omp",
            "Signed-off-by: Oh My Pi <bot@example.com>",
            "",
        ].join("\n");
        expect(stripAiTrailers(message)).toBe(
            "Fix parser\n\nBody line about AI support.\n\nSigned-off-by: Dev Person <dev@gmail.com>",
        );
    });

    test("commits only the given paths, without trailers, and never pushes", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const dir = withProject(box, "app");
        writeFileSync(join(dir, "a.txt"), "a\n");
        writeFileSync(join(dir, "b.txt"), "b\n");
        writeFileSync(join(dir, "c.txt"), "c\n");
        box.git(dir, ["add", "c.txt"]);
        expect(box.toli(["commit", "app", "-m", "no paths"]).code).toBe(1);
        const sha = box.ok(["commit", "app", "-m", "Add a\n\nCo-Authored-By: Claude <x@y>", "--", "a.txt"]);
        expect(box.git(dir, ["rev-parse", "HEAD"])).toBe(sha);
        expect(box.git(dir, ["show", "--name-only", "--format=", "HEAD"])).toBe("a.txt");
        expect(box.git(dir, ["log", "-1", "--format=%B"])).toBe("Add a");
        expect(box.git(dir, ["status", "--porcelain"])).toBe("A  c.txt\n?? b.txt");
        expect(box.git(dir, ["rev-list", "--count", "origin/main..main"])).toBe("1");
    });

    test("repeated --patch flags all apply, in order, in one commit; a conflicting one commits nothing", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const dir = withProject(box, "app");
        const newFile = (name: string, line: string) =>
            `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+${line}\n`;
        const patchA = join(box.root, "a.patch");
        const patchB = join(box.root, "b.patch");
        writeFileSync(patchA, newFile("a.txt", "a"));
        writeFileSync(patchB, newFile("b.txt", "b"));
        const sha = box.ok(["commit", "app", "-m", "Add a and b", "--patch", patchA, "--patch", patchB]);
        expect(box.git(dir, ["show", "--name-only", "--format=", sha])).toBe("a.txt\nb.txt");

        const before = box.git(dir, ["rev-parse", "HEAD"]);
        const patchC = join(box.root, "c.patch");
        const clash = join(box.root, "clash.patch");
        writeFileSync(patchC, newFile("c.txt", "c"));
        writeFileSync(clash, newFile("c.txt", "other c"));
        const refused = box.toli(["commit", "app", "-m", "Clash", "--patch", patchC, "--patch", clash]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain(`--patch ${clash} does not apply`);
        expect(box.git(dir, ["rev-parse", "HEAD"])).toBe(before);
    });

    test("repeated -m flags become paragraphs, like git", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const dir = withProject(box, "app");
        writeFileSync(join(dir, "a.txt"), "a\n");
        box.ok([
            "commit",
            "app",
            "-m",
            "Add a",
            "-m",
            "Why: b.",
            "--message",
            "Co-Authored-By: Claude <x@y>",
            "--",
            "a.txt",
        ]);
        expect(box.git(dir, ["log", "-1", "--format=%B"])).toBe("Add a\n\nWhy: b.");
    });

    test("--merge <ref> commits a clean merge with two parents and updates the merged files", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const dir = withProject(box, "app");
        const base = box.git(dir, ["rev-parse", "HEAD"]);
        box.git(dir, ["switch", "--quiet", "-c", "feature"]);
        writeFileSync(join(dir, "f.txt"), "feature\n");
        box.ok(["commit", "app", "-m", "add f", "--", "f.txt"]);
        const feature = box.git(dir, ["rev-parse", "HEAD"]);
        box.git(dir, ["switch", "--quiet", "main"]);
        writeFileSync(join(dir, "m.txt"), "main\n");
        box.ok(["commit", "app", "-m", "add m", "--", "m.txt"]);
        const tip = box.git(dir, ["rev-parse", "HEAD"]);

        const sha = box.ok(["commit", "app", "--merge", "feature", "-m", "Merge feature"]);
        expect(box.git(dir, ["rev-parse", "HEAD"])).toBe(sha);
        expect(box.git(dir, ["log", "-1", "--format=%P"])).toBe(`${tip} ${feature}`);
        expect(box.git(dir, ["show", `${sha}:f.txt`])).toBe("feature");
        expect(box.git(dir, ["status", "--porcelain"])).toBe("");
        expect(box.toli(["commit", "app", "--merge", "feature", "-m", "again"]).stderr).toContain("already merged");

        // A conflicting merge and a merge over local edits of merged files are refusals that change nothing.
        box.git(dir, ["switch", "--quiet", "-c", "clash", base]);
        writeFileSync(join(dir, "m.txt"), "clash\n");
        box.ok(["commit", "app", "-m", "clash m", "--", "m.txt"]);
        box.git(dir, ["switch", "--quiet", "-c", "more", base]);
        writeFileSync(join(dir, "g.txt"), "more\n");
        box.ok(["commit", "app", "-m", "add g", "--", "g.txt"]);
        box.git(dir, ["switch", "--quiet", "main"]);
        const conflict = box.toli(["commit", "app", "--merge", "clash", "-m", "Merge clash"]);
        expect(conflict.code).toBe(1);
        expect(conflict.stderr).toContain("conflicts in m.txt");
        writeFileSync(join(dir, "g.txt"), "untracked here\n");
        const dirty = box.toli(["commit", "app", "--merge", "more", "-m", "Merge more"]);
        expect(dirty.code).toBe(1);
        expect(dirty.stderr).toContain("local changes to files the merge changes: g.txt");
        expect(box.git(dir, ["rev-parse", "HEAD"])).toBe(sha);

        // A modified tracked file is named whole (git status prints it as " M m.txt").
        box.git(dir, ["switch", "--quiet", "-c", "edit", sha]);
        writeFileSync(join(dir, "m.txt"), "edit\n");
        box.ok(["commit", "app", "-m", "edit m", "--", "m.txt"]);
        box.git(dir, ["switch", "--quiet", "main"]);
        writeFileSync(join(dir, "m.txt"), "local\n");
        const modified = box.toli(["commit", "app", "--merge", "edit", "-m", "Merge edit"]);
        expect(modified.code).toBe(1);
        expect(modified.stderr).toContain("local changes to files the merge changes: m.txt;");
    });
});

describe("toli project drop", () => {
    test("refuses dirty clones and unpushed commits; deletes only when clean", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const dir = withProject(box, "app");
        writeFileSync(join(dir, "a.txt"), "a\n");
        const dirty = box.toli(["project", "drop", "app"]);
        expect(dirty.code).toBe(1);
        expect(dirty.stderr).toContain("uncommitted");

        box.ok(["commit", "app", "-m", "add a", "--", "a.txt"]);
        const ahead = box.toli(["project", "drop", "app"]);
        expect(ahead.code).toBe(1);
        expect(ahead.stderr).toContain("unpushed commits on main");

        box.git(dir, ["push", "origin", "main"]);
        box.git(dir, ["switch", "-c", "local-only"]);
        writeFileSync(join(dir, "b.txt"), "b\n");
        box.ok(["commit", "app", "-m", "add b", "--", "b.txt"]);
        const noUpstream = box.toli(["project", "drop", "app"]);
        expect(noUpstream.code).toBe(1);
        expect(noUpstream.stderr).toContain("local-only");

        box.git(dir, ["switch", "main"]);
        box.git(dir, ["branch", "-D", "local-only"]);
        box.ok(["project", "drop", "app", "--delete-clone"]);
        expect(existsSync(dir)).toBe(false);
        expect(JSON.parse(box.ok(["project", "list", "--json"]))).toEqual([]);
    });
});

describe("backlog", () => {
    test("task ids keep increasing after a drop", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        withProject(box, "app");
        expect(box.ok(["task", "add", "app", "one"])).toBe("T1");
        expect(box.ok(["task", "add", "app", "two"])).toBe("T2");
        box.ok(["task", "drop", "T2"]);
        expect(box.ok(["task", "add", "app", "three"])).toBe("T3");
    });
});
