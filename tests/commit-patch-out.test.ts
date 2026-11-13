import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitCommand } from "../src/projects/commit.ts";
import { commandIn, type Sandbox, sandbox, tempDir } from "./helpers.ts";
import { releaseInstall } from "./release-fixture.ts";

/** The sandbox root as a release install: detached at v0.1.0, no `develop` branch. */
function install(): Sandbox {
    const box = sandbox();
    releaseInstall(box, "v0.1.0");
    return box;
}

/** Everything that would show a commit landed: HEAD, every ref, and the object counts. */
const state = (box: Sandbox): string =>
    [
        box.git(box.root, ["rev-parse", "HEAD"]),
        box.git(box.root, ["for-each-ref"]),
        box.git(box.root, ["count-objects", "-v"]),
    ].join("\n");

describe("bin/toli commit toli on a release install", () => {
    test("a plain commit is refused and names --patch-out", () => {
        const box = install();
        const commit = commandIn(box.root, commitCommand);
        writeFileSync(join(box.root, "notes.txt"), "a\n");
        const before = state(box);
        expect(() => commit(["toli", "-m", "Add notes", "--", "notes.txt"])).toThrow("--patch-out");
        expect(state(box)).toBe(before);
    });

    test("--patch-out writes a patch and its sha256 and moves nothing", () => {
        const box = install();
        const commit = commandIn(box.root, commitCommand);
        const changelog = `${readFileSync(join(box.root, "CHANGELOG.md"), "utf8")}\n- Unreleased line\n`;
        writeFileSync(join(box.root, "CHANGELOG.md"), changelog);
        writeFileSync(join(box.root, "notes.txt"), "a\n");
        const before = state(box);
        const file = join(tempDir("patch-out"), "outbox", "T1.patch");

        const output = commit(["toli", "-m", "Add notes", "--patch-out", file, "--", "CHANGELOG.md", "notes.txt"]);

        const patch = readFileSync(file, "utf8");
        const sha256 = createHash("sha256").update(patch).digest("hex");
        expect(readFileSync(`${file}.sha256`, "utf8")).toBe(`${sha256}  T1.patch\n`);
        expect(output).toContain(`sha256: ${sha256}`);
        expect(patch).toContain("Subject: [PATCH] Add notes");
        // Nothing the commit would have written exists in the checkout: no ref moved, no object landed.
        expect(state(box)).toBe(before);
        expect(box.git(box.root, ["status", "--porcelain"])).toBe("M CHANGELOG.md\n?? notes.txt");

        // The patch applies on a clone of the release and reproduces the working-tree files.
        const clone = join(tempDir("patch-out-clone"), "toli");
        box.git(tempDir("patch-out-parent"), ["clone", "--quiet", box.root, clone]);
        box.git(clone, ["am", "--quiet", file]);
        expect(readFileSync(join(clone, "CHANGELOG.md"), "utf8")).toBe(changelog);
        expect(readFileSync(join(clone, "notes.txt"), "utf8")).toBe("a\n");
        expect(box.git(clone, ["log", "-1", "--format=%s"])).toBe("Add notes");
    });

    test("--patch-out refuses a merge, a missing path and an unchanged tree; nothing is written", () => {
        const box = install();
        const commit = commandIn(box.root, commitCommand);
        const dir = tempDir("patch-out-none");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, "x.patch");
        expect(() => commit(["toli", "-m", "m", "--patch-out", file, "--merge", "v0.1.0"])).toThrow(
            "cannot carry a merge",
        );
        expect(() => commit(["toli", "-m", "m", "--patch-out", file])).toThrow("a patch needs paths");
        expect(() => commit(["toli", "-m", "m", "--patch-out", file, "--", "CHANGELOG.md"])).toThrow(
            "nothing to commit",
        );
        expect(existsSync(file)).toBe(false);
    });
});
