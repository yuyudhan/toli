import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    continuePrompt,
    deadlineSection,
    hasReport,
    onlyHarnessErrors,
    resumeSection,
    usedTimeLimit,
} from "../src/jawans/limits.ts";
import { CPU_PROGRESS_SECONDS, parseCpuTime, rootExited, StallWatch, treeCpuSeconds } from "../src/jawans/progress.ts";
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
    resumeReason?: string;
    resumeSession?: string;
    sessionDir?: string;
    maxMinutes: number | null;
    command: string;
};

/** One limit minute lasts a second, so a `--max-time 1` run reaches its limit after one second. */
const FAST = { TOLI_RUN_MINUTE_MS: "1000" };
const NOISE = 'echo "Warning: MCP server \\"atlassian\\" failed to connect: HTTP 401"; echo "Working..."';

/**
 * An omp stand-in that logs its argv. A fresh run writes a session file into its `--session-dir` and then hangs with no
 * output, CPU or file change (a stall); a run given `--resume <file>` appends to that file and reports.
 */
function sessionOmp(argvLog: string): string {
    return [
        'dir=""; resume=""; prev=""',
        'for arg in "$@"; do',
        '    case "$prev" in --session-dir) dir="$arg" ;; --resume) resume="$arg" ;; esac',
        '    prev="$arg"',
        "done",
        `printf '%s\\n---\\n' "$*" >> "${argvLog}"`,
        'if [ -n "$resume" ]; then echo "{}" >> "$resume"; echo "Malik, the work is done and committed as abc123."; exit 0; fi',
        'echo "{}" > "$dir/s1.jsonl"',
        NOISE,
        "exec sleep 30",
    ].join("\n");
}

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
    test("harness warnings and errors are no report; any other line is", () => {
        expect(hasReport("")).toBe(false);
        expect(hasReport('Warning: MCP server "kalki" failed to connect\nWorking...\n\n')).toBe(false);
        expect(hasReport("Warning: MCP server x failed\nWorking...\nMalik, T93 is done: abc123.\n")).toBe(true);
        // A harness or API error is never the jawan's answer, whatever surrounds it.
        const errors = 'Warning: x\nError: 429 rate_limit_error\nAPI Error: 500 {"type":"error"}\n';
        expect(hasReport(errors)).toBe(false);
        expect(hasReport("Claude AI usage limit reached|1767225600\n")).toBe(false);
        expect(hasReport(`${errors}Malik, T93 is done: abc123.\n`)).toBe(true);
        expect([onlyHarnessErrors(errors), onlyHarnessErrors(""), onlyHarnessErrors(`${errors}done\n`)]).toEqual([
            true,
            false,
            false,
        ]);
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
            stopped: "hit its 180-minute time limit",
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

describe("stall detection", () => {
    test("ps CPU times parse on Linux and macOS, summed over the process tree", () => {
        expect(parseCpuTime("00:01:05")).toBe(65);
        expect(parseCpuTime("1-00:00:01")).toBe(86_401);
        expect(parseCpuTime("0:02.50")).toBe(2.5);
        expect(parseCpuTime("garbage")).toBeNull();
        const ps = [
            "  10     1 0:10.00 S",
            "  11    10 0:05.00 R",
            "  12    11 1:00.00 S+",
            "  13     1 9:00.00 Z",
        ].join("\n");
        expect(treeCpuSeconds(ps, 10)).toBe(75);
        // A harness that exited (gone, or a zombie not yet reaped) is ending on its own, never stalled.
        expect([rootExited(ps, 10), rootExited(ps, 13), rootExited(ps, 99)]).toEqual([false, true, true]);
    });

    test("a run is stalled only after nothing moved for the whole stall time", () => {
        const watch = new StallWatch(1000, 0, CPU_PROGRESS_SECONDS);
        expect(watch.observe({ marks: "a", cpuSeconds: 0 }, 0)).toBe(false);
        expect(watch.observe({ marks: "a", cpuSeconds: 0 }, 900)).toBe(false);
        // New output resets the clock.
        expect(watch.observe({ marks: "b", cpuSeconds: 0 }, 950)).toBe(false);
        expect(watch.observe({ marks: "b", cpuSeconds: 1 }, 1900)).toBe(false);
        // Busy CPU (a build the run waits on) is progress; a trickle of idle CPU is not.
        expect(watch.observe({ marks: "b", cpuSeconds: CPU_PROGRESS_SECONDS + 1 }, 2800)).toBe(false);
        expect(watch.observe({ marks: "b", cpuSeconds: CPU_PROGRESS_SECONDS + 2 }, 3700)).toBe(false);
        expect(watch.observe({ marks: "b", cpuSeconds: CPU_PROGRESS_SECONDS + 2 }, 3800)).toBe(true);
    });

    test("a spawned run has no wall-clock limit by default and keeps its omp session in its run dir", () => {
        const box = coordinator({ maxRuns: 2 });
        box.stub("omp", 'echo "Malik, done."');
        const run = spawnJson(box, ["--harness", "omp", "--brief", brief(box, "x"), "--cwd", box.root]);
        expect(run.maxMinutes).toBeNull();
        expect(run.command).not.toContain("--max-time");
        expect(run.command).toContain(`--session-dir ${run.sessionDir}`);
        expect(readFileSync(run.briefPath, "utf8")).not.toContain("## Deadline (auto)");
    });

    test("a run that stops making progress is stopped and resumed in its own omp session", async () => {
        const box = coordinator({ maxRuns: 2, stallMinutes: 1 });
        withProject(box, "alpha");
        box.ok(["task", "add", "alpha", "long work", "--shape", "scout"]);
        const argvLog = join(box.root, ".argv");
        box.stub("omp", sessionOmp(argvLog));
        const first = spawnJson(box, ["--harness", "omp", "--task", "T1", "--brief", brief(box, "build it")]);
        const all = await waitForRuns(box, (list) => list.length === 2 && list.every((run) => run.inbox !== null));
        const [second, stalled] = all as [Run, Run];
        expect(stalled.id).toBe(first.id);
        expect(stalled.status).toBe("stalled");
        expect(stalled.error).toContain("no progress for 1 minutes");
        expect(stalled.resumedBy).toBe(second.id);
        expect(second.status).toBe("done");
        expect(second.resumeOf).toBe(first.id);
        expect(second.resumeReason).toBe("stalled");
        expect(second.sessionDir).toBe(first.sessionDir);
        expect(second.resumeSession).toBe(join(first.sessionDir ?? "", "s1.jsonl"));
        const calls = readFileSync(argvLog, "utf8").split("\n---\n");
        expect(calls[1]).toContain(`--session-dir ${first.sessionDir} --resume ${second.resumeSession}`);
        expect(calls[1]).toContain("TOLI_BRIEF v1\n## RESUME (auto, 1)");
        expect(calls[1]).not.toContain("build it");
        expect(readFileSync(second.resumeSession ?? "", "utf8")).toBe("{}\n{}\n");
        const backlog = JSON.parse(readFileSync(join(box.root, "data", "backlog.json"), "utf8")) as {
            tasks: { id: string; notes: string[] }[];
        };
        const notes = backlog.tasks.find((entry) => entry.id === "T1")?.notes ?? [];
        expect(notes.some((note) => note.includes(`resumed in the same session as ${second.id}`))).toBe(true);
    }, 60_000);

    test("the lead resumes a finished run's session with `bin/toli resume`, adding its note", async () => {
        const box = coordinator({ maxRuns: 2 });
        const argvLog = join(box.root, ".argv");
        box.stub(
            "omp",
            [
                'dir=""; prev=""',
                'for arg in "$@"; do [ "$prev" = "--session-dir" ] && dir="$arg"; prev="$arg"; done',
                `printf '%s\\n---\\n' "$*" >> "${argvLog}"`,
                'echo "{}" >> "$dir/s1.jsonl"',
                'echo "Malik, done."',
            ].join("\n"),
        );
        const first = spawnJson(box, ["--harness", "omp", "--brief", brief(box, "x"), "--cwd", box.root]);
        await waitForRuns(box, (list) => list.every((run) => run.inbox !== null));
        const next = JSON.parse(
            box.ok(["resume", first.id, "--note", "Also update the docs.", "--json"], { env: FAST }),
        ) as Run;
        expect(next.resumeOf).toBe(first.id);
        expect(next.resumeReason).toBe("lead");
        expect(next.resumeSession).toBe(join(first.sessionDir ?? "", "s1.jsonl"));
        const prompt = readFileSync(next.briefPath, "utf8");
        expect(prompt).toStartWith("TOLI_BRIEF v1\n## RESUME (lead, 1)");
        expect(prompt).toContain("Also update the docs.");
        await waitForRuns(box, (list) => list.length === 2 && list.every((run) => run.inbox !== null));
        expect(readFileSync(argvLog, "utf8")).toContain(`--resume ${next.resumeSession}`);
        expect(box.toli(["resume", first.id]).stderr).toContain(`already continued by ${next.id}`);
    }, 60_000);

    test("the continue prompt keeps the jawan header and names why the run stopped", () => {
        const prompt = continuePrompt({
            number: 2,
            cap: 3,
            previousRun: "j-1",
            stopped: "stalled (no progress for 30 minutes)",
            cwd: "/w/p",
            previousLog: "/t/j-1/output.log",
        });
        expect(prompt.split("\n")[0]).toBe("TOLI_BRIEF v1");
        expect(prompt).toContain("Your run j-1 stalled (no progress for 30 minutes) before you wrote your report.");
        expect(prompt).toContain("automatic continuation 2 of at most 3");
        expect(hasReport("[toli] no progress for 30 minutes: stopping the run\n")).toBe(false);
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
    // An omp stand-in that holds its slot until `release` exists, however slowly the next spawns run under load.
    const gatedOmp = (release: string): string => `until [ -f "${release}" ]; do sleep 0.1; done; echo finished`;

    test("spawn above capacity.maxRuns queues the run; it starts when a slot frees, oldest first", async () => {
        const box = coordinator({ maxRuns: 1 });
        const release = join(box.root, "release");
        box.stub("omp", gatedOmp(release));
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
        writeFileSync(release, "");

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
        const release = join(box.root, "release");
        box.stub("omp", gatedOmp(release));
        const args = ["--harness", "omp", "--cwd", box.root, "--brief", brief(box, "x")];
        const first = spawnJson(box, args);
        const queued = spawnJson(box, args);
        expect(queued.status).toBe("queued");
        expect(box.ok(["run", "kill", queued.id])).toBe(`killed ${queued.id} (omp) before it started`);
        writeFileSync(release, "");
        await waitForRuns(box, (list) => list.find((run) => run.id === first.id)?.inbox !== null);
        // A killed run is never claimed from the queue, so its status stays killed after the slot frees.
        const killed = JSON.parse(box.ok(["run", "status", queued.id, "--json"])) as Run;
        expect(killed.status).toBe("killed");
        expect(killed.error).toBe("killed while queued; it never started");
        expect(killed.inbox).toBeNull();
    });
});
