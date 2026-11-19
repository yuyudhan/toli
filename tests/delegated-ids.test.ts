// A delegated brief names the delegator's task ids; on the receiving machine the same ids are other, unrelated tasks.
// The receiver rewrites them (src/fleet/delegation-receive.ts), a spawned jawan changes only its own task
// (TOLI_TASK, src/records/backlog.ts), and a report path never names another task's report.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brief, pair, tasks } from "./delegate-fixture.ts";
import { TOLI_BIN, withProject } from "./helpers.ts";
import { coordinator, spawnJson, waitFor } from "./jawan-fixture.ts";

// One test waits on a detached run (up to 10 s per waitFor): see tests/spawn.test.ts.
setDefaultTimeout(30_000);

/** A native subagent (omp task, Claude Code Agent) runs with the lead's environment: no jawan markers. */
const NATIVE = { TOLI_ROLE: "", TOLI_TASK: "" };

describe("a delegated brief's task ids", () => {
    test("name the receiver's own task, so a native subagent closes it and not the local task with the same id", () => {
        const { m1, m2 } = pair();
        withProject(m1, "app");
        withProject(m2, "app");
        m1.ok(["task", "add", "app", "earlier work"]);
        m1.ok(["task", "add", "app", "parent work"]);
        m2.ok(["task", "add", "app", "local one"]);
        m2.ok(["task", "add", "app", "local two"]);
        m2.ok(["task", "done", "T2", "--report", "data/projects/toli/reports/T2.md"], { env: NATIVE });
        const text = [
            "TOLI_BRIEF v1",
            "# fix it",
            "T1 failed earlier; see m1/T1 and T21x.",
            "Write your report to data/projects/toli/reports/T2.md, then run",
            "`bin/toli task done T2 --report data/projects/toli/reports/T2.md`.",
            "",
        ].join("\n");
        expect(m1.ok(["delegate", "m2", "fix it", "--brief", brief(m1, text), "--for", "T2"])).toContain(
            "delegated to m2/T3",
        );

        const saved = readFileSync(join(m2.root, "data", "projects", "toli", "briefs", "T3.md"), "utf8");
        expect(saved).toContain("m1/T1 failed earlier; see m1/T1 and T21x.");
        expect(saved).toContain("`bin/toli task done T3 --report data/projects/toli/reports/T3.md`");
        expect(saved).not.toMatch(/(?<!m1\/)\bT[12]\b/);
        const received = tasks(m2).find((task) => task.id === "T3");
        expect(received?.notes).toContain("brief ids from m1 rewritten: T2 -> T3 (this task), T1 -> m1/T1");

        // The jawan runs the brief's command as written.
        const command = /`bin\/toli (task done [^`]+)`/.exec(saved)?.[1]?.split(" ") ?? [];
        m2.ok(command, { env: NATIVE });
        const after = tasks(m2);
        expect(after.find((task) => task.id === "T3")).toMatchObject({
            status: "done",
            report: "data/projects/toli/reports/T3.md",
        });
        expect(after.find((task) => task.id === "T2")).toMatchObject({
            status: "done",
            report: "data/projects/toli/reports/T2.md",
        });
        expect(after.find((task) => task.id === "T1")?.status).toBe("queued");
    });

    test("a report path naming another task's report is refused", () => {
        const { m2 } = pair();
        withProject(m2, "app");
        m2.ok(["task", "add", "app", "local one"]);
        m2.ok(["task", "add", "app", "local two"]);
        const refused = m2.toli(["task", "done", "T2", "--report", "data/projects/app/reports/T1.md"], { env: NATIVE });
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain(
            "data/projects/app/reports/T1.md is T1's report: T2's goes in data/projects/app/reports/T2.md",
        );
        expect(tasks(m2).map((task) => task.status)).toEqual(["queued", "queued"]);
    });

    test("in prose are rewritten, while an inlined format-patch stays byte-identical, so it still applies", () => {
        const { m1, m2 } = pair();
        withProject(m1, "app");
        withProject(m2, "app");
        m1.ok(["task", "add", "app", "earlier work"]);
        m1.ok(["task", "add", "app", "parent work"]);
        m2.ok(["task", "add", "app", "local one"]);
        m2.ok(["task", "add", "app", "local two"]);
        const patch = [
            "From 0123456789abcdef0123456789abcdef01234567 Mon Sep 17 00:00:00 2001",
            "From: Jawan <jawan@example.com>",
            "Date: Tue, 17 Nov 2026 10:00:00 +0000",
            "Subject: [PATCH] fix: keep m9/T548 retries (T1474)",
            "",
            "Follows m9/T470 and T1.",
            "---",
            " src/a.ts | 3 ++-",
            " 1 file changed, 2 insertions(+), 1 deletion(-)",
            "",
            "diff --git a/src/a.ts b/src/a.ts",
            "index 1111111..2222222 100644",
            "--- a/src/a.ts",
            "+++ b/src/a.ts",
            "@@ -1,3 +1,4 @@",
            " // m9/T548: retry once",
            "-const tries = 1; // T1474",
            "+// m9/T470: twice",
            "+const tries = 2; // T1474",
            " ",
            "-- ",
            "2.47.0",
            "",
        ].join("\n");
        const text = [
            "TOLI_BRIEF v1",
            "# apply it",
            "T1 failed earlier; m9/T100 has the details. Apply this patch with `git am`:",
            "",
            patch,
            "- then run `bin/toli task done T2 --report data/projects/toli/reports/T2.md`.",
            "",
        ].join("\n");
        m1.ok(["delegate", "m2", "apply it", "--brief", brief(m1, text), "--for", "T2"]);

        const saved = readFileSync(join(m2.root, "data", "projects", "toli", "briefs", "T3.md"), "utf8");
        const start = saved.indexOf("From 0123456789abcdef");
        expect(start).toBeGreaterThan(0);
        const received = saved.slice(start, start + patch.length);
        expect(createHash("sha256").update(received).digest("hex")).toBe(
            createHash("sha256").update(patch).digest("hex"),
        );
        expect(saved).toContain("m1/T1 failed earlier; m9/m1/T100 has the details.");
        expect(saved).toContain("- then run `bin/toli task done T3 --report data/projects/toli/reports/T3.md`.");
    });

    test("inside a plain diff or a PATCH section stay as written, and prose right after a diff is rewritten", () => {
        const { m1, m2 } = pair();
        withProject(m1, "app");
        withProject(m2, "app");
        m1.ok(["task", "add", "app", "earlier work"]);
        m1.ok(["task", "add", "app", "parent work"]);
        m2.ok(["task", "add", "app", "local one"]);
        m2.ok(["task", "add", "app", "local two"]);
        const diff = [
            "diff --git a/docs/b.md b/docs/b.md",
            "--- a/docs/b.md",
            "+++ b/docs/b.md",
            "@@ -1 +1 @@",
            "-See T1.",
            "+See m9/T548.",
        ].join("\n");
        const section = ["## PATCH (begin)", "T1 and m9/T470, as sent.", "## PATCH (end)"].join("\n");
        const text = [
            "TOLI_BRIEF v1",
            "# apply it",
            diff,
            "- T1 is where this came from.",
            "",
            section,
            "Report with `bin/toli task done T2 --report data/projects/toli/reports/T2.md`.",
            "",
        ].join("\n");
        m1.ok(["delegate", "m2", "apply it", "--brief", brief(m1, text), "--for", "T2"]);

        const saved = readFileSync(join(m2.root, "data", "projects", "toli", "briefs", "T3.md"), "utf8");
        expect(saved).toContain(`${diff}\n- m1/T1 is where this came from.\n`);
        expect(saved).toContain(`\n${section}\n`);
        expect(saved).toContain("`bin/toli task done T3 --report data/projects/toli/reports/T3.md`");
    });
});

describe("a spawned jawan", () => {
    test("changes only the task it runs for: done, hold and drop of another id are refused", () => {
        const box = coordinator();
        withProject(box, "app");
        box.ok(["task", "add", "app", "local one"]);
        box.ok(["task", "add", "app", "its own"]);
        const jawan = { TOLI_ROLE: "jawan", TOLI_TASK: "T2" };
        for (const args of [
            ["task", "done", "T1"],
            ["task", "hold", "t1", "--question", "which?", "--option", "a => x", "--option", "b => y"],
            ["task", "drop", "T1"],
        ]) {
            const refused = box.toli(args, { env: jawan });
            expect(refused.code).toBe(1);
            expect(refused.stderr).toContain("this jawan runs for T2: only the lead changes T1");
        }
        expect(tasks(box)[0]?.status).toBe("queued");
        box.ok(["task", "done", "T2"], { env: jawan });
        expect(tasks(box)[1]?.status).toBe("done");
        // The lead (and a native subagent, which has the lead's environment) still changes any task.
        box.ok(["task", "drop", "T1"], { env: NATIVE });
        expect(tasks(box)[0]?.status).toBe("dropped");
    });

    test("gets its task in TOLI_TASK, so a brief's foreign id cannot close a local task", async () => {
        const box = coordinator();
        withProject(box, "app");
        box.ok(["task", "add", "app", "local one"]);
        box.ok(["task", "add", "app", "its own", "--shape", "scout"]);
        const toli = `"${process.execPath}" "${TOLI_BIN}"`;
        box.stub("omp", `echo "task=$TOLI_TASK"; ${toli} task done T1; ${toli} task done T2 --note landed`);
        const started = spawnJson(box, ["--harness", "omp", "--task", "T2", "--brief", brief(box, "TOLI_BRIEF v1\n")]);
        const done = await waitFor(box, started.id, (run) => run.inbox !== null);
        const log = readFileSync(done.logPath, "utf8");
        expect(log).toContain("task=T2");
        expect(log).toContain("this jawan runs for T2: only the lead changes T1");
        expect(tasks(box).map((task) => task.status)).toEqual(["queued", "done"]);
    });
});
