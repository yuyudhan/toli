import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { markWatchingSession, runningSubagents, SubagentWatch } from "../src/records/agents.ts";
import { sandbox } from "./helpers.ts";

const START = new Date("2026-03-04T08:00:00.000Z");
const LATER = new Date("2026-03-04T08:01:00.000Z");
const END = new Date("2026-03-04T08:02:00.000Z");

function report(root: string, id: string): unknown {
    const file = join(root, "state", "agents", `${id}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/** An omp session's async-job snapshot (`ctx.getAsyncJobSnapshot()`), as omp 18.18 and later return it. */
function snapshot(running: Array<{ id: string; type: string; agentId?: string }>): unknown {
    return {
        running: running.map((job) => ({ ...job, status: "running", label: job.id, startTime: 0, ownerId: "Main" })),
        recent: [],
        delivery: { queued: 0, delivering: false, pendingJobIds: [] },
    };
}

describe("runningSubagents (the task subagents an omp session's async-job snapshot lists as running, T1541)", () => {
    test("names each running task job's agent and nothing else", () => {
        expect(
            runningSubagents(
                snapshot([
                    { id: "T5Sub", type: "task", agentId: "T5Sub" },
                    { id: "bg_1", type: "bash" },
                    { id: "T6Sub", type: "task" },
                ]),
            ),
        ).toEqual(["T5Sub"]);
    });

    test("a session without a snapshot, or one omp shapes differently, names none", () => {
        for (const value of [null, undefined, "x", {}, { running: "no" }, { running: [null, 3] }])
            expect(runningSubagents(value)).toEqual([]);
    });
});

describe("SubagentWatch (the omp extension's liveness report for the subagents its session runs, T1541)", () => {
    test("reports each running subagent with the omp pid every beat and records its end once it stops running", () => {
        const box = sandbox();
        const watch = new SubagentWatch(box.root, 4242);
        watch.observe(["T5Sub", "T6Sub"], START);
        expect(report(box.root, "T5Sub")).toEqual({ pid: 4242, at: START.toISOString() });
        watch.observe(["T5Sub", "T6Sub"], LATER);
        expect(report(box.root, "T6Sub")).toEqual({ pid: 4242, at: LATER.toISOString() });
        watch.observe(["T6Sub"], END);
        expect(report(box.root, "T5Sub")).toEqual({ pid: 4242, at: END.toISOString(), endedAt: END.toISOString() });
        expect(report(box.root, "T6Sub")).toEqual({ pid: 4242, at: END.toISOString() });
        // A resumed subagent runs again; the session's end ends every one still running.
        watch.observe(["T5Sub", "T6Sub"], new Date("2026-03-04T08:03:00.000Z"));
        expect(report(box.root, "T5Sub")).toEqual({ pid: 4242, at: "2026-03-04T08:03:00.000Z" });
        watch.observe([], new Date("2026-03-04T08:04:00.000Z"));
        for (const id of ["T5Sub", "T6Sub"])
            expect(report(box.root, id)).toEqual({
                pid: 4242,
                at: "2026-03-04T08:04:00.000Z",
                endedAt: "2026-03-04T08:04:00.000Z",
            });
    });

    test("an id that names no file reports nothing", () => {
        const box = sandbox();
        const watch = new SubagentWatch(box.root, 4242);
        watch.observe(["../escape"], START);
        watch.observe([], END);
        expect(existsSync(join(box.root, "state", "agents"))).toBe(false);
    });
});

describe("markWatchingSession (the extension's mark that its omp watches its subagents, T1429, T1541)", () => {
    test("marks the omp and drops the marks of omp processes that are gone", async () => {
        const box = sandbox();
        const dir = join(box.root, "state", "agent-sessions");
        const gone = Bun.spawn(["true"]);
        await gone.exited;
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${gone.pid}.json`), "{}");
        writeFileSync(join(dir, "stray.json"), "{}");
        markWatchingSession(box.root, process.pid, START);
        expect(readdirSync(dir)).toEqual([`${process.pid}.json`]);
        expect(JSON.parse(readFileSync(join(dir, `${process.pid}.json`), "utf8"))).toEqual({
            pid: process.pid,
            startedAt: START.toISOString(),
            watches: true,
        });
    });
});
