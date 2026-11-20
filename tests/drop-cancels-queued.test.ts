// T2127: tasks dropped as duplicates still had their queued `bin/toli spawn` runs start hours later (one commented on
// a ticket). A queued run of a done or dropped task never starts: closing the task cancels it at once, and the queue
// drain reads the task again before a start, for closures made elsewhere or in a race. Started runs are left alone.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, sandbox, withProject } from "./helpers.ts";

type Run = {
    id: string;
    status: string;
    task: string | null;
    inbox: string | null;
    error: string | null;
    runDir: string;
};

const ENV = { TOLI_PLATFORM: "darwin" };

/** One jawan slot, project x with tasks T1-T3, and an omp stand-in that holds its slot until `release` exists. */
function setup(): { box: Sandbox; release: string; brief: string } {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    const machine = join(box.root, "config", "machine.json");
    writeFileSync(machine, JSON.stringify({ ...JSON.parse(readFileSync(machine, "utf8")), capacity: { maxRuns: 1 } }));
    withProject(box, "x");
    for (const title of ["first", "duplicate", "another duplicate"]) box.ok(["task", "add", "x", title]);
    const release = join(box.root, "release");
    box.stub("omp", `until [ -f "${release}" ]; do sleep 0.1; done; echo finished`);
    const brief = join(box.root, "brief.md");
    writeFileSync(brief, "TOLI_BRIEF v1\nsay hi\n");
    return { box, release, brief };
}

function spawnFor(box: Sandbox, brief: string, task: string): Run {
    const args = ["spawn", "--task", task, "--work", "scout", "--harness", "omp", "--brief", brief, "--json"];
    return JSON.parse(box.ok(args, { env: ENV })) as Run;
}

function status(box: Sandbox, id: string): Run {
    return JSON.parse(box.ok(["run", "status", id, "--json"])) as Run;
}

/** Poll until `done` holds for run `id`, failing after ~30 s: supervisors are detached OS processes. */
async function waitFor(box: Sandbox, id: string, done: (run: Run) => boolean): Promise<Run> {
    for (let attempt = 0; attempt < 300; attempt++) {
        const run = status(box, id);
        if (done(run)) return run;
        await Bun.sleep(100);
    }
    throw new Error(`run ${id} never reached the expected state: ${box.ok(["runs"])}`);
}

describe("a closed task's queued runs never start", () => {
    test("task drop and task done cancel the task's queued runs and say so; a started run is left alone", async () => {
        const { box, release, brief } = setup();
        const first = spawnFor(box, brief, "T1");
        expect(["starting", "running"]).toContain(first.status);
        const dropped = spawnFor(box, brief, "T2");
        const finished = spawnFor(box, brief, "T3");
        expect([dropped.status, finished.status]).toEqual(["queued", "queued"]);

        expect(box.ok(["task", "drop", "T2"])).toContain(`T2: cancelled queued run ${dropped.id}; it never started`);
        expect(box.ok(["task", "done", "T3"])).toContain(`T3: cancelled queued run ${finished.id}; it never started`);
        // The started run's task closing never signals it.
        expect(box.ok(["task", "drop", "T1"])).not.toContain("cancelled");
        expect(["starting", "running"]).toContain(status(box, first.id).status);

        writeFileSync(release, "");
        expect((await waitFor(box, first.id, (run) => run.inbox !== null)).status).toBe("done");
        expect(status(box, dropped.id)).toMatchObject({
            status: "killed",
            inbox: null,
            error: "cancelled while queued: T2 is dropped; it never started",
        });
        expect(status(box, finished.id)).toMatchObject({
            status: "killed",
            inbox: null,
            error: "cancelled while queued: T3 is done; it never started",
        });
    }, 60_000);

    test("the queue drain cancels a run whose task was closed elsewhere, and logs it", async () => {
        const { box, release, brief } = setup();
        const first = spawnFor(box, brief, "T1");
        const done = spawnFor(box, brief, "T2");
        const dropped = spawnFor(box, brief, "T3");
        // Closed by another process (a handback, an older toli, a race with the drop): the queue is not told.
        const file = join(box.root, "data", "backlog.json");
        const backlog = JSON.parse(readFileSync(file, "utf8")) as { tasks: { id: string; status: string }[] };
        for (const task of backlog.tasks) {
            if (task.id === "T2") task.status = "done";
            if (task.id === "T3") task.status = "dropped";
        }
        writeFileSync(file, JSON.stringify(backlog));
        expect([status(box, done.id).status, status(box, dropped.id).status]).toEqual(["queued", "queued"]);

        writeFileSync(release, "");
        const ended = await waitFor(box, first.id, (run) => run.inbox !== null);
        // The finishing run's supervisor drains the queue after posting its outcome.
        const cancelled = await waitFor(box, dropped.id, (run) => run.status !== "queued");
        expect(cancelled).toMatchObject({
            status: "killed",
            inbox: null,
            error: "cancelled while queued: T3 is dropped; it never started",
        });
        expect(status(box, done.id)).toMatchObject({
            status: "killed",
            inbox: null,
            error: "cancelled while queued: T2 is done; it never started",
        });
        const log = readFileSync(join(ended.runDir, "supervisor.log"), "utf8");
        expect(log).toContain(`jawan ${done.id}: not started from the queue, cancelled while queued: T2 is done`);
        expect(log).toContain(`jawan ${dropped.id}: not started from the queue, cancelled while queued: T3 is dropped`);
    }, 60_000);
});
