// A hold that needs the user reaches the Needs-you queue of the machine he talks to (src/records/raise-holds.ts,
// docs/sardars.md "Holds on a worker reach the coordinator"): a worker's own held task is raised to its coordinator by
// the minute tick, once, and cleared there when it is answered (on either machine) or dropped. A delegated task's
// hold goes to its delegator as before, never twice, and a question for another Sardar never reaches the user.
import { describe, expect, test } from "bun:test";
import { brief, type Task, type Trio, tasks, trio } from "./delegate-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";

const SHIP = "How should the release ship: tag or branch?";
const PUSH = "Asha's word needed: push the release to main?";

/** m1 is the coordinator; m2 and m3 are its workers (their `coordinator` is m1's ssh name and root). */
function fleet(): Trio {
    const machines = trio();
    for (const [name, box] of [
        ["m2", machines.m2],
        ["m3", machines.m3],
    ] as const)
        box.ok([
            "init",
            "--name",
            name,
            "--role",
            "worker",
            "--coordinator-ssh",
            "host1",
            "--coordinator-root",
            machines.m1.root,
        ]);
    return machines;
}

function held(box: Sandbox): Task[] {
    return tasks(box).filter((task) => task.status === "held");
}

type Needs = {
    total: number;
    groups: Array<{ project: string; items: Array<{ id: string; question: string | null }> }>;
};

function needs(box: Sandbox): Needs {
    return JSON.parse(box.ok(["needs", "--json"])) as Needs;
}

function task(box: Sandbox, id: string): Task {
    const found = tasks(box).find((entry) => entry.id === id);
    if (found === undefined) throw new Error(`no ${id}`);
    return found;
}

/** m2's own task T1 in project app, held with SHIP. */
function workerHold(): Trio {
    const machines = fleet();
    withProject(machines.m2, "app");
    machines.m2.ok(["task", "add", "app", "cut the release"]);
    machines.m2.ok([
        "task",
        "hold",
        "T1",
        "--question",
        SHIP,
        "--option",
        "tag => cut v1",
        "--option",
        "branch => push",
    ]);
    return machines;
}

describe("a worker's own hold reaches the coordinator's Needs-you queue", () => {
    test("after one tick, once, in the owner's project, with its options", () => {
        const { m1, m2 } = workerHold();
        expect(needs(m1).total).toBe(0);
        m2.ok(["job", "tick"]);
        expect(needs(m1)).toMatchObject({
            total: 1,
            groups: [{ project: "app", items: [{ question: `m2/T1 asks: ${SHIP}` }] }],
        });
        expect(held(m1)[0]).toMatchObject({
            heldFrom: "m2/T1",
            options: [
                { choice: "tag", outcome: "cut v1" },
                { choice: "branch", outcome: "push" },
            ],
        });
        m2.ok(["job", "tick"]);
        expect(held(m1)).toHaveLength(1);
        expect(tasks(m1)).toHaveLength(1);
        // The owner's own queue still has it too.
        expect(needs(m2).total).toBe(1);
    });

    test("answered on the coordinator, the answer reaches the owner and both queues clear", () => {
        const { m1, m2 } = workerHold();
        m2.ok(["job", "tick"]);
        const [raised] = held(m1);
        expect(m1.ok(["task", "answer", raised?.id ?? "", "tag"])).toContain("m2 recorded the answer for m2/T1:");
        expect(task(m2, "T1")).toMatchObject({ status: "queued" });
        expect(task(m2, "T1").notes.at(-1)).toBe(`Q: ${SHIP}\nA: tag (= tag) (recorded by m1's lead)`);
        expect(needs(m1).total).toBe(0);
        expect(needs(m2).total).toBe(0);
        // The carrier holds no work of its own: it is done, never left queued for the coordinator to dispatch.
        expect(task(m1, raised?.id ?? "").status).toBe("done");
        m2.ok(["job", "tick"]);
        expect(needs(m1).total).toBe(0);
        expect(tasks(m1)).toHaveLength(1);
    });

    test("answered by fleet id on the coordinator, the owner takes it and the next tick clears the entry", () => {
        const { m1, m2 } = workerHold();
        m2.ok(["job", "tick"]);
        expect(m1.ok(["task", "answer", "m2/T1", "branch"])).toContain("m2 recorded the answer for m2/T1:");
        expect(task(m2, "T1").status).toBe("queued");
        m2.ok(["job", "tick"]);
        expect(needs(m1).total).toBe(0);
    });

    test("answered or dropped on the owner, the next tick clears it on the coordinator", () => {
        const answered = workerHold();
        answered.m2.ok(["job", "tick"]);
        answered.m2.ok(["task", "answer", "T1", "tag"]);
        expect(needs(answered.m1).total).toBe(1);
        answered.m2.ok(["job", "tick"]);
        expect(needs(answered.m1).total).toBe(0);
        expect(tasks(answered.m1)[0]?.status).toBe("done");

        const dropped = workerHold();
        dropped.m2.ok(["job", "tick"]);
        dropped.m2.ok(["task", "drop", "T1"]);
        dropped.m2.ok(["job", "tick"]);
        expect(needs(dropped.m1).total).toBe(0);
        expect(tasks(dropped.m1)[0]?.status).toBe("dropped");
    });

    test("a new question on the same task replaces the raised one", () => {
        const { m1, m2 } = workerHold();
        m2.ok(["job", "tick"]);
        m2.ok([
            "task",
            "hold",
            "T1",
            "--question",
            "Which tag name: v1 or v1.0.0?",
            "--option",
            "v1 => tag v1",
            "--option",
            "v1.0.0 => tag v1.0.0",
        ]);
        m2.ok(["job", "tick"]);
        expect(held(m1).map((entry) => entry.question)).toEqual(["m2/T1 asks: Which tag name: v1 or v1.0.0?"]);
    });

    test("only the coordinator answers a raised hold; another worker is refused", () => {
        const { m2, m3 } = workerHold();
        m2.ok(["job", "tick"]);
        expect(m3.toli(["task", "answer", "m2/T1", "tag"]).stderr).toContain("not delegated here");
        expect(task(m2, "T1").status).toBe("held");
    });
});

describe("a delegated task's hold reaches the user once", () => {
    test("delegated by the coordinator: held there once, never raised again by the owner's tick", () => {
        const { m1, m2 } = fleet();
        withProject(m1, "app");
        m1.ok(["task", "add", "app", "parent work"]);
        m1.ok(["delegate", "m2", "the work", "--brief", brief(m1), "--for", "T1"]);
        m2.ok(["task", "hold", "T1", "--question", PUSH, "--option", "yes => push", "--option", "no => wait"]);
        m2.ok(["job", "tick"]);
        expect(held(m1).map((entry) => entry.id)).toEqual(["T1"]);
        expect(tasks(m1)).toHaveLength(1);
    });

    test("delegated by another worker: its held copy is raised to the coordinator once, and the answer reaches the owner", () => {
        const { m1, m2, m3 } = fleet();
        withProject(m3, "app");
        m3.ok(["task", "add", "app", "parent work"]);
        m3.ok(["delegate", "m2", "the work", "--brief", brief(m3), "--for", "T1"]);
        m2.ok(["task", "hold", "T1", "--question", PUSH, "--option", "yes => push", "--option", "no => wait"]);
        expect(task(m3, "T1")).toMatchObject({ status: "held", heldFrom: "m2/T1" });
        m2.ok(["job", "tick"]);
        m3.ok(["job", "tick"]);
        m2.ok(["job", "tick"]);
        const raised = held(m1);
        expect(raised.map((entry) => entry.question)).toEqual([`m3/T1 asks: m2/T1 asks: ${PUSH}`]);
        expect(raised[0]?.heldFrom).toBe("m3/T1");

        m1.ok(["task", "answer", raised[0]?.id ?? "", "no"]);
        expect(task(m3, "T1").status).toBe("active");
        expect(task(m2, "T1").status).toBe("queued");
        m3.ok(["job", "tick"]);
        expect(needs(m1).total).toBe(0);
    });

    test("a question the coordinator itself holds is not raised back to it", () => {
        const { m1, m2 } = fleet();
        withProject(m2, "app");
        m2.ok(["task", "add", "app", "parent work"]);
        m2.ok(["delegate", "m1", "the work", "--brief", brief(m2), "--for", "T1"]);
        m1.ok(["task", "hold", "T1", "--question", PUSH, "--option", "yes => push", "--option", "no => wait"]);
        expect(task(m2, "T1")).toMatchObject({ status: "held", heldFrom: "m1/T1" });
        m2.ok(["job", "tick"]);
        expect(held(m1).map((entry) => entry.id)).toEqual(["T1"]);
        expect(tasks(m1)).toHaveLength(1);
    });
});

describe("a question for another Sardar", () => {
    test("never reaches the coordinator's Needs-you queue", () => {
        const { m1, m2, m3 } = fleet();
        withProject(m3, "app");
        m3.ok(["task", "add", "app", "parent work"]);
        m3.ok(["delegate", "m2", "the work", "--brief", brief(m3), "--for", "T1"]);
        m2.ok([
            "task",
            "hold",
            "T1",
            "--question",
            "Which crate first?",
            "--option",
            "core => start with core",
            "--option",
            "cli => start with cli",
        ]);
        expect(held(m3)).toEqual([]);
        m2.ok(["job", "tick"]);
        m3.ok(["job", "tick"]);
        expect(needs(m1).total).toBe(0);
        expect(tasks(m1)).toEqual([]);
    });
});
