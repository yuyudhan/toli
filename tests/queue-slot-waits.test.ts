// T2265: a task parked with `task wait --on "<a free slot here>"` is queue: it waits only for a jawan slot on this
// machine, so `resources`, `fleet queues`, `pick` and the balancing pass count it. A wait on anything else is not
// queue.
import { describe, expect, test } from "bun:test";
import { ENV, editBacklog, fleet, liveRun, ROOMY, resourcesQueue } from "./fleet-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";
import { pass, queued, queueItems, T0, withTasks } from "./queues-fixture.ts";

/** Park `id` with `task wait --on <on>`. */
function wait(box: Sandbox, id: string, on: string): void {
    box.ok(["task", "wait", id, "--on", on]);
}

describe("waits on a free slot here are queue (T2265)", () => {
    test("slot waits count toward depth; waits on a person, a release, another machine or a held task do not", () => {
        const box = withTasks(queued(0), 9);
        wait(box, "T1", "slot: after T610, then the staging check");
        wait(box, "T2", "next free WEB slot (3/3 busy, 8 pieces queued ahead)");
        wait(box, "T3", "a free slot");
        wait(box, "T4", "the owner's answer on the redesign");
        wait(box, "T5", "the v0.3.48 release");
        wait(box, "T6", "m3 T546 reaching origin/main");
        wait(box, "T7", "a build machine with the clone when a slot frees");
        // A slot wait whose jawan then started works as that run, once; a held one is not queue.
        wait(box, "T8", "slot");
        liveRun(box, "j-1", "T8");
        wait(box, "T9", "next free slot");
        editBacklog(box, (tasks) => {
            const t9 = tasks.find((task) => task.id === "T9");
            if (t9 === undefined) throw new Error("no T9");
            t9.status = "held";
        });

        expect(resourcesQueue(box)).toMatchObject({ queued: 0, slotWaits: 3, jawansRunning: 1, depth: 4 });
        expect(box.ok(["fleet", "queues"], { env: ENV })).toContain(
            "m1 (this machine): queue 4 (0 queued + 3 waiting for a slot, 1 running + 0 waiting; 8 active, 1 held)",
        );
    });

    test("pick sees a machine at cap with slot waits as deeper than one with fewer queued per slot", () => {
        const box = fleet(queued(3), { ...ROOMY, maxRuns: 3 });
        withProject(box, "x");
        for (let n = 1; n <= 5; n++) box.ok(["task", "add", "x", `task ${n}`]);
        for (const n of [1, 2, 3]) box.ok(["task", "start", `T${n}`, "--agent", `T${n}Sub`]);
        wait(box, "T4", "next free x slot (3/3 busy)");
        wait(box, "T5", "slot (3/3 busy)");
        // m1: 3 running + 2 slot waits over 3 slots (1.67) against m2's 3 queued over 2 slots (1.5).
        expect(resourcesQueue(box)).toMatchObject({ jawansRunning: 3, slotWaits: 2, depth: 5 });
        expect(box.ok(["pick"], { env: ENV })).toBe("m2");
    });

    test("the balancing pass counts slot waits and offers them; other waits stay here", async () => {
        const box = withTasks(queued(0), 4);
        wait(box, "T1", "slot");
        wait(box, "T2", "next free x slot");
        wait(box, "T3", "a free slot");
        wait(box, "T4", "the push");
        expect(await pass(box, T0)).toBe("queue: offered work to m2 (m1 3, m2 0)");
        const [offer] = queueItems(box);
        for (const id of ["T1", "T2", "T3"]) expect(offer).toContain(`${id}: bin/toli delegate m2`);
        expect(offer).not.toContain("T4:");
    });

    test("an older toli's queue without slotWaits keeps its own depth", () => {
        const old = { queued: 2, active: 5, held: 0, jawansRunning: 1, jawansQueued: 0, depth: 3 };
        const box = withTasks(queued(0, { queue: old }), 0);
        const json = JSON.parse(box.ok(["fleet", "queues", "--json"], { env: ENV })) as {
            machines: { machine: string; queue: Record<string, unknown> | null }[];
        };
        const m2 = json.machines.find((row) => row.machine === "m2");
        expect(m2?.queue).toEqual(old);
        expect(box.ok(["fleet", "queues"], { env: ENV })).toContain(
            "m2: queue 3 (2 queued, 1 running + 0 waiting; 5 active, 0 held)",
        );
    });
});
