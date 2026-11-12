import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENV, fleet, liveRun, ROOMY, remoteSnapshot, resourcesQueue } from "./fleet-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";

/** Coordinator m1 with two jawan slots, project x cloned, and `tasks` queued tasks on it; m2's queue is empty. */
function twoSlots(tasks: number): Sandbox {
    const box = fleet(
        remoteSnapshot("m2", { queue: { queued: 0, active: 0, held: 0, jawansRunning: 0, jawansQueued: 0, depth: 0 } }),
        { ...ROOMY, maxRuns: 2 },
    );
    withProject(box, "x");
    for (let n = 1; n <= tasks; n++) box.ok(["task", "add", "x", `task ${n}`]);
    return box;
}

describe("native subagent jawans share capacity.maxRuns with spawn runs", () => {
    test("resources and fleet queues count them with spawn runs and say at cap, queue instead", () => {
        const box = twoSlots(2);
        box.ok(["task", "start", "T1", "--agent", "T11Sub"]);
        expect(box.ok(["resources"], { env: ENV })).toContain("jawans 1/2 (1 native subagent)");
        // A spawn run on T2 plus T1's native subagent: both slots taken.
        liveRun(box, "j-2", "T2");
        box.ok(["task", "start", "T2", "--agent", "j-2"]);
        const atCap = "jawans at cap 2/2 (1 native subagent): queue instead";
        expect(resourcesQueue(box)).toMatchObject({ jawansRunning: 2, subagents: 1 });
        expect(box.ok(["resources"], { env: ENV })).toContain(atCap);
        expect(box.ok(["fleet", "queues"], { env: ENV })).toContain(
            `m1 (this machine): queue 2 (0 queued, 2 running + 0 waiting; 2 active, 0 held), 1 per jawan slot, ${atCap}`,
        );
    });

    test("the digest says at cap, queue instead, and bin/toli spawn queues while they hold every slot", () => {
        const box = twoSlots(2);
        box.ok(["task", "start", "T1", "--agent", "T11Sub"]);
        box.ok(["task", "start", "T2", "--agent", "T12Sub"]);
        expect(box.ok(["digest"], { env: ENV }).split("\n")).toContain(
            "jawans at cap 2/2 (2 native subagents): queue instead",
        );
        const digest = JSON.parse(box.ok(["digest", "--json"], { env: ENV })) as { slots?: unknown };
        expect(digest.slots).toEqual({ jawansRunning: 2, subagents: 2, maxRuns: 2 });
        box.stub("omp", "echo never started");
        const brief = join(box.root, "brief.md");
        writeFileSync(brief, "TOLI_BRIEF v1\nsay hi\n");
        const run = JSON.parse(
            box.ok(["spawn", "--harness", "omp", "--cwd", box.root, "--brief", brief, "--json"], { env: ENV }),
        ) as { id: string; status: string };
        expect(run.status).toBe("queued");
        expect(box.ok(["run", "kill", run.id])).toBe(`killed ${run.id} (omp) before it started`);
    });
});
