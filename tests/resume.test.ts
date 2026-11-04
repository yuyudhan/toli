import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deadlineSection, hasReport, resumeSection, usedTimeLimit } from "../src/jawans/limits.ts";
import { type Sandbox, sandbox, withProject } from "./helpers.ts";

type Run = {
    id: string;
    status: string;
    task: string | null;
    briefPath: string;
    startedAt: string;
    endedAt: string | null;
    inbox: string | null;
    error: string | null;
    queuedAt?: string;
    resumeOf?: string;
    resumeCount?: number;
    resumedBy?: string;
};

/** One limit minute lasts a second, so a `--max-time 1` run reaches its limit after one second. */
const FAST = { TOLI_RUN_MINUTE_MS: "1000" };
const NOISE = 'echo "Warning: MCP server \\"atlassian\\" failed to connect: HTTP 401"; echo "Working..."';

function coordinator(capacity: Record<string, number>): Sandbox {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    const file = join(box.root, "config", "machine.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), capacity }));
    return box;
}

function brief(box: Sandbox, body: string): string {
    const path = join(box.root, "brief.md");
    writeFileSync(path, `TOLI_BRIEF v1\n${body}\n`);
    return path;
}

function runs(box: Sandbox): Run[] {
    return JSON.parse(box.ok(["runs", "--json"])) as Run[];
}

function spawnJson(box: Sandbox, args: string[]): Run {
    return JSON.parse(box.ok(["spawn", ...args, "--json"], { env: FAST })) as Run;
}

function inboxTitles(box: Sandbox): string[] {
    const dir = join(box.root, "data", "inbox");
    return readdirSync(dir)
        .sort()
        .map((file) => readFileSync(join(dir, file), "utf8").split("\n")[0] ?? "");
}

/**
 * Poll until `done` holds over every run, failing after ~30 s. Real time is unavoidable: supervisors and harnesses are
 * detached OS processes, so there is no in-process event to await.
 */
async function waitForRuns(box: Sandbox, done: (all: Run[]) => boolean): Promise<Run[]> {
    for (let attempt = 0; attempt < 300; attempt++) {
        const all = runs(box);
        if (done(all)) return all;
        await Bun.sleep(100);
    }
    throw new Error(`runs never reached the expected state: ${box.ok(["runs"])}`);
}

describe("time limits", () => {
    test("only harness warnings are no report; any other line is", () => {
        expect(hasReport("")).toBe(false);
        expect(hasReport('Warning: MCP server "kalki" failed to connect\nWorking...\n\n')).toBe(false);
        expect(hasReport("Warning: MCP server x failed\nWorking...\nMalik, T93 is done: abc123.\n")).toBe(true);
    });

    test("a run used its limit when killed for time or after 95% of it", () => {
        expect(usedTimeLimit(180 * 60_000, 180, 60_000, false)).toBe(true);
        expect(usedTimeLimit(171 * 60_000, 180, 60_000, false)).toBe(true);
        expect(usedTimeLimit(170 * 60_000, 180, 60_000, false)).toBe(false);
        expect(usedTimeLimit(1000, 180, 60_000, true)).toBe(true);
    });

    test("the deadline names the limit and asks for the report 10 minutes before it", () => {
        const section = deadlineSection(new Date("2026-11-04T10:00:00Z"), 180, 60_000);
        expect(section).toContain("## Deadline (auto)");
        expect(section).toContain("180-minute time limit, at ");
        expect(section).toContain("(2026-11-04T13:00:00.000Z)");
        expect(section).toContain("by ");
        expect(section).toContain("(2026-11-04T12:50:00.000Z), 10 minutes before the limit");
        // A short limit asks for the report halfway instead.
        expect(deadlineSection(new Date("2026-11-04T10:00:00Z"), 4, 60_000)).toContain(
            "(2026-11-04T10:02:00.000Z), 2 minutes before the limit",
        );
        expect(deadlineSection(new Date("2026-11-04T10:00:00Z"), 1, 60_000)).toContain(
            "(2026-11-04T10:00:30.000Z), 0.5 minutes before the limit",
        );
    });

    test("the RESUME section names the previous run, its log and the uncommitted work", () => {
        const section = resumeSection({
            number: 2,
            cap: 3,
            previousRun: "j-1",
            maxMinutes: 180,
            cwd: "/w/kalki",
            previousLog: "/t/runs/j-1/output.log",
        });
        expect(section).toContain("## RESUME (auto, 2)");
        expect(section).toContain("(j-1) hit its 180-minute time limit without writing a report");
        expect(section).toContain("continuation 2 of at most 3");
        expect(section).toContain("uncommitted in the working tree, /w/kalki");
        expect(section).toContain("Its log: /t/runs/j-1/output.log");
    });
});

describe("auto-resume", () => {
    test("a run stopped by its limit without a report continues up to the cap, then the inbox says so", async () => {
        const box = coordinator({ maxRuns: 2, autoResume: 2 });
        withProject(box, "alpha");
        box.ok(["task", "add", "alpha", "look around", "--shape", "scout"]);
        box.stub("omp", `${NOISE}; sleep 1.2`);
        const first = spawnJson(box, [
            "--harness",
            "omp",
            "--task",
            "T1",
            "--max-time",
            "1",
            "--brief",
            brief(box, "inspect"),
        ]);
        const all = await waitForRuns(
            box,
            (list) => list.length === 3 && list.every((run) => run.inbox !== null) && inboxTitles(box).length === 4,
        );
        const [second, third] = [all[1], all[0]] as [Run, Run];
        expect(all.map((run) => run.status)).toEqual(["time-limit", "time-limit", "time-limit"]);
        expect(second.resumeOf).toBe(first.id);
        expect(second.resumeCount).toBe(1);
        expect(third.resumeOf).toBe(second.id);
        expect(third.resumeCount).toBe(2);
        expect(third.resumedBy).toBeUndefined();

        const resumed = readFileSync(second.briefPath, "utf8");
        expect(resumed.startsWith("TOLI_BRIEF v1\ninspect\n")).toBe(true);
        expect(resumed).toContain(
            `## RESUME (auto, 1)\n\nThe previous run of this brief (${first.id}) hit its 1-minute`,
        );
        expect(resumed).toContain("output.log");
        expect(resumed).toContain("## Deadline (auto)");
        // Each continuation carries only its own RESUME section and deadline.
        const last = readFileSync(third.briefPath, "utf8");
        expect(last).toContain("## RESUME (auto, 2)");
        expect(last).not.toContain("## RESUME (auto, 1)");
        expect(last.match(/## Deadline \(auto\)/g)?.length).toBe(1);

        const first2 = JSON.parse(box.ok(["run", "status", first.id, "--json"])) as Run;
        expect(first2.resumedBy).toBe(second.id);
        expect(readFileSync(first2.inbox ?? "", "utf8")).toContain(`- continued by: ${second.id}`);
        expect(box.ok(["task", "list"])).toContain(`(agent: ${third.id})`);
        const titles = inboxTitles(box);
        expect(titles.filter((title) => title.includes("time-limit: omp T1 (alpha)")).length).toBe(3);
        expect(titles).toContain(`# jawan ${third.id} not resumed: auto-resume limit reached for T1 (alpha)`);
    }, 60_000);

    test("a run that wrote its report at the limit is not resumed", async () => {
        const box = coordinator({ maxRuns: 2 });
        box.stub("omp", `${NOISE}; sleep 1.2; echo "Malik, the work is done and committed as abc123."`);
        const started = spawnJson(box, [
            "--harness",
            "omp",
            "--max-time",
            "1",
            "--brief",
            brief(box, "x"),
            "--cwd",
            box.root,
        ]);
        const [done] = await waitForRuns(box, (list) => list.every((run) => run.inbox !== null));
        expect(done?.id).toBe(started.id);
        expect(done?.status).toBe("done");
        expect(done?.resumedBy).toBeUndefined();
        // A continuation is recorded before the outcome is posted, so with the inbox set there would be one by now.
        expect(runs(box).length).toBe(1);
    });
});

describe("jawan slots", () => {
    test("spawn above capacity.maxRuns queues the run; it starts when a slot frees, oldest first", async () => {
        const box = coordinator({ maxRuns: 1 });
        box.stub("omp", "sleep 1; echo finished");
        const args = ["--harness", "omp", "--cwd", box.root, "--brief", brief(box, "x")];
        const first = spawnJson(box, args);
        expect(["starting", "running"]).toContain(first.status);
        const queuedText = box.ok(["spawn", ...args]);
        expect(queuedText).toContain("all 1 jawan slots (capacity.maxRuns) are busy");
        const third = spawnJson(box, args);
        expect(third.status).toBe("queued");
        expect(third.queuedAt).toBe(third.startedAt);
        expect(
            box
                .ok(["runs", "--active"])
                .split("\n")
                .filter((line) => line.includes("\tqueued\t")).length,
        ).toBe(2);
        // The lead's --now bypasses the queue.
        const urgent = spawnJson(box, [...args, "--now"]);
        expect(["starting", "running"]).toContain(urgent.status);

        const all = await waitForRuns(box, (list) => list.length === 4 && list.every((run) => run.inbox !== null));
        expect(all.every((run) => run.status === "done")).toBe(true);
        const byId = new Map(all.map((run) => [run.id, run]));
        const second = all.find((run) => run.id !== first.id && run.id !== third.id && run.id !== urgent.id);
        const firstDone = byId.get(first.id);
        const thirdDone = byId.get(third.id);
        // Never two queued runs at once with one slot: the second starts after the first ends, the third after it.
        expect(Date.parse(second?.startedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(firstDone?.endedAt ?? ""));
        expect(Date.parse(thirdDone?.startedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(second?.endedAt ?? ""));
    }, 60_000);

    test("a queued run killed before it starts never runs", async () => {
        const box = coordinator({ maxRuns: 1 });
        box.stub("omp", "sleep 1");
        const args = ["--harness", "omp", "--cwd", box.root, "--brief", brief(box, "x")];
        const first = spawnJson(box, args);
        const queued = spawnJson(box, args);
        expect(queued.status).toBe("queued");
        expect(box.ok(["run", "kill", queued.id])).toBe(`killed ${queued.id} (omp) before it started`);
        await waitForRuns(box, (list) => list.find((run) => run.id === first.id)?.inbox !== null);
        // A killed run is never claimed from the queue, so its status stays killed after the slot frees.
        const killed = JSON.parse(box.ok(["run", "status", queued.id, "--json"])) as Run;
        expect(killed.status).toBe("killed");
        expect(killed.error).toBe("killed while queued; it never started");
        expect(killed.inbox).toBeNull();
    });
});
