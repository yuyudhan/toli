// config/machine.json `lead.dispatch: "subagents"` (src/fleet/dispatch.ts): a headless lead turn starts no jawan.
// The headless prompt and the unread wake items are covered in lead.test.ts.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, withProject } from "./helpers.ts";
import { brief, coordinator, type Run, runs, spawnJson, waitFor } from "./jawan-fixture.ts";

// Several bin/toli processes and detached runs per test; on a loaded machine that passes Bun's 5 s default.
setDefaultTimeout(30_000);

const HEADLESS = { TOLI_LEAD_TURN: "headless" };

/** Merge `settings` into m1's config/machine.json. */
function configure(box: Sandbox, settings: Record<string, unknown>): void {
    const path = join(box.root, "config", "machine.json");
    const machine = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...machine, ...settings }));
}

function subagentsOnly(): Sandbox {
    const box = coordinator();
    withProject(box, "alpha");
    box.ok(["task", "add", "alpha", "look around", "--shape", "scout"]);
    box.stub("omp", "true");
    configure(box, { lead: { dispatch: "subagents" } });
    return box;
}

function status(box: Sandbox, id: string): string {
    const run = JSON.parse(box.ok(["run", "status", id, "--json"])) as Run;
    return run.status;
}

describe('lead.dispatch "subagents"', () => {
    test("a headless lead turn may neither spawn nor resume, and is told to leave the work unread", () => {
        const box = subagentsOnly();
        const refused = box.toli(["spawn", "--harness", "omp", "--task", "T1", "--brief", brief(box)], {
            env: HEADLESS,
        });
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain('refusing to spawn: config/machine.json lead.dispatch is "subagents"');
        expect(refused.stderr).toContain("Leave the item unacknowledged");
        expect(box.toli(["resume", "j-20260101-000000-dead"], { env: HEADLESS }).stderr).toContain(
            'refusing to resume: config/machine.json lead.dispatch is "subagents"',
        );
        expect(runs(box)).toEqual([]);
        expect(box.ok(["task", "list"])).toBe("T1\tqueued\talpha\tscout\tlook around");
    });

    test("the interactive Sardar still spawns, and a headless turn spawns again under dispatch spawn", async () => {
        const box = subagentsOnly();
        const own = spawnJson(box, ["--harness", "omp", "--task", "T1", "--brief", brief(box)]);
        expect(own.task).toBe("T1");
        await waitFor(box, own.id, (run) => run.inbox !== null);
        configure(box, { lead: { dispatch: "spawn" } });
        const headless = box.ok(["spawn", "--harness", "omp", "--task", "T1", "--brief", brief(box), "--json"], {
            env: HEADLESS,
        });
        expect((JSON.parse(headless) as Run).task).toBe("T1");
    });

    test("an unknown value is refused by name", () => {
        const box = subagentsOnly();
        configure(box, { lead: { dispatch: "native" } });
        expect(
            box.toli(["spawn", "--harness", "omp", "--task", "T1", "--brief", brief(box)], { env: HEADLESS }).stderr,
        ).toContain('config/machine.json lead.dispatch must be "spawn" or "subagents"');
    });

    test("a headless lead turn starts no queued run; the tick outside it does", async () => {
        const box = coordinator();
        configure(box, { capacity: { maxRuns: 1 } });
        const release = join(box.root, "release");
        // Holds its slot until `release` exists, however slowly the next spawns run under load.
        box.stub("omp", `until [ -f "${release}" ]; do sleep 0.1; done; echo finished`);
        const args = ["--harness", "omp", "--cwd", box.root, "--brief", brief(box, "x")];
        const first = spawnJson(box, args);
        const queued = spawnJson(box, args);
        expect(queued.status).toBe("queued");
        // A second slot frees for the queued run, and only the interactive Sardar's subagents may run jawans.
        configure(box, { capacity: { maxRuns: 2 }, lead: { dispatch: "subagents" } });
        box.ok(["job", "tick"], { env: HEADLESS });
        expect(readFileSync(join(box.root, "logs", "tick.log"), "utf8")).toContain(
            'queued jawan runs not started: refusing to start queued runs: config/machine.json lead.dispatch is "subagents"',
        );
        expect(status(box, queued.id)).toBe("queued");

        box.ok(["job", "tick"]);
        expect(status(box, queued.id)).not.toBe("queued");
        writeFileSync(release, "");
        for (const id of [first.id, queued.id]) {
            const done = await waitFor(box, id, (run) => run.inbox !== null);
            expect(done.status).toBe("done");
        }
    });
});
