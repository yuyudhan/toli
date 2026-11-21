// T2226: while the delegator is unreachable, a delegated task's reports wait in the outbox as at most one update per
// task and target; a newer report (a note, a new status) replaces the one still waiting, and the delegator gets the
// latest once it is back.
import { describe, expect, test } from "bun:test";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brief, cancelled, delegated, inbox, outboxFiles, parent } from "./delegate-fixture.ts";
import type { Sandbox } from "./helpers.ts";

type Waiting = { file: string; status: string; notes: string[] };

function outboxDir(box: Sandbox): string {
    return join(box.root, "state", "outbox");
}

/** The update items for m2's T1 waiting in m2's outbox. */
function waitingUpdates(m2: Sandbox): Waiting[] {
    const dir = outboxDir(m2);
    return outboxFiles(m2)
        .filter((file) => file.startsWith("update-T1-"))
        .map((file) => {
            const item = JSON.parse(readFileSync(join(dir, file), "utf8")) as { body: string };
            const update = JSON.parse(item.body) as { task: { status: string; notes: string[] } };
            return { file, status: update.task.status, notes: update.task.notes };
        });
}

describe("a delegated task's reports to an unreachable delegator (T2226)", () => {
    test("wait as one update per task, the newest replacing the older, and arrive once", () => {
        const { m1, m2, down, up } = delegated();
        down("m1");
        m2.ok(["task", "done", "T1", "--commit", "c0ffee"]);
        for (const note of ["first", "second", "third"]) {
            m2.ok(["task", "done", "T1", "--note", note]);
            m2.ok(["job", "tick"]);
        }
        const [done, ...extra] = waitingUpdates(m2);
        expect(extra).toHaveLength(0);
        expect(done?.status).toBe("done");
        expect(done?.notes).toEqual(expect.arrayContaining(["first", "second", "third"]));
        // The replaced reports were never lost, so none is listed as given up.
        expect(cancelled(m2)).toHaveLength(0);

        // A new status replaces the waiting report too.
        m2.ok(["task", "start", "T1", "--reopen"]);
        const [active, ...more] = waitingUpdates(m2);
        expect(more).toHaveLength(0);
        expect(active?.status).toBe("active");
        m2.ok(["task", "done", "T1", "--commit", "beef"]);
        const [again, ...rest] = waitingUpdates(m2);
        expect(rest).toHaveLength(0);
        expect(again?.status).toBe("done");

        up("m1");
        // The ticks while m1 was down backed it off (src/jobs/reach.ts); the next tick after that wait delivers.
        rmSync(join(m2.root, "state", "reach.json"), { force: true });
        m2.ok(["job", "tick"]);
        expect(waitingUpdates(m2)).toHaveLength(0);
        const task = parent(m1);
        expect(task).toMatchObject({ status: "done", commit: "beef" });
        for (const note of ["first", "second", "third"]) expect(task.notes).toContain(`m2/T1: ${note}`);
        expect(inbox(m1).filter((item) => item.title.startsWith("m2/T1"))).toHaveLength(1);
        m2.ok(["job", "tick"]);
        expect(inbox(m1).filter((item) => item.title.startsWith("m2/T1"))).toHaveLength(1);
    });

    test("an older report being sent right now is left as it is, and the delegator ends on the newer", () => {
        const { m1, m2, down, up } = delegated();
        down("m1");
        m2.ok(["task", "done", "T1", "--commit", "c0ffee", "--note", "first"]);
        const [older] = waitingUpdates(m2);
        if (older === undefined) throw new Error("no update queued");
        const dir = outboxDir(m2);
        // A live process (this test's) claimed it for sending.
        const claimed = join(dir, `${older.file}.sending-${process.pid}`);
        renameSync(join(dir, older.file), claimed);
        const before = readFileSync(claimed, "utf8");
        m2.ok(["task", "done", "T1", "--commit", "beef", "--note", "second"]);
        expect(readFileSync(claimed, "utf8")).toBe(before);
        const [newer, ...rest] = waitingUpdates(m2);
        expect(rest).toHaveLength(0);
        expect(newer?.file).not.toBe(older.file);
        expect(newer?.notes).toContain("second");

        up("m1");
        rmSync(join(m2.root, "state", "reach.json"), { force: true });
        m2.ok(["job", "tick"]);
        expect(waitingUpdates(m2)).toHaveLength(0);
        expect(parent(m1)).toMatchObject({ status: "done", commit: "beef" });
        // Its sender gone, the older report goes back to the queue and arrives after the newer: m1 keeps the newer.
        renameSync(claimed, join(dir, older.file));
        m2.ok(["job", "tick"]);
        expect(waitingUpdates(m2)).toHaveLength(0);
        const task = parent(m1);
        expect(task).toMatchObject({ status: "done", commit: "beef" });
        expect(task.notes).toContain("m2/T1: second");
        expect(inbox(m1).filter((item) => item.title.startsWith("m2/T1"))).toHaveLength(1);
    });

    test("leaves other tasks' reports, other machines' items and raised holds alone", () => {
        const { m1, m2, down } = delegated();
        m1.ok(["delegate", "m2", "more work", "--brief", brief(m1), "--for", "T1"]);
        down("m1");
        m2.ok(["task", "done", "T2", "--commit", "a2"]);
        m2.ok(["task", "done", "T1", "--commit", "a1"]);
        const [first] = waitingUpdates(m2);
        if (first === undefined) throw new Error("no update queued");
        const dir = outboxDir(m2);
        const item = JSON.parse(readFileSync(join(dir, first.file), "utf8")) as {
            body: string;
            to: { name: string };
        };
        // The same task's report to another machine, and a raised hold of the same id to the same machine.
        writeFileSync(join(dir, "copy-m3.json"), JSON.stringify({ ...item, to: { ...item.to, name: "m3" } }));
        const raised = { ...JSON.parse(item.body), forUser: true };
        writeFileSync(join(dir, "copy-raise.json"), JSON.stringify({ ...item, body: JSON.stringify(raised) }));
        const others = outboxFiles(m2).filter((file) => !file.startsWith("update-T1-"));
        expect(others.filter((file) => file.startsWith("update-T2-"))).toHaveLength(1);
        const kept = new Map(others.map((file) => [file, readFileSync(join(dir, file), "utf8")]));

        m2.ok(["task", "done", "T1", "--note", "later"]);
        const [latest, ...rest] = waitingUpdates(m2);
        expect(rest).toHaveLength(0);
        expect(latest?.notes).toContain("later");
        for (const [file, text] of kept) expect(readFileSync(join(dir, file), "utf8")).toBe(text);
        const left = outboxFiles(m2).filter((file) => !file.startsWith("update-T1-"));
        expect(left.sort()).toEqual([...kept.keys()].sort());
    });
});
