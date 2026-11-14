import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENV, editBacklog, fleet, liveRun, ROOMY, remoteSnapshot, resourcesQueue } from "./fleet-fixture.ts";
import { GIT_ENV, type Sandbox, TOLI_BIN, withProject } from "./helpers.ts";

/**
 * A stand-in lead session: a shell that, once registered with `session start` and told to go, runs `bin/toli <args>`
 * as its child (as omp's bash tool does), then stays alive until killed.
 */
async function leadSession(box: Sandbox, args: string[], now: string): Promise<Bun.Subprocess<"pipe", "pipe">> {
    const script = 'read go; "$@" >/dev/null && echo ran; read done';
    const session = Bun.spawn(["sh", "-c", script, "sh", process.execPath, TOLI_BIN, ...args], {
        cwd: box.root,
        env: { ...process.env, ...GIT_ENV, TOLI_ROOT: box.root, TOLI_DRY_RUN: "1", TOLI_NOW: now },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
    });
    box.ok(["session", "start", "--pid", String(session.pid)]);
    session.stdin.write("go\n");
    await session.stdin.flush();
    const reader = session.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(value)).toBe("ran\n");
    return session;
}

type AgentTask = { id: string; agentSession?: { agent: string; pid: number } };

function agentSession(box: Sandbox, id: string): AgentTask["agentSession"] {
    const tasks = JSON.parse(box.ok(["task", "list", "--json"])) as AgentTask[];
    return tasks.find((task) => task.id === id)?.agentSession;
}

/** What the omp extension writes for a running subagent (state/agents/<id>.json): its omp pid and last report. */
function agentReport(box: Sandbox, id: string, report: { pid: number; at: string; endedAt?: string }): void {
    const dir = join(box.root, "state", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(report));
}

/** What the omp extension writes when it loads in omp `pid` (state/agent-sessions/<pid>.json): its subagents report. */
function reportingSession(box: Sandbox, pid: number): void {
    const dir = join(box.root, "state", "agent-sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, startedAt: "2026-03-04T07:00:00.000Z" }));
}

function queueAt(box: Sandbox, now: string): Record<string, unknown> {
    const resources: { queue: Record<string, unknown> } = JSON.parse(
        box.ok(["resources", "--json"], { env: ENV, now }),
    );
    return resources.queue;
}

/** Coordinator m1 with two jawan slots, project x cloned, and `tasks` queued tasks on it; m2's queue is empty. */
function twoSlots(tasks: number): Sandbox {
    const box = fleet(
        remoteSnapshot("m2", { queue: { queued: 0, active: 0, held: 0, jawansRunning: 0, jawansQueued: 0, depth: 0 } }),
        { ...ROOMY, maxRuns: 2 },
    );
    withProject(box, "x");
    for (let n = 1; n <= tasks; n++) box.ok(["task", "add", "x", `task ${n}`]);
    return box;
}

describe("native subagent jawans share capacity.maxRuns with spawn runs", () => {
    test("resources and fleet queues count them with spawn runs and say at cap, queue instead", () => {
        const box = twoSlots(2);
        box.ok(["task", "start", "T1", "--agent", "T11Sub"]);
        expect(box.ok(["resources"], { env: ENV })).toContain("jawans 1/2 (1 native subagent)");
        // A spawn run on T2 plus T1's native subagent: both slots taken.
        liveRun(box, "j-2", "T2");
        box.ok(["task", "start", "T2", "--agent", "j-2"]);
        const atCap = "jawans at cap 2/2 (1 native subagent): queue instead";
        expect(resourcesQueue(box)).toMatchObject({ jawansRunning: 2, subagents: 1 });
        expect(box.ok(["resources"], { env: ENV })).toContain(atCap);
        expect(box.ok(["fleet", "queues"], { env: ENV })).toContain(
            `m1 (this machine): queue 2 (0 queued, 2 running + 0 waiting; 2 active, 0 held), 1 per jawan slot, ${atCap}`,
        );
    });

    test("the digest says at cap, queue instead, and bin/toli spawn queues while they hold every slot", () => {
        const box = twoSlots(2);
        box.ok(["task", "start", "T1", "--agent", "T11Sub"]);
        box.ok(["task", "start", "T2", "--agent", "T12Sub"]);
        expect(box.ok(["digest"], { env: ENV }).split("\n")).toContain(
            "jawans at cap 2/2 (2 native subagents): queue instead",
        );
        const digest = JSON.parse(box.ok(["digest", "--json"], { env: ENV })) as { slots?: unknown };
        expect(digest.slots).toEqual({ jawansRunning: 2, subagents: 2, maxRuns: 2 });
        box.stub("omp", "echo never started");
        const brief = join(box.root, "brief.md");
        writeFileSync(brief, "TOLI_BRIEF v1\nsay hi\n");
        const run = JSON.parse(
            box.ok(["spawn", "--harness", "omp", "--cwd", box.root, "--brief", brief, "--json"], { env: ENV }),
        ) as { id: string; status: string };
        expect(run.status).toBe("queued");
        expect(box.ok(["run", "kill", run.id])).toBe(`killed ${run.id} (omp) before it started`);
    });

    test("a native subagent whose dispatching session died frees its slot and shows as needing a re-dispatch", async () => {
        // T1384: a subagent dies with the omp session that dispatched it; its task kept taking a jawan slot forever.
        const box = twoSlots(2);
        const lead = await leadSession(box, ["task", "start", "T1", "--agent", "T11Sub"], "2026-03-04T08:00:00.000Z");
        try {
            expect(agentSession(box, "T1")).toEqual({ agent: "T11Sub", pid: lead.pid });
            agentReport(box, "T11Sub", { pid: lead.pid, at: "2026-03-04T08:59:30.000Z" });
            expect(queueAt(box, "2026-03-04T09:00:00.000Z")).toMatchObject({ jawansRunning: 1, subagents: 1 });
            expect(box.ok(["digest"], { now: "2026-03-04T09:00:00.000Z" })).not.toContain("T1 (x) is active");
        } finally {
            lead.kill();
            await lead.exited;
        }
        expect(queueAt(box, "2026-03-04T09:00:00.000Z")).toMatchObject({ jawansRunning: 0, subagents: 0 });
        expect(box.ok(["digest"], { now: "2026-03-04T09:00:00.000Z" })).toContain(
            `T1 (x) is active but its agent T11Sub died with its session ${lead.pid} (dispatched 60m ago); no answer recorded since: re-dispatch it now`,
        );
    });

    test("a subagent recorded outside the registered session (a Claude Code lead) keeps its slot when that session ends", async () => {
        const box = twoSlots(2);
        const other = Bun.spawn(["sleep", "60"]);
        try {
            box.ok(["session", "start", "--pid", String(other.pid)]);
            box.ok(["task", "start", "T1", "--agent", "T11Sub"]);
            expect(agentSession(box, "T1")).toBeUndefined();
        } finally {
            other.kill();
            await other.exited;
        }
        expect(resourcesQueue(box)).toMatchObject({ jawansRunning: 1, subagents: 1 });
    });
});

describe("a native subagent counts as a running jawan only while it reports running (T1419)", () => {
    // T1419: one interactive lead session lives for days; every task one of its finished subagents was recorded on
    // counted as running while that session was alive (68 native subagents while 1-3 ran).
    const START = "2026-03-04T08:00:00.000Z";
    const NOW = "2026-03-04T09:00:00.000Z";

    test("in one live session, only the subagent reporting now counts; finished and silent ones need a re-dispatch", async () => {
        const box = twoSlots(3);
        const session = Bun.spawn(["sleep", "60"]);
        reportingSession(box, session.pid);
        try {
            for (const n of [1, 2, 3]) box.ok(["task", "start", `T${n}`, "--agent", `T1${n}Sub`], { now: START });
            editBacklog(box, (tasks) => {
                for (const task of tasks) task.agentSession = { agent: task.agent, pid: session.pid };
            });
            agentReport(box, "T11Sub", { pid: session.pid, at: "2026-03-04T08:59:30.000Z" });
            agentReport(box, "T13Sub", {
                pid: session.pid,
                at: "2026-03-04T08:20:00.000Z",
                endedAt: "2026-03-04T08:20:00.000Z",
            });
            expect(queueAt(box, NOW)).toMatchObject({ jawansRunning: 1, subagents: 1 });
            const digest = box.ok(["digest"], { now: NOW });
            expect(digest).not.toContain("T1 (x) is active");
            expect(digest).toContain(
                "T2 (x) is active but its agent T12Sub never reported running (dispatched 60m ago); no answer recorded since",
            );
            expect(digest).toContain(
                "T3 (x) is active but its run T13Sub ended 40m ago (state/agents/T13Sub.json); no answer recorded since",
            );
            // A subagent that stops reporting stops counting at once and needs a re-dispatch after the grace minutes.
            expect(queueAt(box, "2026-03-04T09:10:00.000Z")).toMatchObject({ subagents: 0 });
            expect(box.ok(["digest"], { now: "2026-03-04T09:19:30.000Z" })).toContain(
                "T1 (x) is active but its agent T11Sub has not reported running since 20m ago",
            );
        } finally {
            session.kill();
            await session.exited;
        }
    });

    test("an agent no harness reports (a label, a Claude Code subagent) counts only for the grace minutes after dispatch", () => {
        const box = twoSlots(1);
        box.ok(["task", "start", "T1", "--agent", "fleet talk (08:00)"], { now: START });
        expect(queueAt(box, "2026-03-04T08:05:00.000Z")).toMatchObject({ subagents: 1 });
        expect(box.ok(["digest"], { now: "2026-03-04T08:05:00.000Z" })).not.toContain("T1 (x) is active");
        expect(queueAt(box, NOW)).toMatchObject({ jawansRunning: 0, subagents: 0 });
        expect(box.ok(["digest"], { now: NOW })).toContain(
            "T1 (x) is active but its agent fleet talk (08:00) never reported running (dispatched 60m ago)",
        );
    });

    test("a label naming another fleet machine is that machine's work: the task waits on it (T1427)", () => {
        const box = twoSlots(1);
        box.ok(["task", "start", "T1", "--agent", "m2 coordinates (talk 08:00)"], { now: START });
        expect(queueAt(box, NOW)).toMatchObject({ jawansRunning: 0, subagents: 0 });
        const digest = box.ok(["digest"], { now: NOW });
        expect(digest).toContain("T1 (x) is active, waiting on m2 (agent: m2 coordinates (talk 08:00))");
        expect(digest).not.toContain("T1 (x) is active but");
    });

    test("a bin/toli remote run is the target's jawan, never a native subagent here, and only its record ends it", () => {
        const box = twoSlots(1);
        box.ok(["task", "start", "T1", "--agent", "remote:m2:bg_7"], { now: START });
        expect(queueAt(box, "2026-03-04T08:05:00.000Z")).toMatchObject({ jawansRunning: 0, subagents: 0 });
        expect(box.ok(["digest"], { now: NOW })).not.toContain("T1 (x) is active");
    });
});

describe("a lead session started before agent reports existed keeps its subagents alive while it lives (T1429)", () => {
    // T1429: after an upgrade, an interactive omp still running the old extension never writes state/agents/<id>.json,
    // so its live subagents were flagged dead after the grace minutes.
    const START = "2026-03-04T08:00:00.000Z";
    const LATER = "2026-03-04T08:20:00.000Z";

    test("a native agent recorded by an alive pre-report lead session is not flagged at 20 minutes; it is once that session dies", async () => {
        const box = twoSlots(1);
        const lead = await leadSession(box, ["task", "start", "T1", "--agent", "T11Sub"], START);
        try {
            expect(agentSession(box, "T1")).toEqual({ agent: "T11Sub", pid: lead.pid });
            expect(queueAt(box, LATER)).toMatchObject({ jawansRunning: 1, subagents: 1 });
            expect(box.ok(["digest"], { now: LATER })).not.toContain("T1 (x) is active");
        } finally {
            lead.kill();
            await lead.exited;
        }
        expect(box.ok(["digest"], { now: LATER })).toContain(
            `T1 (x) is active but its agent T11Sub died with its session ${lead.pid} (dispatched 20m ago)`,
        );
    });

    test("a reporting session's agent with a stale report is still flagged", async () => {
        const box = twoSlots(1);
        const lead = await leadSession(box, ["task", "start", "T1", "--agent", "T11Sub"], START);
        try {
            reportingSession(box, lead.pid);
            agentReport(box, "T11Sub", { pid: lead.pid, at: "2026-03-04T08:01:00.000Z" });
            expect(queueAt(box, LATER)).toMatchObject({ subagents: 0 });
            expect(box.ok(["digest"], { now: LATER })).toContain(
                "T1 (x) is active but its agent T11Sub has not reported running since 19m ago (state/agents/T11Sub.json)",
            );
        } finally {
            lead.kill();
            await lead.exited;
        }
    });
});
