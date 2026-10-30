import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripAiTrailers } from "../src/commit.ts";
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
