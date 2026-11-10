import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brief, inbox, type Pair, pair, type Task, tasks } from "./delegate-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";

function parent(box: Sandbox): Task {
    const task = tasks(box).find((entry) => entry.id === "T1");
    if (task === undefined) throw new Error("no T1");
    return task;
}

/** m1's T1 delegated to m2 as m2/T1 (`--for T1`). */
function delegated(): Pair {
    const machines = pair();
    withProject(machines.m1, "app");
    machines.m1.ok(["task", "add", "app", "parent work"]);
    machines.m1.ok(["delegate", "m2", "the work", "--brief", brief(machines.m1), "--for", "T1"]);
    return machines;
}

/** An outbox file as src/jobs/outbox.ts writes it; only its body is read here. */
type OutboxFile = { body: string };

function outboxBodies(box: Sandbox): string[] {
    const dir = join(box.root, "state", "outbox");
    return readdirSync(dir).map((file) => {
        const item: OutboxFile = JSON.parse(readFileSync(join(dir, file), "utf8"));
        return item.body;
    });
}

describe("delegated tasks write back to the --for task", () => {
    test("done carries the commit, the report and the notes, and wakes the delegator once", () => {
        const { m1, m2 } = delegated();
        writeFileSync(join(m2.root, "report.md"), "all green\n");
        m2.ok(["task", "done", "T1", "--commit", "abc123", "--report", "report.md", "--note", "no-op done"]);
        const task = parent(m1);
        expect(task).toMatchObject({ status: "done", commit: "abc123", report: "data/reports/delegated/m2-T1.md" });
        expect(task.delegates?.["m2/T1"]).toMatchObject({ status: "done", commit: "abc123" });
        expect(readFileSync(join(m1.root, task.report ?? ""), "utf8")).toContain("all green");
        expect(task.notes).toContain("m2/T1: no-op done");
        expect(task.notes).toContain("m2/T1 is done");
        expect(task.notes.some((note) => note.includes("delegated by"))).toBe(false);
        const wakes = inbox(m1).filter((item) => item.title === "m2/T1 done: the work");
        expect(wakes).toHaveLength(1);
        expect(readFileSync(wakes[0]?.path ?? "", "utf8")).toContain("Your task T1 is done");
        // A later note is copied without another wake.
        m2.ok(["task", "done", "T1", "--note", "follow-up"]);
        expect(parent(m1).notes).toContain("m2/T1: follow-up");
        expect(inbox(m1).filter((item) => item.title.startsWith("m2/T1"))).toHaveLength(1);
    });

    test("an unreachable delegator gets the update from the owner's tick, and a repeat is applied once", () => {
        const { m1, m2, down, up } = delegated();
        down("m1");
        m2.ok(["task", "done", "T1", "--commit", "c0ffee"]);
        expect(parent(m1).status).toBe("active");
        const [queued] = outboxBodies(m2);
        up("m1");
        m2.ok(["job", "tick"]);
        expect(outboxBodies(m2)).toHaveLength(0);
        expect(parent(m1)).toMatchObject({ status: "done", commit: "c0ffee" });
        const notes = parent(m1).notes.length;
        expect(m1.ok(["delegation", "update"], { stdin: queued ?? "" })).toBe(
            "delegation-updated m2/T1 T1 (already recorded)",
        );
        expect(parent(m1).notes).toHaveLength(notes);
        expect(inbox(m1).filter((item) => item.title.startsWith("m2/T1"))).toHaveLength(1);
    });

    test("a task delegated twice is done only when both are", () => {
        const { m1, m2 } = delegated();
        m1.ok(["delegate", "m2", "more work", "--brief", brief(m1), "--for", "T1"]);
        m2.ok(["task", "done", "T1", "--commit", "a1"]);
        expect(parent(m1).status).toBe("active");
        m2.ok(["task", "done", "T2", "--commit", "b2"]);
        expect(parent(m1)).toMatchObject({ status: "done", commit: "b2" });
    });

    test("all delegations dropped drops the --for task", () => {
        const { m1, m2 } = delegated();
        m2.ok(["task", "drop", "T1"]);
        expect(parent(m1).status).toBe("dropped");
        expect(inbox(m1).at(-1)?.title).toBe("m2/T1 dropped: the work");
    });
});

describe("a delegated task's question goes to the delegating lead", () => {
    test("it wakes the delegator, which answers it; the owner releases the task at once", () => {
        const { m1, m2 } = delegated();
        m2.ok(["task", "hold", "T1", "--question", "Which?", "--option", "a => fast", "--option", "b => slow"]);
        const task = parent(m1);
        expect(task.status).toBe("active");
        expect(task.delegates?.["m2/T1"]).toMatchObject({ status: "held", question: "Which?" });
        const wake = inbox(m1).find((item) => item.title === "m2/T1 held: the work");
        const body = readFileSync(wake?.path ?? "", "utf8");
        expect(body).toContain("You delegated this work, so you answer it");
        expect(body).toContain("bin/toli task escalate m2/T1");

        expect(m1.ok(["task", "answer", "m2/T1", "a"])).toContain("m2 recorded the answer for m2/T1:");
        expect(tasks(m2)[0]?.status).toBe("queued");
        expect(inbox(m2).at(-1)?.title).toBe("answer recorded for T1: dispatch it");
        const after = parent(m1);
        expect(after.status).toBe("active");
        expect(after.delegates?.["m2/T1"]?.status).toBe("queued");
        expect(after.notes).toContain("m2/T1: Q: Which?\nA: a (= a) (recorded by m1's lead)");
    });

    test("escalated, it holds the --for task in the Needs-you queue; the user's answer goes to the owner", () => {
        const { m1, m2 } = delegated();
        m2.ok(["task", "hold", "T1", "--question", "Ship it?", "--option", "yes => push", "--option", "no => wait"]);
        expect(m1.toli(["task", "escalate", "m2/T9"]).stderr).toContain("m2/T9 has no open question here");
        expect(m1.ok(["task", "escalate", "m2/T1"])).toContain("in the Needs-you queue");
        expect(parent(m1)).toMatchObject({
            status: "held",
            question: "m2/T1 asks: Ship it?",
            options: [
                { choice: "yes", outcome: "push" },
                { choice: "no", outcome: "wait" },
            ],
            heldFrom: "m2/T1",
        });

        expect(m1.ok(["task", "answer", "T1", "no"])).toContain("m2 recorded the answer for m2/T1:");
        const [owned] = tasks(m2);
        expect(owned?.status).toBe("queued");
        expect(owned?.notes.at(-1)).toBe("Q: Ship it?\nA: no (= no) (recorded by m1's lead)");
        const after = parent(m1);
        expect(after.status).toBe("active");
        expect(after.heldFrom).toBeUndefined();
    });
});

describe("task link", () => {
    test("attaches a delegation made without --for, which then reports its current state", () => {
        const { m1, m2 } = pair();
        withProject(m1, "app");
        m1.ok(["task", "add", "app", "parent work"]);
        m1.ok(["delegate", "m2", "unlinked", "--brief", brief(m1)]);
        m2.ok(["task", "done", "T1", "--commit", "d00d"]);
        expect(parent(m1).status).toBe("queued");

        expect(m1.ok(["task", "link", "T1", "m2/T1"])).toContain(
            "T1 linked to m2/T1: delegation-linked m2/T1 to m1/T1",
        );
        expect(tasks(m2)[0]?.delegatedBy).toMatchObject({ machine: "m1", task: "T1" });
        expect(parent(m1)).toMatchObject({ status: "done", commit: "d00d", delegatedTo: ["m2/T1"] });
    });

    test("refuses a bare id and a task another machine delegated", () => {
        const { m1, m2 } = pair();
        withProject(m1, "app");
        m1.ok(["task", "add", "app", "parent work"]);
        expect(m1.toli(["task", "link", "T1", "T2"]).stderr).toContain("task link needs another machine's task");
        m2.ok(["delegation", "receive"], { stdin: JSON.stringify({ id: "m3-1", from: "m3", title: "t", brief: "b" }) });
        expect(m1.ok(["task", "link", "T1", "m2/T1"])).toContain("T1 linked to m2/T1 here; m2 gets the link");
    });
});

describe("handing delegated work back", () => {
    test("task handback queues the --for task again with the reason, and a new delegation finishes it", () => {
        const { m1, m2 } = delegated();
        expect(m2.toli(["task", "handback", "T1"]).stderr).toContain("task handback needs --reason");
        expect(m2.ok(["task", "handback", "m2/T1", "--reason", "overloaded"])).toContain(
            "handed back to m1: overloaded",
        );
        expect(tasks(m2)[0]?.status).toBe("dropped");
        const task = parent(m1);
        expect(task.status).toBe("queued");
        expect(task.agent).toBeUndefined();
        expect(task.notes).toContain("m2/T1 handed the work back: overloaded");
        const wake = inbox(m1).find((item) => item.title === "m2/T1 handed back: the work");
        expect(readFileSync(wake?.path ?? "", "utf8")).toContain("T1 is queued again: give it to another Sardar");

        expect(m1.ok(["delegate", "m2", "the work, again", "--brief", brief(m1), "--for", "T1"])).toContain("m2/T2");
        expect(parent(m1)).toMatchObject({ status: "active", agent: "m2/T2" });
        m2.ok(["task", "done", "T2", "--commit", "f00d"]);
        expect(parent(m1)).toMatchObject({ status: "done", commit: "f00d" });
    });

    test("a task not delegated here cannot be handed back", () => {
        const { m2 } = pair();
        withProject(m2, "app");
        m2.ok(["task", "add", "app", "mine"]);
        expect(m2.toli(["task", "handback", "T1", "--reason", "x"]).stderr).toContain("was not delegated here");
    });

    test("delegating or linking for a dropped task reopens it, and a dropped delegation does not block done", () => {
        const { m1, m2 } = delegated();
        m2.ok(["task", "drop", "T1"]);
        expect(parent(m1).status).toBe("dropped");
        m1.ok(["delegate", "m2", "another try", "--brief", brief(m1), "--for", "T1"]);
        const reopened = parent(m1);
        expect(reopened).toMatchObject({ status: "active", agent: "m2/T2" });
        expect(reopened.notes).toContain("reopened (was dropped): it works through m2/T2 now");
        expect(m1.ok(["task", "start", "T1", "--agent", "j-1"])).toContain("T1\tactive");
        m2.ok(["task", "done", "T2", "--commit", "c4fe"]);
        expect(parent(m1)).toMatchObject({ status: "done", commit: "c4fe" });

        // A link to a delegation made without --for reopens a done task the same way.
        m1.ok(["delegate", "m2", "unlinked", "--brief", brief(m1)]);
        m1.ok(["task", "link", "T1", "m2/T3"]);
        expect(parent(m1)).toMatchObject({ status: "active", agent: "m2/T3" });
    });
});
