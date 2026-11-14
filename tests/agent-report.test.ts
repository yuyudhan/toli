import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentReporter } from "../src/records/agents.ts";
import { sandbox } from "./helpers.ts";

const START = new Date("2026-03-04T08:00:00.000Z");
const LATER = new Date("2026-03-04T08:01:00.000Z");
const END = new Date("2026-03-04T08:02:00.000Z");

function report(root: string, id: string): unknown {
    const file = join(root, "state", "agents", `${id}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

describe("AgentReporter (the omp extension's per-subagent liveness report, T1419)", () => {
    test("a subagent reports its pid while it runs, refreshes it on every beat and records its end", () => {
        const box = sandbox();
        const reporter = new AgentReporter(box.root, 4242);
        reporter.started({ kind: "sub", id: "T5Sub" }, START);
        expect(report(box.root, "T5Sub")).toEqual({ pid: 4242, at: START.toISOString() });
        reporter.beat(LATER);
        expect(report(box.root, "T5Sub")).toEqual({ pid: 4242, at: LATER.toISOString() });
        reporter.ended(END);
        expect(report(box.root, "T5Sub")).toEqual({ pid: 4242, at: END.toISOString(), endedAt: END.toISOString() });
        // A beat after the end never revives it; a new run of the same agent (a resumed subagent) does.
        reporter.beat(new Date("2026-03-04T08:03:00.000Z"));
        expect(report(box.root, "T5Sub")).toEqual({ pid: 4242, at: END.toISOString(), endedAt: END.toISOString() });
        reporter.started({ kind: "sub", id: "T5Sub" }, new Date("2026-03-04T08:04:00.000Z"));
        expect(report(box.root, "T5Sub")).toEqual({ pid: 4242, at: "2026-03-04T08:04:00.000Z" });
    });

    test("the main session, an unnamed agent and an id that is no file name report nothing", () => {
        const box = sandbox();
        for (const agent of [{ kind: "main", id: "main" }, undefined, { kind: "sub", id: "../escape" }]) {
            const reporter = new AgentReporter(box.root, 4242);
            reporter.started(agent, START);
            reporter.beat(LATER);
            reporter.ended(END);
        }
        expect(existsSync(join(box.root, "state", "agents"))).toBe(false);
    });
});
