// T2226: the rule that drops a delegated task's older queued reports, called directly so two reports of the same task
// (two processes, each reporting after updateTask released the backlog lock) can be interleaved step by step.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropOlderReports } from "../src/records/delegation-report.ts";
import { inProcess } from "./helpers.ts";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function outboxRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "toli-update-drop-"));
    roots.push(root);
    mkdirSync(join(root, "state", "outbox"), { recursive: true });
    return root;
}

type Report = { id: string; forTask?: string; task: { updatedAt: string } };

/** Queue update `file` for m1 carrying `report`, as sendNow writes one. */
function queue(root: string, file: string, report: Report): void {
    const item = {
        from: "m2",
        title: `m2/${report.id}`,
        body: JSON.stringify({ owner: "m2", ...report }),
        to: { name: "m1", ssh: "m1", root: "/m1" },
        kind: "update",
        queuedAt: Date.now(),
    };
    writeFileSync(join(root, "state", "outbox", `${file}.json`), JSON.stringify(item));
}

function queued(root: string): string[] {
    return readdirSync(join(root, "state", "outbox")).sort();
}

const to = { machine: "m1", task: "T1" };
const older: Report = { id: "T1", forTask: "T1", task: { updatedAt: "2026-11-21T10:00:00.000Z" } };
const newer: Report = { id: "T1", forTask: "T1", task: { updatedAt: "2026-11-21T10:00:01.000Z" } };

describe("dropping a delegated task's older queued reports (T2226)", () => {
    test("two reports interleaved leave the newer queued, whichever drops last", () => {
        const root = outboxRoot();
        inProcess(root, () => {
            queue(root, "update-T1-a", older);
            queue(root, "update-T1-b", newer);
            dropOlderReports("update-T1-b", to, newer);
            dropOlderReports("update-T1-a", to, older);
        });
        expect(queued(root)).toEqual(["update-T1-b.json"]);
    });

    test("an older writer dropping first never removes the newer report", () => {
        const root = outboxRoot();
        inProcess(root, () => {
            queue(root, "update-T1-a", older);
            queue(root, "update-T1-b", newer);
            dropOlderReports("update-T1-a", to, older);
            dropOlderReports("update-T1-b", to, newer);
        });
        expect(queued(root)).toEqual(["update-T1-b.json"]);
    });

    test("a report of the same moment is kept: only a strictly older one goes", () => {
        const root = outboxRoot();
        inProcess(root, () => {
            queue(root, "update-T1-a", newer);
            queue(root, "update-T1-b", newer);
            dropOlderReports("update-T1-b", to, newer);
        });
        expect(queued(root)).toEqual(["update-T1-a.json", "update-T1-b.json"]);
    });

    test("the same task id reported for another delegator task is left alone", () => {
        const root = outboxRoot();
        inProcess(root, () => {
            queue(root, "update-T1-other", { ...older, forTask: "T9" });
            queue(root, "update-T1-direct", { id: older.id, task: older.task });
            queue(root, "update-T1-b", newer);
            dropOlderReports("update-T1-b", to, newer);
        });
        expect(queued(root)).toEqual(["update-T1-b.json", "update-T1-direct.json", "update-T1-other.json"]);
    });
});
