import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, withProject } from "./helpers.ts";
import { brief, coordinator, spawnJson, waitFor } from "./jawan-fixture.ts";

setDefaultTimeout(30_000);

/** A coordinator sandbox with project `alpha` and a task-end hook that appends "<root-ok> <id> <status> <project>". */
function withHook(body = ""): Sandbox {
    const box = coordinator();
    withProject(box, "alpha");
    const file = join(box.root, "local", "hooks", "task-end");
    mkdirSync(join(box.root, "local", "hooks"), { recursive: true });
    writeFileSync(file, `#!/bin/sh\n[ "$1" = "${box.root}" ] && echo "$2 $3 $4" >> "$1/task-end.log"\n${body}\n`);
    chmodSync(file, 0o755);
    return box;
}

function calls(box: Sandbox): string[] {
    const log = join(box.root, "task-end.log");
    return existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : [];
}

describe("task-end hook", () => {
    test("runs when a task is done or dropped, with its id, status and project", () => {
        const box = withHook();
        box.ok(["task", "add", "alpha", "one"]);
        box.ok(["task", "add", "alpha", "two"]);
        box.ok(["task", "done", "T1", "--commit", "abc"]);
        box.ok(["task", "drop", "T2"]);
        expect(calls(box)).toEqual(["T1 done alpha", "T2 dropped alpha"]);
    });

    test("does not run for a queued, active or held task, nor when a closed task is closed again", () => {
        const box = withHook();
        for (const title of ["queued", "active", "held", "closed"]) box.ok(["task", "add", "alpha", title]);
        box.ok(["task", "start", "T2"]);
        box.ok(["task", "hold", "T3", "--question", "which?"]);
        expect(calls(box)).toEqual([]);
        box.ok(["task", "done", "T4"]);
        box.ok(["task", "done", "T4", "--note", "again"]);
        box.ok(["task", "drop", "T4"]);
        expect(calls(box)).toEqual(["T4 done alpha"]);
    });

    test("a failing hook is reported but never fails the task command", () => {
        const box = withHook("exit 5");
        box.ok(["task", "add", "alpha", "one"]);
        const result = box.toli(["task", "done", "T1"]);
        expect(result.code).toBe(0);
        expect(result.stderr).toContain("local/hooks/task-end exited 5; continuing");
        expect(box.ok(["task", "list", "--status", "done"])).toContain("T1\tdone");
    });

    test("a run that ends on a task its jawan already closed runs the hook once more", async () => {
        const box = withHook();
        box.ok(["task", "add", "alpha", "one"]);
        const gate = join(box.root, "gate");
        box.stub("omp", `while [ ! -f "${gate}" ]; do sleep 0.1; done; echo report`);
        const started = spawnJson(box, ["--harness", "omp", "--task", "T1", "--brief", brief(box)]);
        await waitFor(box, started.id, (run) => run.status === "running");
        box.ok(["task", "done", "T1"]);
        expect(calls(box)).toEqual(["T1 done alpha"]);
        writeFileSync(gate, "");
        await waitFor(box, started.id, (run) => run.inbox !== null);
        // The hook runs in the detached supervisor just after the inbox post: no in-process signal, poll as waitFor does.
        for (let attempt = 0; attempt < 100 && calls(box).length < 2; attempt++) await Bun.sleep(100);
        expect(calls(box)).toEqual(["T1 done alpha", "T1 done alpha"]);
    });
});
