// The balancing pass offers work only to a machine that can take it, and posts an unchanged offer once (T2153).
import { describe, expect, test } from "bun:test";
import { m3Answers } from "./fleet-fixture.ts";
import { pass, queued, queuedOn, queueItems, T0, withTasks } from "./queues-fixture.ts";

describe("balancing offers", () => {
    test("never offers a task of a project the target has not cloned, even when its URL is registered here", async () => {
        const box = withTasks(queued(0, { projects: ["other"] }), 4);
        expect(await pass(box, T0)).toBeNull();
        expect(queueItems(box)).toEqual([]);
    });

    test("offers to the next queue within the gap whose machine can take the work when the shortest cannot", async () => {
        const box = withTasks(queued(0, { projects: ["other"] }), 4);
        m3Answers(box, queuedOn("m3", 1, { projects: ["x"] }));
        expect(await pass(box, T0)).toBe("queue: offered work to m3 (m1 4, m3 1)");
        const [offer, ...more] = queueItems(box);
        expect(more).toEqual([]);
        expect(offer).toStartWith("# queue: offer work to m3\n");
        expect(offer).toContain("T1: bin/toli delegate m3 'task 1' --brief <file> --project x");
    });

    test("posts an unchanged offer to the same machine once, and again when its task set changes", async () => {
        const box = withTasks(queued(0), 4);
        expect(await pass(box, T0)).toBe("queue: offered work to m2 (m1 4, m2 0)");
        expect(await pass(box, "2026-11-10T09:30:00.000Z")).toBeNull();
        expect(await pass(box, "2026-11-10T10:00:00.000Z")).toBeNull();
        expect(queueItems(box)).toHaveLength(1);
        box.ok(["task", "pin", "T4"]);
        expect(await pass(box, "2026-11-10T10:30:00.000Z")).toBe("queue: offered work to m2 (m1 4, m2 0)");
        const offers = queueItems(box);
        expect(offers).toHaveLength(2);
        expect(offers.filter((offer) => offer.includes("T4: bin/toli delegate"))).toHaveLength(1);
    });
});
