import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cancelled, delegated, inbox, outboxFiles, parent, tasks } from "./delegate-fixture.ts";

/** The options a test hold offers (a hold needs 2-4). */
const CHOICES = ["--option", "a => fast", "--option", "b => slow"];

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

    test("an answer for a hold its owner already reactivated becomes a note that wakes the owner's lead", () => {
        // T1382: the answer was refused ("T1 is active, not waiting on an answer") and dropped to state/outbox/cancelled.
        const { m1, m2, down, up } = delegated();
        m2.ok(["task", "hold", "T1", "--question", "Ship it?", "--option", "yes => push", "--option", "no => wait"]);
        m1.ok(["task", "escalate", "m2/T1"]);
        // The owner takes the hold up again while its update to m1 is still queued, and m1's user answers the hold.
        down("m1");
        m2.ok(["task", "start", "T1", "--agent", "OwnSub"]);
        up("m1");

        const answered = m1.ok(["task", "answer", "T1", "yes"]);
        expect(answered).toContain("m2 recorded the answer for m2/T1:");
        expect(answered).toContain("T1 is active: the answer from m1 is noted on it and its lead woken");
        expect(cancelled(m1)).toEqual([]);
        expect(outboxFiles(m1)).toEqual([]);
        const [owned] = tasks(m2);
        expect(owned).toMatchObject({ status: "active", agent: "OwnSub" });
        expect(owned).not.toHaveProperty("answer");
        expect(owned?.notes.at(-1)).toBe("answer from m1's lead while T1 is active: Q: Ship it?\nA: yes (= yes)");
        const wake = inbox(m2).find((item) => item.title === "answer from m1 for T1 (active)");
        expect(readFileSync(wake?.path ?? "", "utf8")).toContain("T1 is active, so the answer did not release it");
    });

    test("a retried answer is applied once: the owner drops a copy it already applied, by its id (T2151)", () => {
        const { m1, m2, down, up } = delegated();
        m2.ok(["task", "hold", "T1", "--question", "Which?", "--option", "a => fast", "--option", "b => slow"]);
        down();
        expect(m1.ok(["task", "answer", "m2/T1", "a"])).toContain("answer for m2/T1 queued for m2");
        const [file] = outboxFiles(m1);
        const item = readFileSync(join(m1.root, "state", "outbox", file ?? ""), "utf8");
        expect(JSON.parse(JSON.parse(item).body)).toMatchObject({ id: "T1", answer: "a" });
        up();
        m1.ok(["job", "tick"]);
        expect(tasks(m2)[0]?.status).toBe("queued");
        // The ssh delivery ran there, but its exit was lost: the tick sends the same item again.
        writeFileSync(join(m1.root, "state", "outbox", file ?? ""), item);
        m1.ok(["job", "tick"]);
        expect(outboxFiles(m1)).toEqual([]);
        expect(cancelled(m1)).toEqual([]);
        const [owned] = tasks(m2);
        expect(owned?.status).toBe("queued");
        expect(owned?.notes.filter((note) => note.includes("A: a"))).toEqual([
            "Q: Which?\nA: a (= a) (recorded by m1's lead)",
        ]);
        expect(inbox(m2).filter((entry) => entry.title.startsWith("answer "))).toHaveLength(1);
    });

    test("a second answer to the same open question is refused until the owner reports again (T2151)", () => {
        const { m1, m2, down, up } = delegated();
        m2.ok(["task", "hold", "T1", "--question", "Which?", ...CHOICES]);
        down();
        m1.ok(["task", "answer", "m2/T1", "a"]);
        const again = m1.toli(["task", "answer", "m2/T1", "a"]);
        expect(again.code).toBe(1);
        expect(again.stderr).toContain("m2/T1's question is already answered from here");
        expect(outboxFiles(m1)).toHaveLength(1);
        up();
        m1.ok(["job", "tick"]);
        expect(tasks(m2)[0]?.notes.filter((note) => note.includes("A: a"))).toHaveLength(1);
    });

    test("nothing sends an answer for a task its owner reported done or dropped (T2151)", () => {
        const { m1, m2, down, up } = delegated();
        m2.ok(["task", "hold", "T1", "--question", "Which?", ...CHOICES]);
        down();
        m1.ok(["task", "answer", "m2/T1", "a"]);
        expect(outboxFiles(m1)).toHaveLength(1);
        // The owner finishes the task itself; its report reaches m1 while m1's answer still waits for m2.
        m2.ok(["task", "done", "T1", "--commit", "d0ne"]);
        expect(parent(m1).delegates?.["m2/T1"]?.status).toBe("done");
        expect(outboxFiles(m1)).toEqual([]);
        expect(cancelled(m1).map((entry) => [entry.kind, entry.reason])).toEqual([
            ["answer", "m2/T1 is done on m2: its answer is not needed"],
        ]);
        const late = m1.toli(["task", "answer", "m2/T1", "b"]);
        expect(late.code).toBe(1);
        expect(late.stderr).toContain("m2/T1 is done on m2 (its report says so): no answer is sent");
        expect(outboxFiles(m1)).toEqual([]);
        up();
        m1.ok(["job", "tick"]);
        const [owned] = tasks(m2);
        expect(owned?.status).toBe("done");
        expect(owned?.notes.some((note) => note.includes("answer from m1"))).toBe(false);
        expect(inbox(m2).filter((entry) => entry.title.startsWith("answer "))).toEqual([]);
    });

    test("a task taken up again after done gets a new answer through (T2151)", () => {
        const { m1, m2 } = delegated();
        m2.ok(["task", "hold", "T1", "--question", "Which?", ...CHOICES]);
        m1.ok(["task", "answer", "m2/T1", "a"]);
        m2.ok(["task", "done", "T1", "--commit", "d0ne"]);
        expect(m1.toli(["task", "answer", "m2/T1", "a"]).code).toBe(1);
        // Reopened: the owner holds the done task again with a new question.
        m2.ok(["task", "hold", "T1", "--question", "Which again?", ...CHOICES]);
        expect(parent(m1).delegates?.["m2/T1"]).toMatchObject({ status: "held", question: "Which again?" });
        expect(m1.ok(["task", "answer", "m2/T1", "b"])).toContain("m2 recorded the answer for m2/T1:");
        const [owned] = tasks(m2);
        expect(owned?.status).toBe("queued");
        expect(owned?.notes.at(-1)).toBe("Q: Which again?\nA: b (= b) (recorded by m1's lead)");
    });
});
