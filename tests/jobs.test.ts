import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, sandbox } from "./helpers.ts";

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
        expect(box.mate(["job", "begin", "hourly", "--via", "headless"], { now: "2026-03-04T12:01:00" }).code).toBe(1);
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
        expect(begun.prompt.startsWith(`[mate job hourly ${begun.runId}]`)).toBe(true);
        expect(begun.prompt).toContain(`bin/mate job finish hourly ${begun.runId}`);
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
        expect(box.mate(["job", "finish", "hourly", begun.runId], { stdin: "again" }).code).toBe(1);
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

    test("leaves due jobs to a live interactive session", () => {
        const box = tickBox();
        box.ok(["session", "start", "--pid", String(process.pid)]);
        box.ok(["job", "tick"], { now: "2026-03-04T10:05:00" });
        expect(existsSync(join(box.root, "omp-args"))).toBe(false);
        expect(readFileSync(join(box.root, "logs", "tick.log"), "utf8")).toContain(`live session pid ${process.pid}`);
        expect(due(box, "2026-03-04T10:05:00")).toEqual(["every"]);
    });

    test("runs due jobs headless when the session pid is dead, recording the output", () => {
        const box = tickBox();
        const child = Bun.spawnSync(["true"]);
        box.ok(["session", "start", "--pid", String(child.pid)]);
        box.ok(["job", "tick"], { now: "2026-03-04T10:05:00" });
        const args = readFileSync(join(box.root, "omp-args"), "utf8");
        expect(args).toContain(`-p --cwd ${box.root} --no-title --approval-mode yolo --max-time 45m [mate job every`);
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
            "/srv/mate",
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

        rmSync(flag);
        box.ok(["job", "tick"]);
        box.ok(["job", "tick"]);
        const delivered = readFileSync(log, "utf8");
        expect(delivered.match(/^DELIVERY /gm)?.length).toBe(1);
        expect(delivered).toContain("bin/mate inbox add --from w1 --title 'job nightly'");
        expect(delivered).toContain("report body");
        expect(readdirSync(join(box.root, "state", "outbox")).length).toBe(0);
    });
});
