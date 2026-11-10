import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENV, fleet, remoteSnapshot } from "./fleet-fixture.ts";
import { type Sandbox, SSH_STUB_ARGS, sandbox, withProject } from "./helpers.ts";

const START = "2026-03-04T08:00:00.000Z";

function coordinator(): Sandbox {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    withProject(box, "alpha");
    return box;
}

/** The Next block's lines after its `Next (n):` header. */
function next(text: string): string[] {
    const lines = text.split("\n");
    return lines.slice(lines.findIndex((line) => line.startsWith("Next (")) + 1);
}

function inbox(box: Sandbox): string[] {
    const dir = join(box.root, "data", "inbox");
    return existsSync(dir)
        ? readdirSync(dir)
              .sort()
              .map((file) => readFileSync(join(dir, file), "utf8"))
        : [];
}

/**
 * A `bin/toli remote` record from before `- task:`: the task is named only by the brief's heading. `output` lines come
 * before `lastLine`; `started` also names the file.
 */
function legacyRemoteRecord(
    box: Sandbox,
    task: string,
    finished: string,
    lastLine: string,
    output: string[] = ["merged 3 branches"],
    started: string = START,
): void {
    const dir = join(box.root, "data", "projects", "alpha", "runs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, `${started.replace(/[:.]/g, "-")}-m2.md`),
        [
            "# remote m2",
            "",
            "- from: m1",
            "- to: m2 (host2:/srv/toli)",
            "- project: alpha",
            `- started: ${started}`,
            `- finished: ${finished}`,
            "- exit: 0",
            "",
            "## Prompt",
            "",
            "TOLI_BRIEF v1",
            `# Task ${task}: integrate and push`,
            "",
            "## Output",
            "",
            ...output,
            lastLine,
            "",
        ].join("\n"),
    );
}

describe("a remote agent naming its run on the target", () => {
    test("an earlier killed dispatch's record never makes it stale; only its own run's record does", () => {
        const box = coordinator();
        box.stub("omp", "true");
        box.ok(["task", "add", "alpha", "slice"]);
        box.ok(["task", "start", "T1", "--agent", "remote:m2:j-20260304-080130-3049"], { now: "2026-03-04T08:01:30Z" });
        // The first dispatch (run c7c9) was killed and its record written after the second dispatch was recorded.
        legacyRemoteRecord(box, "T1", "2026-03-04T08:02:00.000Z", "[Stopped by SIGTERM]", [
            "--- stderr ---",
            "exec: recorded as run j-20260304-080000-c7c9 on m2 (from m1), omp x (deep)",
        ]);
        expect(box.ok(["digest"], { now: "2026-03-04T09:00:00.000Z" })).not.toContain("T1 (alpha) is active");
        legacyRemoteRecord(
            box,
            "T1",
            "2026-03-04T08:40:00.000Z",
            "done: committed abc1234",
            ["--- stderr ---", "exec: recorded as run j-20260304-080130-3049 on m2 (from m1), omp x (deep)"],
            "2026-03-04T08:01:29.000Z",
        );
        expect(next(box.ok(["digest"], { now: "2026-03-04T09:00:00.000Z" }))[0]).toStartWith(
            '  - T1 (alpha) is active but its run remote:m2:j-20260304-080130-3049 ended 20m ago (data/projects/alpha/runs/2026-03-04T08-01-29-000Z-m2.md); last report line: "done: committed abc1234"',
        );
    });
});

describe("active tasks with no live run", () => {
    test("a remote run that ended is named at the top of Next after the grace minutes, with its last line and the answer since", () => {
        const box = coordinator();
        box.stub("omp", "true");
        box.ok(["task", "add", "alpha", "integrate and push"]);
        box.ok(["task", "add", "alpha", "audit speed"]);
        box.ok(["task", "start", "T1", "--agent", "remote:m2:bg_7"], { now: START });
        box.ok(["task", "hold", "T2", "--question", "budget 45 ms or 20 ms?"], { now: START });
        legacyRemoteRecord(box, "T1", "2026-03-04T08:20:00.000Z", "waiting on the answer to question 45");
        box.ok(["task", "answer", "T2", "45 ms"], { now: "2026-03-04T08:30:00.000Z" });

        // Within oversight.staleTaskMinutes (15) of the run's end it is not flagged yet.
        expect(box.ok(["digest"], { now: "2026-03-04T08:30:00.000Z" })).not.toContain("T1 (alpha) is active");
        const text = box.ok(["digest"], { now: "2026-03-04T09:00:00.000Z" });
        expect(next(text)[0]).toBe(
            '  - T1 (alpha) is active but its run remote:m2:bg_7 ended 40m ago (data/projects/alpha/runs/2026-03-04T08-00-00-000Z-m2.md); last report line: "waiting on the answer to question 45"; answer recorded since: T2 "45 ms": re-dispatch it now (bin/toli spawn --task T1 --brief <file>, or bin/toli task start T1 --agent <id>), or hold/drop/done it',
        );

        // Re-dispatching it clears the finding: the old run finished before the new agent was recorded.
        box.ok(["task", "start", "T1", "--agent", "remote:m2:bg_8"], { now: "2026-03-04T09:01:00.000Z" });
        expect(box.ok(["digest"], { now: "2026-03-04T09:30:00.000Z" })).not.toContain("T1 (alpha) is active");
    });

    test("the tick posts each newly stale task to the inbox once per ended run", () => {
        const box = coordinator();
        box.ok(["task", "add", "alpha", "integrate and push"]);
        box.ok(["task", "start", "T1", "--agent", "remote:m2:bg_7"], { now: START });
        legacyRemoteRecord(box, "T1", "2026-03-04T08:20:00.000Z", "waiting on the answer to question 45");
        const before = inbox(box).length;
        box.ok(["job", "tick"], { now: "2026-03-04T09:00:00.000Z" });
        const stale = inbox(box).filter((item) => item.startsWith("# 1 active task has no live run"));
        expect(stale).toHaveLength(1);
        expect(stale[0]).toContain("- T1 (alpha) is active but its run remote:m2:bg_7 ended 40m ago");
        expect(stale[0]).toContain('last report line: "waiting on the answer to question 45"');
        expect(stale[0]).toContain("re-dispatch it now (bin/toli spawn --task T1");
        box.ok(["job", "tick"], { now: "2026-03-04T09:01:00.000Z" });
        expect(inbox(box).filter((item) => item.startsWith("# 1 active task has no live run"))).toHaveLength(1);
        expect(inbox(box).length).toBeGreaterThan(before);
    });

    test("a pre-cutover remote --task record names its task, so its end is seen without a brief heading", () => {
        const box = fleet(remoteSnapshot("m2"));
        box.stub("omp", "true");
        withProject(box, "alpha");
        box.ok(["task", "add", "alpha", "ship it"]);
        box.ok(["task", "start", "T1", "--agent", "remote:m2:bg_1"], { env: ENV, now: START });
        // As `remote m2 "do the work" --task t1` wrote it before remote refused (docs/sardars.md).
        mkdirSync(join(box.root, "data", "remote"), { recursive: true });
        writeFileSync(
            join(box.root, "data", "remote", "2026-03-04T08-05-00-000Z-m2.md"),
            [
                "# remote m2",
                "",
                "- from: m1",
                "- to: m2 (host2:/srv/toli)",
                "- task: T1",
                "- started: 2026-03-04T08:05:00.000Z",
                "- finished: 2026-03-04T08:05:00.000Z",
                "- exit: 0",
                "",
                "## Prompt",
                "",
                "do the work",
                "",
                "## Output",
                "",
                "ran on m2",
                "",
            ].join("\n"),
        );
        expect(next(box.ok(["digest"], { env: ENV, now: "2026-03-04T08:30:00.000Z" }))[0]).toStartWith(
            '  - T1 (alpha) is active but its run remote:m2:bg_1 ended 25m ago (data/remote/2026-03-04T08-05-00-000Z-m2.md); last report line: "ran on m2"; no answer recorded since',
        );
    });
});

describe("answers reach the waiting work", () => {
    test("task answer names every task waiting on the hold, with briefs, and posts it as a wake", () => {
        const box = coordinator();
        for (const title of ["pick db", "build store", "migrate", "report"]) box.ok(["task", "add", "alpha", title]);
        box.ok(["task", "hold", "T1", "--question", "postgres or sqlite?", "--blocks", "T2 and the T3 migration"]);
        box.ok(["task", "hold", "T4", "--question", "resume when T1 is decided"]);
        const briefs = join(box.root, "data", "projects", "alpha", "briefs");
        mkdirSync(briefs, { recursive: true });
        writeFileSync(join(briefs, "T1.md"), "brief");
        writeFileSync(join(briefs, "T2-store.md"), "brief");

        const printed = box.ok(["task", "answer", "T1", "postgres"]).split("\n");
        expect(printed.slice(1)).toEqual([
            "unblocked: dispatch T1 now (toli-dispatch skill; put the answer in its brief, data/projects/alpha/briefs/T1.md)",
            "waiting on T1: T2 (alpha, queued): build store - named in T1's blocks; re-dispatch it now (brief: data/projects/alpha/briefs/T2-store.md)",
            "waiting on T1: T3 (alpha, queued): migrate - named in T1's blocks; re-dispatch it now",
            "waiting on T1: T4 (alpha, held): report - its hold names T1; re-dispatch it now",
            expect.stringMatching(/^wake posted: data\/inbox\/.*-m1\.md$/),
        ]);
        const [wake] = inbox(box);
        expect(wake).toStartWith("# answer recorded for T1: 4 tasks to dispatch\n");
        expect(wake).toContain(
            '- T1 (alpha, queued) answered "postgres": dispatch it now (brief: data/projects/alpha/briefs/T1.md)',
        );
        expect(wake).toContain("- waiting on T1: T4 (alpha, held): report - its hold names T1");
        const wakeText = box.ok(["wake"]);
        expect(wakeText).toContain("[toli wake] 1 new result arrived.");
        expect(wakeText).toContain("answer recorded for T1");
    });
});

describe("oversight never pauses in away mode", () => {
    test("fleet check names idle machines with waiting work for their clones, and each machine's stale tasks", () => {
        const box = fleet(remoteSnapshot("m2", { projects: ["alpha"] }));
        box.stub("omp", "true");
        withProject(box, "alpha");
        box.ok(["task", "add", "alpha", "queued slice"]);
        writeFileSync(
            join(box.root, ".m2-check.json"),
            JSON.stringify({
                machine: "m2",
                stale: [{ line: "T9 (alpha) is active but its run j-1 ended 3h ago", command: "re-dispatch it now" }],
                waiting: [{ id: "T9", project: "alpha", status: "active", title: "own slice" }],
            }),
        );
        box.stub(
            "ssh",
            [
                SSH_STUB_ARGS,
                'case "$host" in',
                `  host2) case "$cmd" in *"resources --json"*) cat "${join(box.root, ".m2.json")}" ;; *"fleet check --local --json"*) cat "${join(box.root, ".m2-check.json")}" ;; *) exit 1 ;; esac ;;`,
                "  *) echo 'ssh: connect to host host3 port 22: Connection refused' >&2; exit 255 ;;",
                "esac",
            ].join("\n"),
        );
        writeFileSync(join(box.root, "state", "afk"), START);

        const output = box.ok(["fleet", "check", "--wake"], { env: ENV, now: "2026-03-04T09:00:00.000Z" });
        expect(output.split("\n").slice(0, 2)).toEqual([
            "fleet check at 2026-03-04T09:00:00.000Z: 1 active task with no live run, 2 idle machines with waiting work",
            "Lead: dispatch now (toli-dispatch skill), spreading the waiting work over the idle machines; away mode changes nothing here.",
        ]);
        expect(output).toContain("- [m2] T9 (alpha) is active but its run j-1 ended 3h ago\n  re-dispatch it now");
        expect(output).toContain("- m1: T1 (alpha, queued): queued slice\n");
        expect(output).toContain("- m2: T1 (alpha, queued): queued slice; T9 (alpha, active): own slice\n");
        expect(output).toMatch(/- m3: unreachable: ssh host3 exited 255/);
        const [posted] = inbox(box);
        expect(posted).toStartWith("# fleet check: 1 stale task, 2 idle machines with waiting work\n");
    });

    test("the coordinator's tick runs the fleet check hourly while away, instead of staying silent", () => {
        const box = coordinator();
        box.ok(["task", "add", "alpha", "queued slice"]);
        writeFileSync(join(box.root, "state", "afk"), START);
        box.ok(["job", "tick"], { now: "2026-03-04T09:00:00.000Z" });
        const checks = (): string[] => inbox(box).filter((item) => item.startsWith("# fleet check:"));
        expect(checks()).toHaveLength(1);
        expect(checks()[0]).toContain("- m1: T1 (alpha, queued): queued slice");
        expect(readFileSync(join(box.root, "logs", "tick.log"), "utf8")).toContain("fleet check: posted data/inbox/");
        box.ok(["job", "tick"], { now: "2026-03-04T09:30:00.000Z" });
        expect(checks()).toHaveLength(1);
        box.ok(["job", "tick"], { now: "2026-03-04T10:00:00.000Z" });
        expect(checks()).toHaveLength(2);
    });
});

/** A `bin/toli spawn` run record; `supervisorPid` is this test process, so a running run counts as alive. */
function spawnRun(box: Sandbox, id: string, fields: Record<string, unknown>): void {
    const dir = join(box.root, "state", "jawans");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, `${id}.json`),
        JSON.stringify({
            id,
            harness: "omp",
            task: null,
            project: null,
            work: null,
            model: null,
            cwd: box.root,
            runDir: join(dir, id),
            briefPath: join(dir, id, "brief.md"),
            logPath: join(dir, id, "output.log"),
            command: "omp",
            maxMinutes: null,
            status: "running",
            supervisorPid: process.pid,
            pid: process.pid,
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

describe("live runs without a task id, and tasks that wait", () => {
    test("a task whose recorded run, or that run's continuation, is alive is live even when the run has no task id", () => {
        const box = coordinator();
        box.stub("omp", "true");
        box.ok(["task", "add", "alpha", "restarted by hand"]);
        box.ok(["task", "add", "alpha", "resumed chain"]);
        spawnRun(box, "j-20260304-080000-aaaa", {});
        spawnRun(box, "j-20260304-080000-bbbb", {
            status: "stalled",
            endedAt: "2026-03-04T08:10:00.000Z",
            resumedBy: "j-20260304-081000-cccc",
        });
        spawnRun(box, "j-20260304-081000-cccc", { resumeOf: "j-20260304-080000-bbbb" });
        box.ok(["task", "start", "T1", "--agent", "j-20260304-080000-aaaa"], { now: START });
        box.ok(["task", "start", "T2", "--agent", "j-20260304-080000-bbbb"], { now: START });
        expect(box.ok(["digest"], { now: "2026-03-04T10:00:00.000Z" })).not.toContain("is active but");
        // `task start --agent` records the task on a run spawned without --task.
        const run = JSON.parse(readFileSync(join(box.root, "state", "jawans", "j-20260304-080000-aaaa.json"), "utf8"));
        expect([run.task, run.project]).toEqual(["T1", "alpha"]);
    });

    test("a task that waits on something is reported as waiting, never as needing a re-dispatch, and never posted", () => {
        const box = coordinator();
        box.stub("omp", "true");
        box.ok(["task", "add", "alpha", "land after T9"]);
        spawnRun(box, "j-20260304-080000-dddd", { status: "done", endedAt: "2026-03-04T08:10:00.000Z" });
        box.ok(["task", "start", "T1", "--agent", "j-20260304-080000-dddd"], { now: START });
        box.ok(["task", "wait", "T1", "--on", "a deferred spawn after T9"], { now: START });
        const text = box.ok(["digest"], { now: "2026-03-04T10:00:00.000Z" });
        expect(next(text)[0]).toBe(
            "  - T1 (alpha) is active, waiting on a deferred spawn after T9: nothing to dispatch while it waits; once that is through it gets a jawan (bin/toli task start T1 --agent <id>) or moves on by itself",
        );
        expect(text).not.toContain("re-dispatch it now");
        box.ok(["job", "tick"], { now: "2026-03-04T10:00:00.000Z" });
        expect(inbox(box).some((item) => item.includes("no live run"))).toBe(false);
        // A new jawan ends the wait.
        box.ok(["task", "start", "T1", "--agent", "j-20260304-080000-dddd"], { now: "2026-03-04T10:01:00.000Z" });
        expect(box.ok(["digest"], { now: "2026-03-04T10:30:00.000Z" })).toContain("T1 (alpha) is active but its run");
    });
});
