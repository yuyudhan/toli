// T1372 (itlinux6): the lead service ran headless turns beside a live interactive lead, and the duplicate runs they
// queued had to be killed by hand, which left their tasks naming jawans that never started.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENV, fleet, ROOMY, remoteSnapshot } from "./fleet-fixture.ts";
import { type Sandbox, sandbox, withProject } from "./helpers.ts";

function taskT2(box: Sandbox): Record<string, unknown> | undefined {
    const tasks = JSON.parse(box.ok(["task", "list", "--json"])) as Record<string, unknown>[];
    return tasks.find((task) => task.id === "T2");
}

test("a second interactive omp that registers and exits leaves the live lead registered: no turn starts", () => {
    // A jawan drove `omp` in tmux from toli's root; its extension registered over the lead's record and removed it
    // on exit, and every later `lead run` pass ran headless turns beside the live lead.
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    const calls = join(box.root, ".omp-calls");
    box.stub("omp", `mkdir -p "${calls}" && touch "${calls}/$$"`);
    const other = Bun.spawn(["sleep", "60"]);
    try {
        box.ok(["session", "start", "--pid", String(process.pid)]);
        box.ok(["session", "start", "--pid", String(other.pid)]);
        box.ok(["session", "end", "--pid", String(other.pid)]);
        const status: unknown = JSON.parse(
            box.ok(["lead", "status", "--json"], { env: { TOLI_SCHEDULER: "crontab" } }),
        );
        expect(status).toMatchObject({ interactivePid: process.pid });
        box.ok(["inbox", "add", "--from", "m2", "--title", "message from m2"], { stdin: "hello" });
        box.ok(["lead", "run", "--once"]);
        expect(existsSync(calls) ? readdirSync(calls) : []).toEqual([]);
    } finally {
        other.kill();
    }
});

test("a run killed while queued leaves its task queued with no jawan, not on an earlier one", () => {
    const box = fleet(
        remoteSnapshot("m2", { queue: { queued: 0, active: 0, held: 0, jawansRunning: 0, jawansQueued: 0, depth: 0 } }),
        { ...ROOMY, maxRuns: 2 },
    );
    withProject(box, "x");
    box.ok(["task", "add", "x", "other work"]);
    box.ok(["task", "add", "x", "the task"]);
    box.ok(["task", "add", "x", "more work"]);
    // T2 had a native subagent before; the subagents on T1 and T3 hold both slots, so a spawn on T2 queues.
    box.ok(["task", "start", "T2", "--agent", "T2Sub"]);
    box.ok(["task", "start", "T1", "--agent", "T1Sub"]);
    box.ok(["task", "start", "T3", "--agent", "T3Sub"]);
    box.stub("omp", "echo never started");
    const brief = join(box.root, "brief.md");
    writeFileSync(brief, "TOLI_BRIEF v1\nsay hi\n");
    const run = JSON.parse(
        box.ok(["spawn", "--task", "T2", "--work", "scout", "--harness", "omp", "--brief", brief, "--json"], {
            env: ENV,
        }),
    ) as { id: string; status: string };
    expect(run.status).toBe("queued");
    expect(taskT2(box)).toMatchObject({ status: "active", agent: run.id });
    expect(box.ok(["run", "kill", run.id])).toBe(`killed ${run.id} (omp) before it started`);
    const task = taskT2(box);
    expect(task).toMatchObject({ status: "queued" });
    expect(task?.agent).toBeUndefined();
    expect(task?.dispatchedAt).toBeUndefined();
});
