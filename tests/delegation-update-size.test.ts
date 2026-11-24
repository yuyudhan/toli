// A delegated task with many notes (a fan-out campaign's `--for` task) still reports to its delegator: the update
// carries only the latest notes that fit the peer body limit, with how many earlier ones it left out, and the
// delegator copies each note once.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bodyLimit } from "../src/peer/envelope.ts";
import type { Task } from "../src/records/backlog.ts";
import { delegationUpdate } from "../src/records/delegation-report.ts";
import { delegated, outboxFiles, parent } from "./delegate-fixture.ts";

function busyTask(count: number, size: number): Task {
    const notes = Array.from({ length: count }, (_, index) => `note ${index} ${"x".repeat(size)}`);
    return {
        id: "T223",
        project: "app",
        title: "fan-out campaign",
        shape: "ship",
        status: "active",
        notes,
        createdAt: "2026-11-24T10:00:00.000Z",
        updatedAt: "2026-11-24T18:36:00.098Z",
        delegatedBy: { machine: "m1", task: "T2705", id: "d1", at: "2026-11-24T10:00:00.000Z" },
    };
}

describe("a delegated task's update fits the peer body limit", () => {
    test("400 notes of about 300 bytes: the body is within the limit and carries the latest notes", () => {
        const task = busyTask(400, 300);
        expect(Buffer.byteLength(JSON.stringify(task.notes))).toBeGreaterThan(bodyLimit("update"));
        const update = delegationUpdate("m2", task, { machine: "m1", task: "T2705" });
        const body = JSON.stringify(update);
        expect(Buffer.byteLength(body)).toBeLessThanOrEqual(bodyLimit("update"));
        const sent = update.task.notes;
        expect(sent.length).toBeGreaterThan(0);
        expect(sent).toEqual(task.notes.slice(-sent.length));
        expect(sent.at(-1)).toStartWith("note 399 ");
        expect(update.notesSkipped).toBe(task.notes.length - sent.length);
    });

    test("a task whose notes fit sends them all and no skipped count", () => {
        const task = busyTask(10, 30);
        const update = delegationUpdate("m2", task, { machine: "m1", task: "T2705" });
        expect(update.task.notes).toEqual(task.notes);
        expect(update.notesSkipped).toBeUndefined();
    });

    test("the delegator copies each note once and marks the ones it never got", () => {
        const { m1, m2, down } = delegated();
        down("m1");
        m2.ok(["task", "done", "T1", "--commit", "c0ffee"]);
        const [file] = outboxFiles(m2);
        const item = JSON.parse(readFileSync(join(m2.root, "state", "outbox", file ?? ""), "utf8")) as {
            body: string;
        };
        const base = JSON.parse(item.body) as Record<string, unknown> & { task: Record<string, unknown> };
        const send = (updatedAt: string, notes: string[], notesSkipped?: number): void => {
            const update = { ...base, task: { ...base.task, status: "active", updatedAt, notes }, notesSkipped };
            m1.ok(["delegation", "update"], { stdin: JSON.stringify(update) });
        };
        const copied = (): string[] => parent(m1).notes.filter((note) => note.startsWith("m2/T1: "));

        send("2026-11-24T10:00:01.000Z", ["n1", "n2"]);
        expect(copied()).toEqual(["m2/T1: n1", "m2/T1: n2"]);
        send("2026-11-24T10:00:02.000Z", ["n6", "n7"], 5);
        expect(copied()).toEqual([
            "m2/T1: n1",
            "m2/T1: n2",
            "m2/T1: 3 earlier notes were not sent (too large for one update); they are on m2",
            "m2/T1: n6",
            "m2/T1: n7",
        ]);
        send("2026-11-24T10:00:03.000Z", ["n7", "n8"], 6);
        expect(copied().slice(-2)).toEqual(["m2/T1: n7", "m2/T1: n8"]);
        expect(copied()).toHaveLength(6);
        expect(parent(m1).delegates?.["m2/T1"]).toMatchObject({ notes: 8 });
    });
});
