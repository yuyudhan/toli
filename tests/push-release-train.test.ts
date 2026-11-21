// T2232: a nightly `bin/toli push` in the clone a release train was using ran the project's full pre-push check and
// held the train up for hours. A push refuses a checkout on a `release/*` branch, or one a live jawan holds (the
// catch-up's own check, src/projects/catch-up.ts checkoutHolder); the train itself pushes with `--release-train`.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, sandbox, withProject } from "./helpers.ts";

const TRAIN = "j-20261122-080000-cccc";

/** A live (`running`, supervised by this test process) jawan run record working in `cwd`. */
function liveRun(box: Sandbox, id: string, fields: Record<string, unknown>): void {
    const dir = join(box.root, "state", "jawans");
    const runDir = join(dir, id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "brief.md"), "TOLI_BRIEF v1\n");
    writeFileSync(
        join(dir, `${id}.json`),
        JSON.stringify({
            id,
            harness: "omp",
            task: null,
            project: "alpha",
            work: "release",
            model: null,
            cwd: box.root,
            runDir,
            briefPath: join(runDir, "brief.md"),
            logPath: join(runDir, "output.log"),
            command: "omp",
            maxMinutes: null,
            status: "running",
            supervisorPid: process.pid,
            pid: process.pid,
            exitCode: null,
            signal: null,
            startedAt: "2026-11-22T08:00:00.000Z",
            endedAt: null,
            inbox: null,
            error: null,
            ...fields,
        }),
    );
}

/** Machine m1 with project alpha (standing push grant), its clone on `branch` one commit past main. */
function machine(branch: string): { box: Sandbox; clone: string; origin: string } {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    const clone = withProject(box, "alpha");
    box.ok(["project", "set", "alpha", "--standing-push", "yes"]);
    box.git(clone, ["switch", "--quiet", "-c", branch]);
    writeFileSync(join(clone, "work.txt"), "work\n");
    box.git(clone, ["add", "work.txt"]);
    box.git(clone, ["commit", "--quiet", "-m", "work"]);
    return { box, clone, origin: join(box.root, ".origin", "alpha.git") };
}

const onOrigin = (box: Sandbox, origin: string, branch: string): string =>
    box.git(origin, ["branch", "--list", branch]);

describe("push guards for release trains", () => {
    test("a checkout on a release/* branch is refused; the train pushes it with --release-train", () => {
        const { box, origin } = machine("release/v1.0.0");
        const refused = box.toli(["push", "alpha"]);
        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain(
            "refusing to push alpha: projects/alpha is on release/v1.0.0, a release train's branch; " +
                "only the train pushes it (--release-train)",
        );
        expect(onOrigin(box, origin, "release/v1.0.0")).toBe("");

        expect(box.ok(["push", "alpha", "--release-train"])).toContain("push log:");
        expect(onOrigin(box, origin, "release/v1.0.0")).not.toBe("");
    });

    test("a checkout a live jawan run holds is refused until it ends; --release-train pushes meanwhile", () => {
        const { box, clone, origin } = machine("nightly");
        liveRun(box, TRAIN, { cwd: clone });
        const refused = box.toli(["push", "alpha"]);
        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain(
            `refusing to push alpha: projects/alpha is held (jawan run ${TRAIN} works in it); its pre-push check ` +
                "would run beside that work. Push once it ends, or --release-train from the train itself",
        );
        expect(onOrigin(box, origin, "nightly")).toBe("");

        // The train's own run (TOLI_RUN_ID) is never its own holder.
        expect(box.ok(["push", "alpha"], { env: { TOLI_RUN_ID: TRAIN } })).toContain("push log:");

        liveRun(box, TRAIN, { cwd: clone, status: "done" });
        writeFileSync(join(clone, "more.txt"), "more\n");
        box.git(clone, ["add", "more.txt"]);
        box.git(clone, ["commit", "--quiet", "-m", "more"]);
        expect(box.ok(["push", "alpha"])).toContain("push log:");
    });

    test("a live native jawan's task pinned to the clone holds it, except for a push naming that task", () => {
        const { box, clone } = machine("nightly");
        box.ok(["task", "add", "alpha", "Release train"]);
        const backlogFile = join(box.root, "data", "backlog.json");
        const backlog = JSON.parse(readFileSync(backlogFile, "utf8")) as { tasks: Record<string, unknown>[] };
        Object.assign(backlog.tasks[0] ?? {}, {
            status: "active",
            agent: "AlphaTrain",
            agentSession: { agent: "AlphaTrain", pid: process.pid },
            dispatchedAt: new Date().toISOString(),
            workspace: { strategy: "same-branch", path: clone, branch: "nightly", base: "main" },
        });
        writeFileSync(backlogFile, JSON.stringify(backlog));

        const refused = box.toli(["push", "alpha"]);
        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain("projects/alpha is held (T1's jawan AlphaTrain works in it)");
        expect(box.ok(["push", "alpha", "--task", "T1"])).toContain("push log:");
    });
});
