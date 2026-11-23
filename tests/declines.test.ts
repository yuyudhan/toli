// A machine that takes no work of a project at all (`bin/toli lead decline <p>`, docs/sardars.md "A machine that
// declines a project") is passed over by `pick --project <p>` and by every other lead's balancing offer.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENV, editBacklog, m3Answers, resourcesQueue } from "./fleet-fixture.ts";
import { sandbox } from "./helpers.ts";
import { pass, queued, queuedOn, queueItems, T0, withTasks } from "./queues-fixture.ts";

type Pick = { machine: string | null; rejected: { machine: string; reasons: string[] }[] };

/** m2's snapshot: a clone of x, an empty queue, and its lead declines x. */
const M2_DECLINES_X = queued(0, {
    queue: { queued: 0, active: 0, held: 0, jawansRunning: 0, jawansQueued: 0, depth: 0, declines: ["x"] },
});

describe("lead decline", () => {
    test("lists, adds and clears declined projects in config/machine.json, published with its queue", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        expect(box.ok(["lead", "decline"])).toBe("declines no project: this machine takes work of every project");
        expect(box.ok(["lead", "decline", "app"])).toBe(
            "declines app; pick and the other leads' offers give this machine no work of app",
        );
        box.ok(["lead", "decline", "app"]);
        box.ok(["lead", "decline", "web"]);
        expect(box.ok(["lead", "decline"])).toBe("declines app, web");
        const machine = JSON.parse(readFileSync(join(box.root, "config", "machine.json"), "utf8")) as {
            lead: { declines: string[] };
        };
        expect(machine.lead.declines).toEqual(["app", "web"]);
        expect(resourcesQueue(box).declines).toEqual(["app", "web"]);
        expect(box.ok(["lead", "decline", "app", "--clear"])).toBe("takes work of app again");
        expect(JSON.parse(box.ok(["lead", "decline", "--json"]))).toEqual(["web"]);
        box.ok(["lead", "decline", "web", "--clear"]);
        expect(resourcesQueue(box).declines).toBeUndefined();
        expect(box.toli(["lead", "decline", "--clear"]).stderr).toContain("--clear needs the project");
    });
});

describe("placing work with a machine that declines a project", () => {
    test("an offer for project x skips the machine that declines x and goes to one that takes it", async () => {
        // m2 has the shortest queue and a clone of x but declines it; m3 is a queue of 1 deeper and takes x.
        const box = withTasks(M2_DECLINES_X, 4);
        m3Answers(box, queuedOn("m3", 1));
        editBacklog(box, (tasks) => {
            const t4 = tasks.find((task) => task.id === "T4");
            if (t4 === undefined) throw new Error("no T4");
            t4.shape = "scout";
        });
        expect(await pass(box, T0)).toBe("queue: offered work to m3 (m1 4, m3 1)");
        const [offer, ...more] = queueItems(box);
        expect(more).toEqual([]);
        expect(offer).toStartWith("# queue: offer work to m3\n");
        expect(offer).not.toContain("m2");
        expect(offer).toContain("T1: bin/toli delegate m3 'task 1' --brief <file> --project x");
        expect(offer).toContain("T4: bin/toli delegate m3 'task 4' --brief <file> --project x --shape scout");
    });

    test("no offer goes when the only shorter queue declines every queued task's project", async () => {
        const box = withTasks(M2_DECLINES_X, 4);
        expect(await pass(box, T0)).toBeNull();
        expect(queueItems(box)).toEqual([]);
    });

    test("pick --project x passes over a machine that declines x for any shape; fleet queues shows it", () => {
        const box = withTasks(M2_DECLINES_X, 4);
        m3Answers(box, queuedOn("m3", 1));
        for (const shape of ["ship", "scout"]) {
            const pick = JSON.parse(
                box.ok(["pick", "--project", "x", "--shape", shape, "--json"], { env: ENV }),
            ) as Pick;
            expect(pick.rejected).toContainEqual({ machine: "m2", reasons: ["declines x: it takes no work of x"] });
        }
        expect(box.ok(["pick"], { env: ENV })).toBe("m2");
        expect(box.ok(["fleet", "queues"], { env: ENV })).toContain("m2: queue 0");
        expect(box.ok(["fleet", "queues"], { env: ENV })).toContain(", declines x");
    });
});
