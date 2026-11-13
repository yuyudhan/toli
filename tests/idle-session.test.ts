import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { idleSessionCheck } from "../src/setup/machine-checks.ts";
import { sandbox } from "./helpers.ts";

const saved = { root: process.env.TOLI_ROOT, now: process.env.TOLI_NOW };
afterEach(() => {
    for (const [name, value] of [
        ["TOLI_ROOT", saved.root],
        ["TOLI_NOW", saved.now],
    ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

describe("doctor: an idle interactive session", () => {
    test("is flagged once it has left a wake unread past lead.idleSessionMinutes, and only then", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        writeFileSync(
            join(box.root, "state", "session.json"),
            JSON.stringify({ pid: process.pid, startedAt: "2026-11-11T08:32:00.000Z" }),
        );
        box.ok(["inbox", "add", "--from", "m2", "--title", "unread"], {
            stdin: "body",
            now: "2026-11-11T08:33:00.000Z",
        });
        process.env.TOLI_ROOT = box.root;
        process.env.TOLI_NOW = "2026-11-11T09:00:00.000Z";
        expect(idleSessionCheck()).toBeNull();
        process.env.TOLI_NOW = "2026-11-13T09:00:00.000Z";
        expect(idleSessionCheck()).toEqual({
            level: "warn",
            name: "lead-session",
            detail: `interactive session pid ${process.pid} has left wakes unread since 2026-11-11T08-33-00-000Z (over 60 min): the headless lead takes the turns meanwhile; attend or close that session (toli never stops it)`,
        });
        box.ok(["inbox", "ack", "--through", "2026-11-11T08-33-00-000Z"]);
        expect(idleSessionCheck()).toBeNull();
    });
});
