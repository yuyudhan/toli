// T1783: an active task whose jawan died (a reboot, a dead lead session) is re-dispatched by the tick once, with the
// same brief and the answers recorded since; a second death holds it.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editBacklog, ROOMY } from "./fleet-fixture.ts";
import { type Sandbox, sandbox, withProject } from "./helpers.ts";

const START = "2026-03-04T08:00:00.000Z";
const BLOCKER = "j-20260304-075900-aaaa";
const DEAD = "j-20260304-080000-bbbb";
const BRIEF = "TOLI_BRIEF v1\n\n# T1: build the report page\n";
/** What a run whose supervisor died with the machine records (src/jawans/death.ts orphanCause). */
const ORPHANED =
    "the supervisor exited without recording an outcome: no cause found in the journal or the logs; its harness (pid 999999) is gone too";

type RunRecord = { id: string; status: string; resumeOf?: string; resumeReason?: string; briefPath: string };
type TaskRecord = { id: string; status: string; agent?: string; question?: string; notes: string[] };

/**
 * Coordinator m1 with project alpha cloned and one jawan slot, held by a live run under this test process, so a
 * re-dispatch stays queued and nothing runs.
 */
function machine(): Sandbox {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    withProject(box, "alpha");
    const config = join(box.root, "config", "machine.json");
    const current = JSON.parse(readFileSync(config, "utf8")) as Record<string, unknown>;
    writeFileSync(config, JSON.stringify({ ...current, capacity: { ...ROOMY, maxRuns: 1 } }));
    box.stub("omp", "true");
    spawnRun(box, BLOCKER, { status: "running", supervisorPid: process.pid, pid: process.pid });
    return box;
}

/** A `bin/toli spawn` run record with its run dir and briefs. */
function spawnRun(box: Sandbox, id: string, fields: Record<string, unknown>): void {
    const dir = join(box.root, "state", "jawans");
    const runDir = join(dir, id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "brief.base.md"), BRIEF);
    writeFileSync(join(runDir, "brief.md"), BRIEF);
    writeFileSync(
        join(dir, `${id}.json`),
        JSON.stringify({
            id,
            harness: "omp",
            task: null,
            project: null,
            work: null,
            model: null,
            cwd: join(box.root, "projects", "alpha"),
            runDir,
            briefPath: join(runDir, "brief.md"),
            logPath: join(runDir, "output.log"),
            command: "omp",
            maxMinutes: null,
            status: "failed",
            supervisorPid: null,
            pid: null,
            exitCode: null,
            signal: null,
            startedAt: START,
            endedAt: null,
            inbox: null,
            error: null,
            ...fields,
        }),
    );
}

function runs(box: Sandbox): RunRecord[] {
    const dir = join(box.root, "state", "jawans");
    return readdirSync(dir)
        .filter((file) => file.endsWith(".json"))
        .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as RunRecord);
}

function task(box: Sandbox, id: string): TaskRecord {
    const tasks = JSON.parse(box.ok(["task", "list", "--json"])) as TaskRecord[];
    const found = tasks.find((entry) => entry.id === id);
    if (found === undefined) throw new Error(`no task ${id}`);
    return found;
}

function inbox(box: Sandbox): string[] {
    const dir = join(box.root, "data", "inbox");
    return readdirSync(dir).map((file) => readFileSync(join(dir, file), "utf8"));
}

/** T1 on alpha, worked by run DEAD (recorded with `fields`), and T2's answer recorded after it ended. */
function deadTask(box: Sandbox, fields: Record<string, unknown>): void {
    box.ok(["task", "add", "alpha", "build the report page"]);
    box.ok(["task", "add", "alpha", "pick the database"]);
    spawnRun(box, DEAD, { task: "T1", project: "alpha", endedAt: "2026-03-04T08:10:00.000Z", ...fields });
    box.ok(["task", "start", "T1", "--agent", DEAD], { now: START });
    box.ok(["task", "hold", "T2", "--question", "postgres or sqlite?"], { now: START });
    box.ok(["task", "answer", "T2", "postgres"], { now: "2026-03-04T08:20:00.000Z" });
}

describe("the tick re-dispatches a task whose jawan died, once", () => {
    test("a run that died with its machine is continued with its brief and the answers since; a second death holds it", () => {
        const box = machine();
        deadTask(box, { error: ORPHANED });
        box.ok(["job", "tick"], { now: "2026-03-04T09:00:00.000Z" });
        const next = runs(box).find((run) => run.resumeOf === DEAD);
        expect(next).toMatchObject({ status: "queued", resumeReason: "died" });
        const brief = readFileSync(next?.briefPath ?? "", "utf8");
        expect(brief).toStartWith(BRIEF.trimEnd());
        expect(brief).toContain(`The previous run of this brief (${DEAD}) died: ${ORPHANED} without writing a report.`);
        expect(brief).toContain("was started by toli, once, because the run died");
        expect(brief).toContain('- T2 (2026-03-04T08:20:00.000Z): "postgres"');
        expect(task(box, "T1")).toMatchObject({ status: "active", agent: next?.id });
        expect(inbox(box).some((item) => item.includes("active task has no live run"))).toBe(false);
        expect(readFileSync(join(box.root, "logs", "tick.log"), "utf8")).toContain(
            `T1: re-dispatched as ${next?.id} (queued)`,
        );

        // The re-dispatched run dies too (killed by a signal toli did not send): the task is held, not re-dispatched.
        const record = join(box.root, "state", "jawans", `${next?.id}.json`);
        const died = {
            status: "failed",
            signal: "SIGKILL",
            error: "killed by SIGKILL",
            endedAt: "2026-03-04T09:01:00.000Z",
        };
        writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, "utf8")), ...died }));
        const before = runs(box).length;
        box.ok(["job", "tick"], { now: "2026-03-04T09:30:00.000Z" });
        expect(runs(box)).toHaveLength(before);
        const held = task(box, "T1");
        expect(held.status).toBe("held");
        expect(held.question).toContain(`T1's jawan died: killed by SIGKILL, after toli had re-dispatched it once`);
    });

    test("a subagent that died with its lead session gets a spawn run of the task's brief and the answers since", async () => {
        const box = machine();
        box.ok(["task", "add", "alpha", "build the report page"]);
        box.ok(["task", "add", "alpha", "pick the database"]);
        const briefs = join(box.root, "data", "projects", "alpha", "briefs");
        mkdirSync(briefs, { recursive: true });
        writeFileSync(join(briefs, "T1.md"), BRIEF);
        box.ok(["task", "start", "T1", "--agent", "T11Sub"], { now: START });
        const session = Bun.spawn(["true"]);
        await session.exited;
        editBacklog(box, (tasks) => {
            const t1 = tasks.find((entry) => entry.id === "T1");
            if (t1 !== undefined) t1.agentSession = { agent: "T11Sub", pid: session.pid };
        });
        box.ok(["task", "hold", "T2", "--question", "postgres or sqlite?"], { now: START });
        box.ok(["task", "answer", "T2", "postgres"], { now: "2026-03-04T08:20:00.000Z" });
        box.ok(["job", "tick"], { now: "2026-03-04T09:00:00.000Z" });
        const next = runs(box).find((run) => run.id !== BLOCKER);
        expect(next).toMatchObject({ status: "queued" });
        const brief = readFileSync(next?.briefPath ?? "", "utf8");
        expect(brief).toStartWith(BRIEF.trimEnd());
        expect(brief).toContain("## RE-DISPATCHED (toli, once)");
        expect(brief).toContain(
            `The previous jawan on T1 stopped before writing its report: its agent T11Sub died with its lead session ${session.pid}.`,
        );
        expect(brief).toContain('- T2 (2026-03-04T08:20:00.000Z): "postgres"');
        const t1 = task(box, "T1");
        expect(t1).toMatchObject({ status: "active", agent: next?.id });
        expect(t1.notes.at(-1)).toContain(`re-dispatched by toli as ${next?.id}`);
    });

    test("a run that failed on its own is left to the lead: posted as stale, never re-dispatched", () => {
        const box = machine();
        deadTask(box, { error: "the harness printed only errors, no report", exitCode: 1 });
        box.ok(["job", "tick"], { now: "2026-03-04T09:00:00.000Z" });
        expect(runs(box).some((run) => run.resumeOf === DEAD)).toBe(false);
        expect(task(box, "T1")).toMatchObject({ status: "active", agent: DEAD });
        expect(inbox(box).some((item) => item.startsWith("# 1 active task has no live run"))).toBe(true);
    });

    test("a machine marked full re-dispatches nothing", () => {
        const box = machine();
        deadTask(box, { error: ORPHANED });
        box.ok(["lead", "full", "--reason", "coordination only"]);
        box.ok(["job", "tick"], { now: "2026-03-04T09:00:00.000Z" });
        expect(runs(box).some((run) => run.resumeOf === DEAD)).toBe(false);
        expect(task(box, "T1")).toMatchObject({ status: "active", agent: DEAD });
    });
});
