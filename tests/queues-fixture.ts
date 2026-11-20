// Shared by tests/queues.test.ts and tests/verify-only.test.ts: a coordinator m1 with queued tasks, m2's snapshot, and
// the lead service's balancing pass run in this process.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { balancePass } from "../src/fleet/queues.ts";
import { ENV, fleet, remoteSnapshot } from "./fleet-fixture.ts";
import { GIT_ENV, type Sandbox, withProject } from "./helpers.ts";

export const T0 = "2026-11-10T09:00:00.000Z";

/** `machine`'s snapshot with a clone of project x and a queue of `depth` queued tasks. */
export function queuedOn(machine: string, depth: number, overrides: Record<string, unknown> = {}): string {
    return remoteSnapshot(machine, {
        projects: ["x"],
        queue: { queued: depth, active: 0, held: 0, jawansRunning: 0, jawansQueued: 0, depth },
        ...overrides,
    });
}

/** m2's snapshot with a clone of project x and a queue of `depth` queued tasks. */
export function queued(depth: number, overrides: Record<string, unknown> = {}): string {
    return queuedOn("m2", depth, overrides);
}

/** Coordinator m1 with project x registered (and cloned) and `tasks` queued tasks on it. */
export function withTasks(m2Snapshot: string, tasks: number): Sandbox {
    const box = fleet(m2Snapshot);
    withProject(box, "x");
    for (let n = 1; n <= tasks; n++) box.ok(["task", "add", "x", `task ${n}`]);
    return box;
}

/** Merge `lead` settings into m1's config/machine.json. */
export function setLead(box: Sandbox, lead: Record<string, unknown>): void {
    const path = join(box.root, "config", "machine.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), lead }));
}

/** Run the lead service's balancing pass in this process as `box`'s machine at `at`, with its stubs on PATH. */
export async function pass(box: Sandbox, at: string): Promise<string | null> {
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
export function queueItems(box: Sandbox): string[] {
    const dir = join(box.root, "data", "inbox");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .map((file) => readFileSync(join(dir, file), "utf8"))
        .filter((text) => text.startsWith("# queue:"));
}
