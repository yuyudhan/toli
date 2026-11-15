// A machine verify-only for a project (`project set <p> --role verify-only`, docs/projects.md) takes no ship work for it.
import { describe, expect, test } from "bun:test";
import { brief, pair, type Task, tasks } from "./delegate-fixture.ts";
import { ENV, editBacklog } from "./fleet-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";
import { pass, queued, queueItems, T0, withTasks } from "./queues-fixture.ts";

function parent(box: Sandbox): Task {
    const task = tasks(box).find((entry) => entry.id === "T1");
    if (task === undefined) throw new Error("no T1");
    return task;
}

describe("the receiving machine", () => {
    test("a machine verify-only for the project hands ship work back on arrival; scout work it takes", () => {
        const { m1, m2, down, up } = pair();
        withProject(m1, "app");
        withProject(m2, "app");
        m2.ok(["project", "set", "app", "--role", "verify-only"]);
        m1.ok(["task", "add", "app", "parent work"]);
        // Unreachable when delegated, so only the receiver can tell; the tick delivers it later.
        down();
        const ship = ["delegate", "m2", "the work", "--brief", brief(m1), "--project", "app", "--for", "T1"];
        expect(m1.ok(ship)).toContain("queued: m2 is unreachable");
        up();
        m1.ok(["job", "tick"]);
        const reason = "m2 is verify-only for app: it takes no ship work for it (bin/toli pick --project app)";
        expect(tasks(m2)[0]).toMatchObject({
            status: "dropped",
            notes: expect.arrayContaining([`handed back to m1: ${reason}`]),
        });
        const task = parent(m1);
        expect(task.status).toBe("queued");
        expect(task.agent).toBeUndefined();
        expect(task.notes).toContain(`m2/T1 handed the work back: ${reason}`);

        const scout = ["delegate", "m2", "review", "--brief", brief(m1), "--project", "app", "--shape", "scout"];
        expect(
            m2.ok(["delegation", "receive"], {
                stdin: JSON.stringify({
                    id: "m1-9",
                    from: "m1",
                    title: "review",
                    brief: "b",
                    project: "app",
                    shape: "scout",
                }),
            }),
        ).toBe("delegation-accepted m2/T2 created");
        expect(tasks(m2)[1]).toMatchObject({ status: "queued", shape: "scout" });
        expect(m1.ok(scout)).toContain("delegated to m2/T3");
    });
});

describe("placing work", () => {
    test("offers no ship work of a project the shortest queue's machine marked verify-only; scout work it gets", async () => {
        const box = withTasks(queued(0, { projects: ["x"], verifyOnly: ["x"] }), 3);
        editBacklog(box, (tasks) => {
            const t3 = tasks.find((task) => task.id === "T3");
            if (t3 === undefined) throw new Error("no T3");
            t3.shape = "scout";
        });
        expect(await pass(box, T0)).toBe("queue: offered work to m2 (m1 3, m2 0)");
        const [offer] = queueItems(box);
        expect(offer).not.toContain("T1:");
        expect(offer).not.toContain("T2:");
        expect(offer).toContain("T3: bin/toli delegate m2 'task 3' --brief <file> --project x --shape scout");
        const queues = box.ok(["fleet", "queues"], { env: ENV });
        expect(queues).toContain("m2: queue 0");
        expect(queues).toContain(", verify-only x");
        expect(box.ok(["pick", "--project", "x"], { env: ENV })).toBe("m1");
        expect(box.ok(["pick", "--project", "x", "--shape", "scout"], { env: ENV })).toBe("m2");
    });
});
