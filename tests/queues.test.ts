import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { balancePass } from "../src/fleet/queues.ts";
import { ENV, fleet, remoteSnapshot, sshLog } from "./fleet-fixture.ts";
import { GIT_ENV, type Sandbox, sandbox, withProject } from "./helpers.ts";

type Pick = {
    machine: string | null;
    local: boolean;
    depth: number | null;
    candidates: { machine: string; depth: number | null }[];
};

const T0 = "2026-11-10T09:00:00.000Z";

/** m2's snapshot with a queue of `depth` queued tasks. */
function queued(depth: number, overrides: Record<string, unknown> = {}): string {
    return remoteSnapshot("m2", {
        queue: { queued: depth, active: 0, held: 0, jawansRunning: 0, jawansQueued: 0, depth },
        ...overrides,
    });
}

/** Coordinator m1 with project x registered (and cloned) and `tasks` queued tasks on it. */
function withTasks(m2Snapshot: string, tasks: number): Sandbox {
    const box = fleet(m2Snapshot);
    withProject(box, "x");
    for (let n = 1; n <= tasks; n++) box.ok(["task", "add", "x", `task ${n}`]);
    return box;
}

/** Merge `lead` settings into m1's config/machine.json. */
function setLead(box: Sandbox, lead: Record<string, unknown>): void {
    const path = join(box.root, "config", "machine.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), lead }));
}

/** Run the lead service's balancing pass in this process as `box`'s machine at `at`, with its stubs on PATH. */
async function pass(box: Sandbox, at: string): Promise<string | null> {
    const env: Record<string, string> = {
        ...GIT_ENV,
        ...ENV,
        TOLI_ROOT: box.root,
        TOLI_NOW: at,
        PATH: `${box.stubs}:${process.env.PATH ?? ""}`,
    };
    const saved = Object.keys(env).map((key) => [key, process.env[key]] as const);
    Object.assign(process.env, env);
    try {
        return await balancePass();
    } finally {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

/** The `queue:` items in m1's inbox, as their text. */
function queueItems(box: Sandbox): string[] {
    const dir = join(box.root, "data", "inbox");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .map((file) => readFileSync(join(dir, file), "utf8"))
        .filter((text) => text.startsWith("# queue:"));
}

function inboxSends(box: Sandbox): string[] {
    return sshLog(box)
        .split("\n")
        .filter((line) => line.includes("inbox add"));
}

describe("pick ranks by queue depth", () => {
    test("a loaded, low-memory machine with an empty queue is picked over this machine with a deeper queue", () => {
        const busy = queued(0, {
            load1: 40,
            memAvailableMB: 100,
            available: false,
            reasons: ["load 40/8 cpus over 0.8"],
        });
        const box = withTasks(busy, 2);
        const pick = JSON.parse(box.ok(["pick", "--project", "x", "--json"], { env: ENV })) as Pick;
        expect(pick).toMatchObject({ machine: "m2", local: false, depth: 0 });
        expect(pick.candidates.map((candidate) => [candidate.machine, candidate.depth])).toEqual([
            ["m2", 0],
            ["m1", 2],
        ]);
        expect(box.ok(["pick", "--project", "x"], { env: ENV })).toBe("m2");
    });

    test("on equal load per slot the machine with the clone wins, then this machine", () => {
        const box = withTasks(queued(1, { projects: ["x"], maxRuns: 50 }), 1);
        // Both hold the clone: this machine wins.
        expect(box.ok(["pick", "--project", "x"], { env: ENV })).toBe("m1");
        // Without its clone (the URL is still registered here) m1 loses to the clone holder...
        rmSync(join(box.root, "projects", "x"), { recursive: true, force: true });
        expect(box.ok(["pick", "--project", "x"], { env: ENV })).toBe("m2");
        // ...but without a project this machine wins the tie.
        expect(box.ok(["pick"], { env: ENV })).toBe("m1");
    });

    test("a machine whose snapshot has no queue (an older toli) ranks after every known queue", () => {
        const box = withTasks(remoteSnapshot("m2", { queue: undefined }), 3);
        const pick = JSON.parse(box.ok(["pick", "--json"], { env: ENV })) as Pick;
        expect(pick.machine).toBe("m1");
        expect(pick.candidates.map((candidate) => [candidate.machine, candidate.depth])).toEqual([
            ["m1", 3],
            ["m2", null],
        ]);
        expect(box.ok(["fleet", "status"], { env: ENV })).toContain("m2: available (queue unknown, load 1/8 cpus");
    });
});

describe("fleet queues", () => {
    test("lists every machine shortest first, unreachable last, and suggests a delegation past the gap", () => {
        const box = withTasks(queued(0), 3);
        const lines = box.ok(["fleet", "queues"], { env: ENV }).split("\n");
        expect(lines[0]).toBe("m2: queue 0 (0 queued, 0 running + 0 waiting; 0 active, 0 held), 0 per jawan slot");
        expect(lines[1]).toBe(
            "m1 (this machine): queue 3 (3 queued, 0 running + 0 waiting; 0 active, 0 held), 0.06 per jawan slot",
        );
        expect(lines[2]).toStartWith("m3: unreachable: ssh host3 exited 255");
        expect(lines[3]).toBe(
            "suggestion: m1's queue (3) is 3 deeper than m2's (0); on m1, hand queued work over with " +
                'bin/toli delegate m2 "<title>" --brief <file> [--project <p>]',
        );
        expect(lines).toHaveLength(4);
        const json = JSON.parse(box.ok(["fleet", "queues", "--json"], { env: ENV })) as {
            machines: { machine: string; reachable: boolean; queue: { depth: number } | null }[];
            suggestion: string | null;
        };
        expect(json.machines.map((row) => [row.machine, row.reachable, row.queue?.depth ?? null])).toEqual([
            ["m2", true, 0],
            ["m1", true, 3],
            ["m3", false, null],
        ]);
        expect(json.suggestion).toStartWith("suggestion: m1's queue (3)");
    });

    test("no suggestion while the queues are within lead.balanceGap", () => {
        const box = withTasks(queued(0), 3);
        setLead(box, { balanceGap: 4 });
        const output = box.ok(["fleet", "queues"], { env: ENV });
        expect(output).not.toContain("suggestion");
        setLead(box, { balanceGap: 1.5 });
        expect(box.toli(["fleet", "queues"], { env: ENV }).stderr).toContain(
            "lead.balanceGap must be a positive integer",
        );
    });
});

describe("what counts as queue, and full machines", () => {
    test("active tasks are not queue: a coordinator's bookkeeping does not make it look deep", () => {
        const box = withTasks(queued(1), 3);
        for (const id of ["T1", "T2", "T3"]) box.ok(["task", "start", id, "--agent", "elsewhere"]);
        const resources = JSON.parse(box.ok(["resources", "--json"], { env: ENV })) as { queue: { depth: number } };
        expect(resources.queue).toMatchObject({ queued: 0, active: 3, depth: 0 });
        expect(box.ok(["pick"], { env: ENV })).toBe("m1");
    });

    test("lead full marks this machine full until --clear or --until, published in resources --json", () => {
        const box = withTasks(queued(0), 0);
        expect(box.ok(["lead", "full", "--status"])).toBe("not full: this machine takes work");
        expect(
            box.ok(["lead", "full", "--reason", "earlyoom", "--until", "2h"], { env: { TOLI_NOW: T0 } }),
        ).toStartWith("full: earlyoom (until 2026-11-10T11:00:00.000Z)");
        const at = (now: string): unknown =>
            (
                JSON.parse(box.ok(["resources", "--json"], { env: { ...ENV, TOLI_NOW: now } })) as {
                    queue: { full?: unknown };
                }
            ).queue.full;
        expect(at("2026-11-10T10:59:00.000Z")).toMatchObject({ reason: "earlyoom", until: "2026-11-10T11:00:00.000Z" });
        expect(at("2026-11-10T11:00:00.000Z")).toBeUndefined();
        box.ok(["lead", "full", "--reason", "again"]);
        expect(box.ok(["lead", "full", "--status"])).toBe("full: again (until lead full --clear)");
        expect(box.ok(["lead", "full", "--clear"])).toBe("not full: this machine takes work again");
        expect(box.ok(["lead", "full", "--status"])).toBe("not full: this machine takes work");
        expect(box.toli(["lead", "full", "--until", "soon"]).stderr).toContain(
            '--until takes "30m", "2h" or an ISO time',
        );
    });

    test("a full machine gets no offer and no pick, and fleet queues says it is full", async () => {
        const full = { reason: "earlyoom kills builds", since: T0, until: null };
        const box = withTasks(
            remoteSnapshot("m2", {
                queue: { queued: 0, active: 0, held: 0, jawansRunning: 0, jawansQueued: 0, depth: 0, full },
            }),
            4,
        );
        expect(await pass(box, T0)).toBeNull();
        expect(queueItems(box)).toEqual([]);
        expect(box.ok(["pick"], { env: ENV })).toBe("m1");
        const output = box.ok(["fleet", "queues"], { env: ENV });
        expect(output).toContain("m2: full: earlyoom kills builds; queue 0");
        expect(output).not.toContain("suggestion");
    });

    test("a full machine with an empty queue asks no one for work", async () => {
        const box = fleet(queued(5));
        box.ok(["lead", "full", "--reason", "oom"]);
        expect(await pass(box, T0)).toBeNull();
        expect(inboxSends(box)).toEqual([]);
    });
});

describe("balancePass", () => {
    test("offers queued work to the shortest queue in this machine's own inbox, once per period", async () => {
        const box = withTasks(queued(0), 4);
        const line = await pass(box, T0);
        expect(line).toBe("queue: offered work to m2 (m1 4, m2 0)");
        const [offer, ...more] = queueItems(box);
        expect(more).toEqual([]);
        expect(offer).toStartWith("# queue: offer work to m2\n");
        expect(offer).toContain("m1's queue is 4 deep; m2's is 0");
        expect(offer).toContain("T1: bin/toli delegate m2 'task 1' --brief <file> --project x");
        expect(offer).toContain("T4: bin/toli delegate m2 'task 4' --brief <file> --project x");
        expect(inboxSends(box)).toEqual([]);
        const state = JSON.parse(readFileSync(join(box.root, "state", "lead", "balance.json"), "utf8")) as {
            lastPass: string;
            sent: { kind: string; machine: string }[];
        };
        expect(state.lastPass).toBe(T0);
        expect(state.sent.map((sent) => [sent.kind, sent.machine])).toEqual([["offer", "m2"]]);

        expect(await pass(box, "2026-11-10T09:29:00.000Z")).toBeNull();
        expect(queueItems(box)).toHaveLength(1);
        expect(await pass(box, "2026-11-10T09:30:00.000Z")).toBe("queue: offered work to m2 (m1 4, m2 0)");
        expect(queueItems(box)).toHaveLength(2);
    });

    test("offers and counts only queued tasks no jawan works on and no other machine has", async () => {
        const box = withTasks(queued(0), 5);
        // T4 has a jawan here (its run holds a slot); T5 was delegated to m2 and is still open there.
        const jawans = join(box.root, "state", "jawans");
        mkdirSync(jawans, { recursive: true });
        const run = { id: "j-1", task: "T4", status: "running", supervisorPid: process.pid, pid: process.pid };
        writeFileSync(join(jawans, "j-1.json"), JSON.stringify({ ...run, startedAt: T0 }));
        const backlogPath = join(box.root, "data", "backlog.json");
        const backlog = JSON.parse(readFileSync(backlogPath, "utf8")) as {
            tasks: { id: string; delegatedTo?: string[]; delegates?: Record<string, { status: string }> }[];
        };
        const t5 = backlog.tasks.find((task) => task.id === "T5");
        if (t5 === undefined) throw new Error("no T5");
        t5.delegatedTo = ["m2/T1"];
        t5.delegates = { "m2/T1": { status: "queued" } };
        writeFileSync(backlogPath, JSON.stringify(backlog));

        expect(await pass(box, T0)).toBe("queue: offered work to m2 (m1 4, m2 0)");
        const [offer] = queueItems(box);
        expect(offer).toContain("T3: bin/toli delegate m2 'task 3'");
        expect(offer).not.toContain("T4:");
        expect(offer).not.toContain("T5:");
        expect(box.ok(["fleet", "queues"], { env: ENV })).toContain("m1 (this machine): queue 4 (3 queued, 1 running");
    });

    test("asks the deepest queue's lead for work over ssh when this machine's queue is empty, once per period", async () => {
        const box = fleet(queued(5));
        setLead(box, { balanceMinutes: 10 });
        const line = await pass(box, T0);
        expect(line).toBe("queue: asked m2 for work (m1 0, m2 5; delivered)");
        const sends = inboxSends(box);
        expect(sends).toHaveLength(1);
        expect(sends[0]).toContain("host2");
        expect(sends[0]).toContain("inbox add --from m1 --title 'queue: m1 has an empty queue'");
        expect(queueItems(box)).toEqual([]);

        expect(await pass(box, "2026-11-10T09:09:00.000Z")).toBeNull();
        expect(inboxSends(box)).toHaveLength(1);
        expect(await pass(box, "2026-11-10T09:10:00.000Z")).toStartWith("queue: asked m2 for work");
        expect(inboxSends(box)).toHaveLength(2);
    });

    test("sends nothing while the queues are within the gap", async () => {
        const box = withTasks(queued(1), 3);
        expect(await pass(box, T0)).toBeNull();
        expect(queueItems(box)).toEqual([]);
        expect(inboxSends(box)).toEqual([]);
    });

    test("leaves pinned tasks out of the offer, and posts nothing when every queued task is pinned", async () => {
        const box = withTasks(queued(0), 4);
        box.ok(["task", "pin", "T2", "--reason", "needs local code"]);
        expect(box.ok(["task", "list", "--project", "x"])).toContain("pinned: needs local code");
        expect(await pass(box, T0)).toBe("queue: offered work to m2 (m1 4, m2 0)");
        const [offer] = queueItems(box);
        expect(offer).toContain("T1: bin/toli delegate");
        expect(offer).not.toContain("T2:");
        expect(offer).toContain("T3: bin/toli delegate");

        for (const id of ["T1", "T3", "T4"]) box.ok(["task", "pin", id]);
        expect(await pass(box, "2026-11-10T09:30:00.000Z")).toBeNull();
        expect(queueItems(box)).toHaveLength(1);

        box.ok(["task", "unpin", "T2"]);
        const tasks = JSON.parse(box.ok(["task", "list", "--json"])) as { id: string; pinned?: string }[];
        expect(tasks.find((task) => task.id === "T2")?.pinned).toBeUndefined();
        expect(tasks.find((task) => task.id === "T1")?.pinned).toBe("");
        expect(await pass(box, "2026-11-10T10:00:00.000Z")).toBe("queue: offered work to m2 (m1 4, m2 0)");
        expect(queueItems(box).filter((item) => item.includes("T2: bin/toli delegate"))).toHaveLength(1);
    });

    test("is null without other fleet machines, and rejects bad lead settings", async () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        expect(await pass(box, T0)).toBeNull();
        expect(existsSync(join(box.root, "state", "lead", "balance.json"))).toBe(false);

        const fleetBox = fleet(queued(5));
        const failure = (): Promise<string> =>
            pass(fleetBox, T0).then(
                () => "resolved",
                (error: unknown) => String(error),
            );
        setLead(fleetBox, { balanceMinutes: 0 });
        expect(await failure()).toContain("lead.balanceMinutes must be a positive number");
        setLead(fleetBox, { balanceGap: 0 });
        expect(await failure()).toContain("lead.balanceGap must be a positive integer");
        expect(inboxSends(fleetBox)).toEqual([]);
    });
});
