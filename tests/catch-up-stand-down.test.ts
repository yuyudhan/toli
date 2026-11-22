import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitFile, machine, release, runRecord, runs } from "./catch-up-fixture.ts";

// T2276: a catch-up stands down while live work it cannot see as a `bin/toli spawn` run is in the project (a native
// subagent on an active task, uncommitted changes, commits not on origin that are not its own), or while an open task
// already plans the merge; it retries on a later scan. A merge whose checks failed is undone, and nothing else.
describe("catch-up stands down for live work", () => {
    test("a live native subagent on an active task of the project holds it; that task's own catch-up goes on", () => {
        const { box, clone, origin } = machine();
        box.ok(["task", "add", "alpha", "Fix the parser"]);
        box.ok(["task", "start", "T1", "--agent", "ParserFix"]);
        release(box, origin, "v1.0.0");
        expect(box.ok(["catch-up", "scan"])).toContain(
            "nightly: held (T1's jawan ParserFix works on alpha), tried again next scan",
        );
        expect(runs(box)).toEqual([]);
        const head = box.git(clone, ["rev-parse", "HEAD"]);
        expect(box.ok(["catch-up", "merge", "alpha", "--tag", "v1.0.0"])).toContain(
            "nightly: held (T1's jawan ParserFix works on alpha), tried again next scan",
        );
        expect(box.git(clone, ["rev-parse", "HEAD"])).toBe(head);

        expect(box.ok(["catch-up", "merge", "alpha", "--tag", "v1.0.0", "--task", "T1"])).toMatch(
            /^nightly \(.*projects\/alpha\): merged v1\.0\.0 as [0-9a-f]{12}$/m,
        );
    });

    test("a queued run holds no checkout: it works nowhere yet", () => {
        const { box, clone, origin } = machine();
        runRecord(box, "j-20261120-080100-bbbb", { cwd: clone, project: "alpha", status: "queued" });
        release(box, origin, "v1.0.0");
        expect(box.ok(["catch-up", "scan"])).toContain("for nightly");
    });

    test("uncommitted changes or someone else's commits not on origin hold it until they are pushed", () => {
        const { box, clone, origin } = machine();
        box.git(clone, ["push", "--quiet", "origin", "nightly"]);
        writeFileSync(join(clone, "work.txt"), "half done\n");
        release(box, origin, "v1.0.0");
        expect(box.ok(["catch-up", "scan"])).toContain(
            "nightly: held (uncommitted changes in projects/alpha), tried again next scan",
        );
        expect(runs(box)).toEqual([]);

        box.git(clone, ["commit", "--quiet", "-am", "wip"]);
        const head = box.git(clone, ["rev-parse", "HEAD"]);
        const unpushed = "nightly: held (1 commit on nightly not on origin/nightly), tried again next scan";
        expect(box.ok(["catch-up", "scan"])).toContain(unpushed);
        expect(runs(box)).toEqual([]);
        expect(box.ok(["catch-up", "merge", "alpha", "--tag", "v1.0.0"])).toContain(unpushed);
        expect(box.git(clone, ["rev-parse", "HEAD"])).toBe(head);

        box.git(clone, ["push", "--quiet", "origin", "nightly"]);
        expect(box.ok(["catch-up", "scan"])).toContain("for nightly");
    });

    test("an open task that already plans the merge holds it: by its title, its brief or a catch-up note", () => {
        const { box, clone, origin } = machine();
        release(box, origin, "v1.0.0");
        box.ok(["task", "add", "alpha", "Merge v1.0.0 into nightly"]);
        expect(box.ok(["catch-up", "scan"])).toContain(
            "nightly: held (T1 already plans merging v1.0.0), tried again next scan",
        );
        expect(runs(box)).toEqual([]);
        const head = box.git(clone, ["rev-parse", "HEAD"]);
        expect(box.ok(["catch-up", "merge", "alpha", "--tag", "v1.0.0"])).toContain(
            "nightly: held (T1 already plans merging v1.0.0)",
        );
        expect(box.git(clone, ["rev-parse", "HEAD"])).toBe(head);

        // Another release's tag that merely starts the same way names a different merge.
        box.ok(["task", "drop", "T1"]);
        box.ok(["task", "add", "alpha", "Prepare v1.0.01 notes"]);
        box.ok(["task", "add", "alpha", "Release prep"]);
        const briefs = join(box.root, "data", "projects", "alpha", "briefs");
        mkdirSync(briefs, { recursive: true });
        writeFileSync(join(briefs, "T3.md"), "TOLI_BRIEF v1\n\nMerge v1.0.0 into nightly, then run the checks.\n");
        expect(box.ok(["catch-up", "scan"])).toContain(
            "nightly: held (T3 already plans merging v1.0.0), tried again next scan",
        );
        box.ok(["task", "drop", "T3"]);
        expect(box.ok(["catch-up", "scan"])).toContain("for nightly");
    });

    // T2313: a task held for the user's word on its merge still plans it; the catch-up made the same merge meanwhile.
    test("a held task that plans the merge holds it while it waits on the user", () => {
        const { box, clone, origin } = machine();
        release(box, origin, "v1.0.0");
        box.ok(["task", "add", "alpha", "Merge v1.0.0 into nightly"]);
        box.ok(["task", "hold", "T1", "--question", "Merge it?", "--option", "yes => merge", "--option", "no => wait"]);
        expect(box.ok(["catch-up", "scan"])).toContain(
            "nightly: held (T1 already plans merging v1.0.0), tried again next scan",
        );
        expect(runs(box)).toEqual([]);
        const head = box.git(clone, ["rev-parse", "HEAD"]);
        expect(box.ok(["catch-up", "merge", "alpha", "--tag", "v1.0.0"])).toContain(
            "nightly: held (T1 already plans merging v1.0.0)",
        );
        expect(box.git(clone, ["rev-parse", "HEAD"])).toBe(head);
    });

    test("a catch-up note on an open task plans the merge of its own tag only", () => {
        const { box, origin } = machine();
        release(box, origin, "v1.0.0");
        box.ok(["task", "add", "alpha", "Parser work", "--note", "catch-up v0.9.0: merging it into nightly conflicts"]);
        expect(box.ok(["catch-up", "scan"])).toContain("for nightly");
        expect(runs(box)).toHaveLength(1);

        const other = machine();
        release(other.box, other.origin, "v1.0.0");
        other.box.ok([
            "task",
            "add",
            "alpha",
            "Parser work",
            "--note",
            "catch-up v1.0.0: merging it into nightly conflicts",
        ]);
        expect(other.box.ok(["catch-up", "scan"])).toContain(
            "nightly: held (T1 already plans merging v1.0.0), tried again next scan",
        );
        expect(runs(other.box)).toEqual([]);
    });

    test("undo refuses while the checkout has uncommitted changes, even to a file the merge left alone", () => {
        const { box, clone, origin } = machine();
        release(box, origin, "v1.0.0");
        box.ok(["catch-up", "scan"]);
        const self = { env: { TOLI_RUN_ID: runs(box)[0]?.id ?? "" } };
        box.ok(["catch-up", "merge", "alpha", "--tag", "v1.0.0"], self);
        const merged = box.git(clone, ["rev-parse", "HEAD"]);
        writeFileSync(join(clone, "work.txt"), "someone's edit\n");
        const refused = box.toli(["catch-up", "undo", "alpha", "--branch", "nightly", "--merge", merged], self);
        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain("refusing: uncommitted changes in projects/alpha; nothing undone");
        expect(box.git(clone, ["rev-parse", "HEAD"])).toBe(merged);
        expect(readFileSync(join(clone, "work.txt"), "utf8")).toBe("someone's edit\n");
    });

    test("a merge whose checks failed is undone, and only that merge, leaving the checkout as found", () => {
        const { box, clone, origin } = machine();
        const before = box.git(clone, ["rev-parse", "HEAD"]);
        release(box, origin, "v1.0.0");
        box.ok(["catch-up", "scan"]);
        const self = { env: { TOLI_RUN_ID: runs(box)[0]?.id ?? "" } };
        const brief = readFileSync(join(box.root, "data", "projects", "alpha", "briefs", "catch-up-v1.0.0.md"), "utf8");
        expect(brief).toContain("its `undo` line");
        const text = box.ok(["catch-up", "merge", "alpha", "--tag", "v1.0.0"], self);
        const merged = box.git(clone, ["rev-parse", "HEAD"]);
        expect(text).toContain(
            `  if the checks fail: bin/toli catch-up undo alpha --branch nightly --merge ${merged.slice(0, 12)}`,
        );

        // A commit the catch-up did not make is never undone.
        const foreign = box.toli(["catch-up", "undo", "alpha", "--branch", "nightly", "--merge", before], self);
        expect(foreign.code).not.toBe(0);
        expect(foreign.stderr).toContain(`${before.slice(0, 12)} is not a merge this machine's catch-up made`);
        expect(box.git(clone, ["rev-parse", "HEAD"])).toBe(merged);

        const undone = box.ok(
            ["catch-up", "undo", "alpha", "--branch", "nightly", "--merge", merged.slice(0, 12)],
            self,
        );
        expect(undone).toContain(
            `nightly: undid the catch-up merge ${merged.slice(0, 12)}; back at ${before.slice(0, 12)}, as the merge found it`,
        );
        expect(box.git(clone, ["rev-parse", "HEAD"])).toBe(before);
        expect(box.git(clone, ["status", "--porcelain"])).toBe("");

        // A merge with work on top of it is left alone.
        box.ok(["catch-up", "merge", "alpha", "--tag", "v1.0.0"], self);
        const again = box.git(clone, ["rev-parse", "HEAD"]);
        const later = commitFile(box, clone, "later.txt", "later\n");
        const onTop = box.toli(["catch-up", "undo", "alpha", "--branch", "nightly", "--merge", again], self);
        expect(onTop.code).not.toBe(0);
        expect(onTop.stderr).toContain(`nightly has moved past the catch-up merge ${again.slice(0, 12)}`);
        expect(box.git(clone, ["rev-parse", "HEAD"])).toBe(later);
    });
});
