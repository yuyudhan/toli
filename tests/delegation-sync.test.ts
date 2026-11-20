import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brief, cancelled, delegated, inbox, outboxFiles, pair, parent, tasks } from "./delegate-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";

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

    test("a delegation at the longest title reports back with an envelope title any receiver takes (T2119)", () => {
        const { m1, m2, down, up } = pair();
        withProject(m1, "app");
        m1.ok(["task", "add", "app", "parent work"]);
        const long = "w".repeat(191);
        m1.ok(["delegate", "m2", long, "--brief", brief(m1), "--for", "T1"]);
        down("m1");
        m2.ok(["task", "done", "T1", "--commit", "c0ffee"]);
        const dir = join(m2.root, "state", "outbox");
        const items = outboxFiles(m2).map(
            (file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as { title: string; body: string },
        );
        expect(items).toHaveLength(1);
        const [item] = items;
        expect(item?.title.length).toBeLessThanOrEqual(200);
        expect(item?.title).toStartWith("m2/T1 done: www");
        // The stored title is never cut: the update carries it whole.
        const update = JSON.parse(item?.body ?? "{}") as { task: { title: string }; message: { title: string } };
        expect(update.task.title).toBe(long);
        expect(update.message.title).toBe(`m2/T1 done: ${long}`);
        up("m1");
        m2.ok(["job", "tick"]);
        expect(parent(m1)).toMatchObject({ status: "done", commit: "c0ffee" });
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

    test("a dropped or handed-back delegation never closes the --for task; the last open one done does (T1976)", () => {
        const { m1, m2 } = delegated();
        m1.ok(["delegate", "m2", "more work", "--brief", brief(m1), "--for", "T1"]);
        m2.ok(["task", "done", "T1", "--commit", "a1"]);
        m2.ok(["task", "drop", "T2"]);
        expect(parent(m1).status).toBe("active");
        expect(parent(m1).commit).toBeUndefined();
        expect(readFileSync(inbox(m1).at(-1)?.path ?? "", "utf8")).toContain("Your task T1 is active");
        m1.ok(["delegate", "m2", "last work", "--brief", brief(m1), "--for", "T1"]);
        m2.ok(["task", "done", "T3", "--commit", "c3"]);
        expect(parent(m1)).toMatchObject({ status: "done", commit: "c3" });

        // Handed back after the others are done, the work is queued again for another Sardar, not done.
        m1.ok(["delegate", "m2", "again", "--brief", brief(m1), "--for", "T1"]);
        expect(parent(m1).status).toBe("active");
        m2.ok(["task", "handback", "T4", "--reason", "overloaded"]);
        expect(parent(m1).status).toBe("queued");
    });

    test("a slice delegated while the task's own jawan works on it adds notes, commit and report, never closes it", () => {
        const { m1, m2 } = pair();
        withProject(m1, "app");
        m1.ok(["task", "add", "app", "release"]);
        m1.ok(["task", "start", "T1", "--agent", "ReleaseSub"]);
        expect(m1.ok(["delegate", "m2", "lint slice", "--brief", brief(m1), "--for", "T1"])).toContain("m2/T1");
        expect(parent(m1)).toMatchObject({ status: "active", agent: "ReleaseSub", slices: ["m2/T1"] });
        expect(parent(m1).delegatedTo).toBeUndefined();
        writeFileSync(join(m2.root, "report.md"), "lint clean\n");
        m2.ok(["task", "done", "T1", "--commit", "11ab", "--report", "report.md"]);
        const task = parent(m1);
        expect(task).toMatchObject({ status: "active", agent: "ReleaseSub" });
        expect(task.commit).toBeUndefined();
        expect(task.report).toBeUndefined();
        expect(task.notes).toContain("m2/T1 is done");
        expect(task.notes).toContain("m2/T1 commit: 11ab");
        expect(task.notes).toContain("m2/T1 report: data/reports/delegated/m2-T1.md");
        expect(readFileSync(join(m1.root, "data", "reports", "delegated", "m2-T1.md"), "utf8")).toContain("lint clean");
        expect(inbox(m1).filter((item) => item.title === "m2/T1 done: lint slice")).toHaveLength(1);
        // The slice handed back or dropped leaves the task with its jawan too.
        m1.ok(["delegate", "m2", "docs slice", "--brief", brief(m1), "--for", "T1"]);
        m2.ok(["task", "handback", "T2", "--reason", "busy"]);
        expect(parent(m1)).toMatchObject({ status: "active", agent: "ReleaseSub", slices: ["m2/T1", "m2/T2"] });
    });

    test("the task's whole work delegated closes it when done, even with a slice delegated later", () => {
        const { m1, m2 } = delegated();
        expect(parent(m1)).toMatchObject({ status: "active", agent: "m2/T1", delegatedTo: ["m2/T1"] });
        m1.ok(["task", "start", "T1", "--agent", "IntegrateSub"]);
        m1.ok(["delegate", "m2", "a slice", "--brief", brief(m1), "--for", "T1"]);
        expect(parent(m1)).toMatchObject({ delegatedTo: ["m2/T1"], slices: ["m2/T2"] });
        m2.ok(["task", "done", "T2", "--commit", "5115"]);
        expect(parent(m1).status).toBe("active");
        m2.ok(["task", "done", "T1", "--commit", "9a1e"]);
        expect(parent(m1)).toMatchObject({ status: "done", commit: "9a1e" });
    });

    test("a task delegated with --for while its old agent stays recorded waits on the delegate (T1427)", () => {
        const { m1, m2 } = pair();
        withProject(m1, "app");
        m1.ok(["task", "add", "app", "release"]);
        const start = "2026-03-04T08:00:00.000Z";
        const later = "2026-03-04T08:30:00.000Z";
        m1.ok(["task", "start", "T1", "--agent", "ReleaseSub"], { now: start });
        m1.ok(["delegate", "m2", "the rest", "--brief", brief(m1), "--for", "T1"], { now: start });
        const digest = m1.ok(["digest"], { now: later });
        expect(digest).toContain("T1 (app) is active, waiting on m2/T1 (delegated)");
        expect(digest).not.toContain("T1 (app) is active but");
        // Once the delegate is through, the task is its local agent's again, and a dead one is named.
        m2.ok(["task", "done", "T1", "--commit", "11ab"]);
        expect(m1.ok(["digest"], { now: later })).toContain(
            "T1 (app) is active but its agent ReleaseSub never reported running",
        );
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

    test("refuses a bare id, a missing id, and a task another machine delegated", () => {
        const { m1, m2 } = pair();
        withProject(m1, "app");
        m1.ok(["task", "add", "app", "parent work"]);
        expect(m1.toli(["task", "link", "T1", "T2"]).stderr).toContain("task link needs another machine's task");
        const empty = m1.toli(["task", "link", "T1", "m2/"]);
        expect(empty.code).toBe(1);
        expect(empty.stderr).toContain("task link needs another machine's task: <machine>/T<n>");
        expect(outboxFiles(m1)).toEqual([]);
        m2.ok(["delegation", "receive"], { stdin: JSON.stringify({ id: "m3-1", from: "m3", title: "t", brief: "b" }) });
        const refused = m1.toli(["task", "link", "T1", "m2/T1"]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("m2 refused the link: T1 was delegated by m3, not m1");
        expect(outboxFiles(m1)).toEqual([]);
        expect(cancelled(m1).map((item) => item.reason)).toEqual(["m2 refused it: T1 was delegated by m3, not m1"]);
        expect(parent(m1).delegatedTo).toBeUndefined();
        expect(tasks(m2)[0]?.delegatedBy).toMatchObject({ machine: "m3" });
    });
});

describe("a message its receiver refuses", () => {
    test("is refused once with the reason, never retried, and never holds up later messages to that machine", () => {
        const { m1, m2, down, up } = pair();
        withProject(m1, "app");
        m1.ok(["task", "add", "app", "parent work"]);
        m2.ok(["delegation", "receive"], { stdin: JSON.stringify({ id: "m3-1", from: "m3", title: "t", brief: "b" }) });
        down();
        expect(m1.ok(["task", "link", "T1", "m2/T1"])).toContain("m2 gets the link");
        m1.ok(["talk", "m2", "after the link"]);
        expect(outboxFiles(m1)).toHaveLength(2);
        up();
        m1.ok(["job", "tick"]);
        expect(outboxFiles(m1)).toEqual([]);
        expect(cancelled(m1).map((item) => [item.kind, item.reason])).toEqual([
            ["link", "m2 refused it: T1 was delegated by m3, not m1"],
        ]);
        expect(inbox(m1).some((item) => item.title.startsWith("1 outbox item not sent: m2 refused it"))).toBe(true);
        expect(inbox(m2).some((item) => item.title === "message from m1")).toBe(true);
        m1.ok(["job", "tick"]);
        expect(cancelled(m1)).toHaveLength(1);
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

test("task handback --full also marks the owner full, so no lead offers it more work", () => {
    const { m1, m2 } = delegated();
    const output = m2.ok(["task", "handback", "T1", "--reason", "overloaded", "--full"]);
    expect(output).toContain("full: handed back T1: overloaded (until ");
    expect(m2.ok(["lead", "full", "--status"])).toStartWith("full: handed back T1: overloaded");
    expect(m1.ok(["lead", "full", "--status"])).toBe("not full: this machine takes work");
});
