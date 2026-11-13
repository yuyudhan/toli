import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENV, fleet, liveRun, ROOMY, remoteSnapshot, resourcesQueue } from "./fleet-fixture.ts";
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
            expect(resourcesQueue(box)).toMatchObject({ jawansRunning: 1, subagents: 1 });
            expect(box.ok(["digest"], { now: "2026-03-04T09:00:00.000Z" })).not.toContain("T1 (x) is active");
        } finally {
            lead.kill();
            await lead.exited;
        }
        expect(resourcesQueue(box)).toMatchObject({ jawansRunning: 0, subagents: 0 });
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
