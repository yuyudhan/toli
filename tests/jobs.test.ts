import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadMachine } from "../src/core/config.ts";
import { beginJob, dueJobs, finishJob, jobSubcommands, loadJobState } from "../src/jobs/jobs.ts";
import { commandIn, inProcess, type Sandbox, sandbox } from "./helpers.ts";

type Due = { name: string }[];
type Begun = { runId: string; prompt: string };

function hourlyJob(): Sandbox {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    box.ok(["job", "add", "hourly", "--cron", "0 * * * *", "--prompt", "check things"], { now: "2026-03-04T10:00:30" });
    return box;
}

const due = (box: Sandbox, now: string): string[] =>
    (JSON.parse(box.ok(["job", "due", "--json"], { now })) as Due).map((job) => job.name);

describe("job due", () => {
    test("not due before its first window, due after it", () => {
        const box = hourlyJob();
        expect(due(box, "2026-03-04T10:59:00")).toEqual([]);
        expect(due(box, "2026-03-04T11:00:10")).toEqual(["hourly"]);
    });

    test("a long missed stretch catches up once, not once per window", () => {
        const box = hourlyJob();
        expect(due(box, "2026-03-04T15:10:00")).toEqual(["hourly"]);
        const begun = JSON.parse(
            box.ok(["job", "begin", "hourly", "--via", "session", "--json"], { now: "2026-03-04T15:10:00" }),
        ) as Begun;
        box.ok(["job", "finish", "hourly", begun.runId], { stdin: "done", now: "2026-03-04T15:11:00" });
        expect(due(box, "2026-03-04T15:20:00")).toEqual([]);
        expect(due(box, "2026-03-04T16:00:00")).toEqual(["hourly"]);
    });

    test("not due while running, and never begun twice", () => {
        const box = hourlyJob();
        box.ok(["job", "begin", "hourly", "--via", "session", "--json"], { now: "2026-03-04T11:00:00" });
        expect(due(box, "2026-03-04T12:01:00")).toEqual([]);
        expect(box.toli(["job", "begin", "hourly", "--via", "headless"], { now: "2026-03-04T12:01:00" }).code).toBe(1);
    });

    test("job for another machine is never due here; paused jobs are not due", () => {
        const box = hourlyJob();
        box.ok(["job", "add", "elsewhere", "--cron", "* * * * *", "--prompt", "x", "--machine", "m2"], {
            now: "2026-03-04T10:00:30",
        });
        box.ok(["job", "pause", "hourly"]);
        expect(due(box, "2026-03-04T12:00:00")).toEqual([]);
    });
});

describe("job begin/finish", () => {
    test("finish writes the result with its header, clears running, and shows until ack", () => {
        const box = hourlyJob();
        const begun = JSON.parse(
            box.ok(["job", "begin", "hourly", "--via", "session", "--json"], { now: "2026-03-04T11:00:05" }),
        ) as Begun;
        expect(begun.prompt.startsWith(`[toli job hourly ${begun.runId}]`)).toBe(true);
        expect(begun.prompt).toContain(`bin/toli job finish hourly ${begun.runId}`);
        expect(begun.prompt).toContain("check things");
        const path = box.ok(["job", "finish", "hourly", begun.runId], {
            stdin: "all green\n",
            now: "2026-03-04T11:03:00",
        });
        const text = readFileSync(path, "utf8");
        for (const line of [
            "- job: hourly",
            `- runId: ${begun.runId}`,
            "- machine: m1",
            "- via: session",
            "- status: ok",
            "all green",
        ]) {
            expect(text).toContain(line);
        }
        const state = JSON.parse(readFileSync(join(box.root, "state", "jobs.json"), "utf8")) as {
            jobs: Record<string, { running?: unknown }>;
        };
        expect(state.jobs.hourly?.running).toBeUndefined();
        expect(box.toli(["job", "finish", "hourly", begun.runId], { stdin: "again" }).code).toBe(1);
        expect((JSON.parse(box.ok(["job", "results", "--unseen", "--json"])) as unknown[]).length).toBe(1);
        box.ok(["job", "ack"]);
        expect((JSON.parse(box.ok(["job", "results", "--unseen", "--json"])) as unknown[]).length).toBe(0);
    });
});

describe("job tick", () => {
    function tickBox(): Sandbox {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        box.ok(["job", "add", "every", "--cron", "* * * * *", "--prompt", "ping"], { now: "2026-03-04T10:00:30" });
        box.stub("omp", `echo "$@" > "${join(box.root, "omp-args")}"\necho "stub omp output"`);
        return box;
    }

    // T2030: a 4-minute job ran 2 h on a swapping machine; headless runs had no time limit at all.
    test("a headless run still going at its job's deadline is stopped and its result says timed-out, not ok", () => {
        const box = tickBox();
        box.ok(["job", "add", "slow", "--cron", "0 0 1 1 *", "--prompt", "work", "--max-minutes", "1"]);
        box.stub("omp", "exec sleep 60");
        const started = Date.now();
        // One run-minute is 500 ms here: the 1-minute deadline hits long before the 60 s sleep ends.
        const said = box.ok(["job", "run", "slow"], { env: { TOLI_RUN_MINUTE_MS: "500" } });
        expect(Date.now() - started).toBeLessThan(30_000);
        expect(said).toContain("(deadline 1 min; stopped sooner if it stalls)");
        expect(said).toMatch(/stopped: timed out after 1 min \(maxMinutes in config\/jobs\.json\), timed out, result /);
        const results = JSON.parse(box.ok(["job", "results", "--json"])) as { status: string; path: string }[];
        expect(results.map((result) => result.status)).toEqual(["timed-out"]);
        const text = readFileSync(results[0]?.path ?? "", "utf8");
        expect(text).toContain("- status: timed-out");
        expect(text).toContain("Timed out: omp was still running at this job's deadline of 1 min");
    });

    test("job add takes --max-minutes <n>|none; a job without one gets the 30-minute default", () => {
        const box = tickBox();
        box.ok(["job", "add", "long", "--cron", "0 0 * * *", "--prompt", "x", "--max-minutes", "none"]);
        box.ok(["job", "add", "short", "--cron", "0 0 * * *", "--prompt", "x", "--max-minutes", "5"]);
        const listed = box.ok(["job", "list"]).split("\n");
        expect(listed.find((line) => line.startsWith("long\t"))).toContain("deadline=none");
        expect(listed.find((line) => line.startsWith("short\t"))).toContain("deadline=5m");
        expect(listed.find((line) => line.startsWith("every\t"))).not.toContain("deadline");
        for (const bad of ["0", "1.5", "soon"])
            expect(
                box.toli(["job", "add", "bad", "--cron", "0 0 * * *", "--prompt", "x", "--max-minutes", bad]).stderr,
            ).toContain("--max-minutes must be a whole number of minutes (at least 1) or none");
        expect(box.ok(["job", "run", "every"])).toContain("(deadline 30 min; stopped sooner if it stalls)");
    });

    test("leaves due jobs to a live interactive session", () => {
        const box = tickBox();
        box.ok(["session", "start", "--pid", String(process.pid)]);
        box.ok(["job", "tick"], { now: "2026-03-04T10:05:00" });
        expect(existsSync(join(box.root, "omp-args"))).toBe(false);
        expect(readFileSync(join(box.root, "logs", "tick.log"), "utf8")).toContain(`live session pid ${process.pid}`);
        expect(due(box, "2026-03-04T10:05:00")).toEqual(["every"]);
    });

    test("runs due jobs headless when the live session has left its wakes unread past lead.idleSessionMinutes", () => {
        const box = tickBox();
        box.ok(["session", "start", "--pid", String(process.pid)], { now: "2026-03-04T09:00:00" });
        box.ok(["inbox", "add", "--from", "m2", "--title", "unread"], { stdin: "body", now: "2026-03-04T09:01:00" });
        box.ok(["job", "tick"], { now: "2026-03-04T10:05:00" });
        expect(readFileSync(join(box.root, "omp-args"), "utf8")).toContain("[toli job every");
        expect(readFileSync(join(box.root, "logs", "tick.log"), "utf8")).toContain(
            `interactive session pid ${process.pid} has left wakes unread since 2026-03-04T`,
        );
        expect(existsSync(join(box.root, "state", "session.json"))).toBe(true);
    });

    test("run-due runs due jobs headless even with a live session, claiming each once", () => {
        const box = tickBox();
        box.ok(["session", "start", "--pid", String(process.pid)]);
        box.ok(["job", "run-due"], { now: "2026-03-04T10:05:00" });
        // A scout job runs on the standard tier's model (src/harness/models.ts), with no time limit.
        const args = readFileSync(join(box.root, "omp-args"), "utf8");
        expect(args).toContain("--model claude-sonnet-5-5 [toli job every");
        expect(args).not.toContain("--max-time");
        expect(readFileSync(join(box.root, "logs", "tick.log"), "utf8")).toContain("started headless (session)");
        const results = JSON.parse(box.ok(["job", "results", "--json"])) as { status: string }[];
        expect(results.map((result) => result.status)).toEqual(["ok"]);
        rmSync(join(box.root, "omp-args"));
        box.ok(["job", "run-due"], { now: "2026-03-04T10:05:30" });
        expect(existsSync(join(box.root, "omp-args"))).toBe(false);
    });

    test("runs due jobs headless when the session pid is dead, recording the output", () => {
        const box = tickBox();
        const child = Bun.spawnSync(["true"]);
        box.ok(["session", "start", "--pid", String(child.pid)]);
        box.ok(["job", "tick"], { now: "2026-03-04T10:05:00" });
        const args = readFileSync(join(box.root, "omp-args"), "utf8");
        expect(args).toContain(
            `-p --wait-async --cwd ${box.root} --no-title --approval-mode yolo --session-dir ${join(box.root, "state", "job-sessions")}/`,
        );
        expect(args).toContain("--model claude-sonnet-5-5 [toli job every");
        expect(args).not.toContain("--max-time");
        expect(existsSync(join(box.root, "state", "session.json"))).toBe(false);
        const results = readdirSync(join(box.root, "data", "jobs", "every"));
        expect(results.length).toBe(1);
        const text = readFileSync(join(box.root, "data", "jobs", "every", results[0] as string), "utf8");
        expect(text).toContain("- via: headless");
        expect(text).toContain("stub omp output");
        expect(due(box, "2026-03-04T10:05:30")).toEqual([]);
    });

    test("marks runs stuck for over 3h as failed", () => {
        const box = tickBox();
        box.ok(["job", "begin", "every", "--via", "session"], { now: "2026-03-04T10:01:00" });
        box.ok(["session", "start", "--pid", String(process.pid)]);
        box.ok(["job", "tick"], { now: "2026-03-04T13:02:00" });
        const results = JSON.parse(box.ok(["job", "results", "--json"])) as { status: string }[];
        expect(results.map((result) => result.status)).toEqual(["failed"]);
    });

    test("keeps a failed run's omp session for its resume hint, deletes an ok run's, and prune removes old ones", () => {
        const box = tickBox();
        const exitFlag = join(box.root, "omp-exit");
        box.stub(
            "omp",
            [
                'while [ "$#" -gt 0 ]; do if [ "$1" = --session-dir ]; then dir="$2"; fi; shift; done',
                'mkdir -p "$dir" && echo "{}" > "$dir/s1.jsonl"',
                'echo "[Recovery] Main: omp --resume s1"',
                `exit "$(cat "${exitFlag}" 2>/dev/null || echo 0)"`,
            ].join("\n"),
        );
        const sessions = join(box.root, "state", "job-sessions");
        const resultText = (): string => {
            const dir = join(box.root, "data", "jobs", "every");
            const newest = readdirSync(dir).sort().at(-1) as string;
            return readFileSync(join(dir, newest), "utf8");
        };
        box.ok(["job", "run", "every"], { now: "2026-03-04T10:05:00" });
        expect(existsSync(sessions) ? readdirSync(sessions) : []).toEqual([]);
        expect(resultText()).not.toContain("Session kept");

        writeFileSync(exitFlag, "1");
        box.ok(["job", "run", "every"], { now: "2026-03-04T10:06:00" });
        const kept = readdirSync(sessions);
        expect(kept.length).toBe(1);
        const file = join(sessions, kept[0] as string, "s1.jsonl");
        expect(existsSync(file)).toBe(true);
        expect(resultText()).toContain(`--session-dir ${join(sessions, kept[0] as string)} --resume ${file}`);

        type Pruned = { items: { kind: string; target: string }[] };
        const fresh = JSON.parse(box.ok(["prune", "--json"])) as Pruned;
        expect(fresh.items.filter((item) => item.kind === "job-session")).toEqual([]);
        const later = JSON.parse(box.ok(["prune", "--apply", "--json"], { now: "2099-01-01T00:00:00" })) as Pruned;
        expect(later.items.filter((item) => item.kind === "job-session").map((item) => item.target)).toEqual([
            join("state", "job-sessions", kept[0] as string),
        ]);
        expect(readdirSync(sessions)).toEqual([]);
    });
});

describe("worker outbox", () => {
    test("undelivered results retry on tick and are delivered exactly once", () => {
        const box = sandbox();
        box.ok([
            "init",
            "--name",
            "w1",
            "--role",
            "worker",
            "--coordinator-ssh",
            "coord",
            "--coordinator-root",
            "/srv/toli",
        ]);
        const flag = join(box.root, "ssh-fail");
        const log = join(box.root, "ssh-log");
        box.stub(
            "ssh",
            `if [ -e "${flag}" ]; then echo unreachable >&2; exit 255; fi\necho "DELIVERY $*" >> "${log}"\ncat >> "${log}"`,
        );
        writeFileSync(flag, "1");
        box.ok(["job", "add", "nightly", "--cron", "0 3 * * *", "--prompt", "x"]);
        const begun = JSON.parse(box.ok(["job", "begin", "nightly", "--via", "session", "--json"])) as Begun;
        box.ok(["job", "finish", "nightly", begun.runId], { stdin: "report body" });
        expect(readdirSync(join(box.root, "state", "outbox")).length).toBe(1);
        expect(existsSync(log)).toBe(false);

        type DoctorCheck = { level: string; name: string; detail: string };
        const outboxCheck = (): DoctorCheck | undefined =>
            (JSON.parse(box.toli(["doctor", "--json"]).stdout) as DoctorCheck[]).find(
                (check) => check.name === "outbox",
            );
        const pending = outboxCheck();
        expect(pending?.level).toBe("warn");
        expect(pending?.detail).toContain("1 result waiting in state/outbox/");
        expect(pending?.detail).toContain("ssh coord true");

        rmSync(flag);
        box.ok(["job", "tick"]);
        box.ok(["job", "tick"]);
        const delivered = readFileSync(log, "utf8");
        expect(delivered.match(/^DELIVERY /gm)?.length).toBe(1);
        expect(delivered).toContain("bin/toli inbox add --from w1 --title 'job nightly'");
        expect(delivered).toContain("report body");
        expect(readdirSync(join(box.root, "state", "outbox")).length).toBe(0);
        expect(outboxCheck()).toEqual({
            level: "ok",
            name: "outbox",
            detail: "no results waiting for the coordinator",
        });
    });
});

describe("job finish --quiet", () => {
    type Result = { status: string; unseen: boolean; quiet: boolean; path: string };
    const run = (box: Sandbox, flags: string[], body: string, now: string): void => {
        const begun = JSON.parse(box.ok(["job", "begin", "hourly", "--via", "headless", "--json"], { now })) as Begun;
        box.ok(["job", "finish", "hourly", begun.runId, ...flags], { stdin: body, now });
    };

    test("records an idle run without an unseen result or a wake; a failed quiet run still posts", () => {
        const box = hourlyJob();
        run(box, ["--quiet"], "nothing waiting", "2026-03-04T11:01:00Z");
        const recorded = JSON.parse(box.ok(["job", "results", "--json"])) as Result[];
        expect(recorded).toMatchObject([{ status: "ok", unseen: false, quiet: true }]);
        expect(readFileSync(recorded[0]?.path ?? "", "utf8")).toContain("nothing waiting");
        const listed = JSON.parse(box.ok(["job", "list", "--json"])) as { state: object }[];
        expect(listed[0]?.state).toMatchObject({ lastStatus: "ok", lastFinished: "2026-03-04T11:01:00.000Z" });
        expect(JSON.parse(box.ok(["job", "results", "--unseen", "--json"]))).toEqual([]);
        expect(box.ok(["digest"])).toContain("unseen job results (0):");
        expect((JSON.parse(box.ok(["wake", "--json"])) as { items: unknown[] }).items).toEqual([]);

        run(box, ["--quiet", "--status", "failed"], "broke", "2026-03-04T12:01:00Z");
        const unseen = JSON.parse(box.ok(["job", "results", "--unseen", "--json"])) as Result[];
        expect(unseen).toMatchObject([{ status: "failed", unseen: true, quiet: false }]);
        const woken = JSON.parse(box.ok(["wake", "--json"])) as { items: { title: string }[] };
        expect(woken.items.map((item) => item.title)).toEqual(["job hourly (failed)"]);
    });

    test("on a worker, a quiet run sends no fleet copy; a failed quiet run does", () => {
        const box = sandbox();
        box.ok(["init", "--name", "w1", "--role", "worker", "--coordinator-ssh", "coord", "--coordinator-root", "/x"]);
        box.stub("ssh", "echo unreachable >&2; exit 255");
        box.ok(["job", "add", "hourly", "--cron", "0 * * * *", "--prompt", "x"], { now: "2026-03-04T10:00:30Z" });
        const outbox = join(box.root, "state", "outbox");
        run(box, ["--quiet"], "nothing waiting", "2026-03-04T11:01:00Z");
        expect(existsSync(outbox) ? readdirSync(outbox) : []).toEqual([]);
        expect((JSON.parse(box.ok(["job", "results", "--json"])) as unknown[]).length).toBe(1);
        run(box, ["--quiet", "--status", "failed"], "broke", "2026-03-04T12:01:00Z");
        expect(readdirSync(outbox).length).toBe(1);
    });
});

describe("a job's schedule and prompt (in process)", () => {
    test("due only on its machine and outside a run; the prompt carries the run id, shape rules and finish line", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const NOW = { TOLI_NOW: "2026-03-04T10:00:30" };
        const add = commandIn(box.root, jobSubcommands.add, NOW);
        expect(add(["hourly", "--cron", "0 * * * *", "--prompt", "check things"])).toBe("added job hourly (0 * * * *)");
        add(["release", "--cron", "0 * * * *", "--prompt", "ship it", "--shape", "ship"]);
        add(["elsewhere", "--cron", "0 * * * *", "--prompt", "not here", "--machine", "m2"]);
        expect(() => add(["hourly", "--cron", "0 * * * *", "--prompt", "again"])).toThrow(
            'job "hourly" already exists',
        );
        expect(() => add(["bad", "--cron", "0 * * * *", "--prompt", "x", "--shape", "big"])).toThrow(
            "--shape must be scout or ship",
        );
        const dueAt = (at: string): string[] => {
            let names: string[] = [];
            inProcess(box.root, () => {
                names = dueJobs(new Date(at), loadMachine()).map((job) => job.name);
            });
            return names;
        };
        expect(dueAt("2026-03-04T10:59:00")).toEqual([]);
        expect(dueAt("2026-03-04T11:00:10")).toEqual(["hourly", "release"]);
        let scout = "";
        let ship = "";
        inProcess(
            box.root,
            () => {
                scout = beginJob("hourly", "session").prompt;
                ship = beginJob("release", "headless").prompt;
            },
            { TOLI_NOW: "2026-03-04T11:00:10" },
        );
        const runId = /^\[toli job hourly (\d{8}T\d{6}Z-[0-9a-f]{6})\]$/m.exec(scout)?.[1];
        if (runId === undefined) throw new Error(`no run id in: ${scout}`);
        expect(scout).toContain(`Scheduled toli job "hourly" on machine m1 (run ${runId}, via session).`);
        expect(scout).toContain("- This is a scout job: read and report only; do not edit files.");
        expect(scout).toContain(`bin/toli job finish hourly ${runId} <<'EOF'`);
        expect(ship).toContain("use `bin/toli commit <project>");
        expect(ship).toContain("via headless");
        expect(dueAt("2026-03-04T12:00:10")).toEqual([]);
        inProcess(box.root, () => finishJob("hourly", runId, "all good", "ok"), { TOLI_NOW: "2026-03-04T11:05:00" });
        inProcess(box.root, () => {
            expect(loadJobState().hourly).toMatchObject({ lastStatus: "ok" });
            expect(loadJobState().hourly?.running).toBeUndefined();
        });
        expect(dueAt("2026-03-04T12:00:10")).toEqual(["hourly"]);
    });
});
