// A lead session that grows too big (docs/sardars.md "A Sardar session that grows too big"): past
// `lead.sessionMemoryGB` (default 8) of resident memory, the minute tick posts one inbox item to this machine's lead
// per session recommending a stow and a restart. toli never stops or signals the session.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseVmRss } from "../src/fleet/session-memory.ts";
import { inbox } from "./delegate-fixture.ts";
import { type Sandbox, sandbox } from "./helpers.ts";

const T0 = "2026-11-21T08:00:00.000Z";
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

type Box = {
    box: Sandbox;
    env: Record<string, string>;
    rss: (gb: number) => void;
    attach: (startedAt: string) => void;
};

/** A machine whose live session is this test process, its resident memory read from a stand-in /proc. */
function machine(lead?: Record<string, unknown>): Box {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    if (lead !== undefined) {
        const file = join(box.root, "config", "machine.json");
        writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), lead }));
    }
    const proc = join(box.root, "proc");
    mkdirSync(join(proc, String(process.pid)), { recursive: true });
    return {
        box,
        env: { TOLI_PLATFORM: "linux", TOLI_PROC_DIR: proc },
        rss: (gb) =>
            writeFileSync(
                join(proc, String(process.pid), "status"),
                `Name:\tomp\nVmPeak:\t99999999 kB\nVmRSS:\t${Math.round(gb * 1024 * 1024)} kB\nThreads:\t40\n`,
            ),
        attach: (startedAt) =>
            writeFileSync(join(box.root, "state", "session.json"), JSON.stringify({ pid: process.pid, startedAt })),
    };
}

function alerts(box: Sandbox): string[] {
    return inbox(box)
        .map((item) => item.title)
        .filter((title) => title.startsWith("lead session pid "));
}

function tickLog(box: Sandbox): string {
    const file = join(box.root, "logs", "tick.log");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
}

describe("a lead session past lead.sessionMemoryGB", () => {
    test("is told once per session to stow and restart, by an inbox item to this machine's lead", () => {
        const { box, env, rss, attach } = machine();
        attach(T0);
        rss(7.5);
        box.ok(["job", "tick"], { now: at(1), env });
        expect(alerts(box)).toEqual([]);

        rss(9);
        box.ok(["job", "tick"], { now: at(2), env });
        expect(alerts(box)).toEqual([`lead session pid ${process.pid} on m1 at 9.0 GB: stow and restart it`]);
        const [item] = inbox(box).filter((entry) => entry.title.startsWith("lead session pid "));
        const body = readFileSync(item?.path ?? "", "utf8");
        expect(body).toContain(`(pid ${process.pid}, open since ${T0}) holds 9.0 GB`);
        expect(body).toContain("past lead.sessionMemoryGB (8 GB)");
        expect(body).toContain("`/stow`");
        expect(body).toContain("toli never stops or signals a live session");
        expect(tickLog(box)).toContain(
            `lead session pid ${process.pid} holds 9.0 GB, past 8 GB: lead told to stow and restart it`,
        );

        // Still growing, the same session is not told again.
        rss(12);
        box.ok(["job", "tick"], { now: at(3), env });
        expect(alerts(box)).toHaveLength(1);

        // A fresh session (restarted under the same pid here) that grows past the limit is told again.
        attach(at(10));
        box.ok(["job", "tick"], { now: at(11), env });
        expect(alerts(box)).toHaveLength(2);
    });

    test("lead.sessionMemoryGB sets the limit; no live session, no alert", () => {
        const { box, env, rss, attach } = machine({ sessionMemoryGB: 2 });
        rss(3);
        box.ok(["job", "tick"], { now: at(1), env });
        expect(alerts(box)).toEqual([]);
        attach(T0);
        box.ok(["job", "tick"], { now: at(2), env });
        expect(alerts(box)).toEqual([`lead session pid ${process.pid} on m1 at 3.0 GB: stow and restart it`]);
        const state = JSON.parse(readFileSync(join(box.root, "state", "lead", "memory-alert.json"), "utf8")) as {
            rssMB: number;
        };
        expect(state.rssMB).toBe(3072);
    });

    test("on macOS the resident memory comes from ps", () => {
        const { box, attach } = machine();
        box.stub("ps", `[ "$*" = "-o rss= -p ${process.pid}" ] && echo '  9437184' || exit 1`);
        attach(T0);
        box.ok(["job", "tick"], { now: at(1), env: { TOLI_PLATFORM: "darwin" } });
        expect(alerts(box)).toEqual([`lead session pid ${process.pid} on m1 at 9.0 GB: stow and restart it`]);
    });

    test("a bad lead.sessionMemoryGB is named in the tick log", () => {
        const { box, env, rss, attach } = machine({ sessionMemoryGB: -1 });
        attach(T0);
        rss(9);
        box.ok(["job", "tick"], { now: at(1), env });
        expect(alerts(box)).toEqual([]);
        expect(tickLog(box)).toContain("config/machine.json lead.sessionMemoryGB must be a positive number");
    });

    test("parseVmRss reads /proc/<pid>/status in MB", () => {
        expect(parseVmRss("Name:\tomp\nVmRSS:\t25165824 kB\n")).toBe(24576);
        expect(parseVmRss("Name:\tomp\n")).toBeNull();
    });
});
