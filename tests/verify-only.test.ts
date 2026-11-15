// A machine verify-only for a project (`project set <p> --role verify-only`, docs/projects.md) takes no ship work for it.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { brief, pair, type Task, tasks } from "./delegate-fixture.ts";
import { ENV, editBacklog } from "./fleet-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";
import { applyIn, envelope, pin, sender } from "./peer-fixture.ts";
import { pass, queued, queueItems, T0, withTasks } from "./queues-fixture.ts";

function parent(box: Sandbox): Task {
    const task = tasks(box).find((entry) => entry.id === "T1");
    if (task === undefined) throw new Error("no T1");
    return task;
}

/** The body of the one outbox item of `kind` waiting in `box`. */
function outboxBody(box: Sandbox, kind: string): string {
    const dir = join(box.root, "state", "outbox");
    const items = readdirSync(dir)
        .filter((file) => file.endsWith(".json"))
        .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as { kind: string; body: string })
        .filter((item) => item.kind === kind);
    const [item] = items;
    if (item === undefined || items.length !== 1) throw new Error(`${items.length} ${kind} items in the outbox`);
    return item.body;
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
        const reason =
            "m2 is verify-only for app: it takes no ship work for it (bin/toli pick --project app); verify work goes with bin/toli delegate --verify";
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

    test("verify work sent with --verify passes a verify-only machine; plain ship work's hand-back says how", () => {
        const { m1, m2 } = pair();
        withProject(m1, "app");
        withProject(m2, "app");
        m2.ok(["project", "set", "app", "--role", "verify-only"]);
        m1.ok(["task", "add", "app", "parent work"]);
        const verify = ["delegate", "m2", "Verify the work", "--brief", brief(m1), "--project", "app", "--for", "T1"];
        expect(m1.ok([...verify, "--verify"])).toContain("delegated to m2/T1 (for T1)");
        expect(tasks(m2)[0]).toMatchObject({ status: "queued", shape: "ship", verify: true });
        expect(parent(m1)).toMatchObject({ status: "active", agent: "m2/T1" });

        // A delegator on an older toli sends no marker: the hand-back names the flag.
        const handed = m2.ok(["delegation", "receive"], {
            stdin: JSON.stringify({ id: "m1-9", from: "m1", title: "Verify more", brief: "b", project: "app" }),
        });
        expect(handed).toContain("verify work goes with bin/toli delegate --verify");
    });
});

describe("a delegation handed back by message", () => {
    test("its hand-back lands on the --for task before the delegation's receipt does", () => {
        const { m1, m2, down, up } = pair();
        withProject(m1, "app");
        withProject(m2, "app");
        m1.ok(["peer", "init"]);
        const { fingerprint } = JSON.parse(m1.ok(["peer", "status", "--json"])) as { fingerprint: string };
        const m2Key = sender();
        pin(m1, [{ name: "m2", identity: m2Key }]);
        m2.ok(["project", "set", "app", "--role", "verify-only"]);
        m1.ok(["task", "add", "app", "parent work"]);
        down();
        const ship = ["delegate", "m2", "the work", "--brief", brief(m1), "--project", "app", "--for", "T1"];
        expect(m1.ok(ship)).toContain("queued: m2 is unreachable");
        // m2 gets the delegation by pull and hands it back; its report waits in its outbox while m1 is unreachable.
        down("m1");
        m2.ok(["delegation", "receive", "--from", "m1"], { stdin: outboxBody(m1, "delegation") });
        const body = outboxBody(m2, "update");
        const [receipt] = applyIn(m1, [envelope(m2Key, "m2", fingerprint, { kind: "update", body })]);
        expect(receipt?.reason).toBeUndefined();
        expect(receipt?.status).toBe("applied");
        const handed = parent(m1);
        expect(handed.status).toBe("queued");
        expect(handed.delegatedTo).toEqual(["m2/T1"]);
        expect(handed.notes.some((note) => note.startsWith("m2/T1 handed the work back: m2 is verify-only"))).toBe(
            true,
        );

        // The delegation's own receipt lands later: the task stays linked and queued.
        up();
        up("m1");
        m1.ok(["job", "tick"]);
        const linked = parent(m1);
        expect(linked.status).toBe("queued");
        expect(linked.delegatedTo).toEqual(["m2/T1"]);
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
