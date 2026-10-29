import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { liveSession } from "../src/session.ts";
import { sandbox } from "./helpers.ts";

const savedRoot = process.env.TOLI_ROOT;
afterEach(() => {
    if (savedRoot === undefined) delete process.env.TOLI_ROOT;
    else process.env.TOLI_ROOT = savedRoot;
});

function recordSession(root: string, pid: unknown): string {
    const file = join(root, "state", "session.json");
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(file, JSON.stringify({ pid, startedAt: "2026-03-04T10:00:00Z" }));
    return file;
}

describe("liveSession", () => {
    test("a running pid is the live session", () => {
        const box = sandbox();
        process.env.TOLI_ROOT = box.root;
        recordSession(box.root, process.pid);
        expect(liveSession()?.pid).toBe(process.pid);
    });

    test("a recorded pid that has exited is ignored and its file removed", () => {
        const box = sandbox();
        process.env.TOLI_ROOT = box.root;
        // `true` has exited by the time spawnSync returns, so its pid is a dead one.
        const file = recordSession(box.root, Bun.spawnSync(["true"]).pid);
        expect(liveSession()).toBeNull();
        expect(existsSync(file)).toBe(false);
    });

    test("a malformed pid is never treated as live", () => {
        const box = sandbox();
        process.env.TOLI_ROOT = box.root;
        for (const pid of [0, -1, "123", 1.5]) {
            recordSession(box.root, pid);
            expect(liveSession()).toBeNull();
        }
    });

    test("no session file means no session", () => {
        process.env.TOLI_ROOT = sandbox().root;
        expect(liveSession()).toBeNull();
    });
});

describe("session command", () => {
    test("end only removes the session registered under the same pid", () => {
        const box = sandbox();
        box.ok(["session", "start", "--pid", "4242"]);
        expect(box.ok(["session", "end", "--pid", "999"])).toBe("session 999 was not registered");
        expect(existsSync(join(box.root, "state", "session.json"))).toBe(true);
        expect(box.ok(["session", "end", "--pid", "4242"])).toBe("session 4242 ended");
        expect(existsSync(join(box.root, "state", "session.json"))).toBe(false);
    });

    test("start rejects a missing or non-numeric pid", () => {
        const box = sandbox();
        expect(box.toli(["session", "start"]).stderr).toContain("--pid <n>");
        expect(box.toli(["session", "start", "--pid", "abc"]).code).toBe(1);
        expect(existsSync(join(box.root, "state", "session.json"))).toBe(false);
    });
});
