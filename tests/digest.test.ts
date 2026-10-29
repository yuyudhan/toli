import { describe, expect, test } from "bun:test";
import { type Sandbox, sandbox, withProject } from "./helpers.ts";

type Digest = {
    backlog: { inFlight: { id: string }[]; waiting: { id: string; question?: string }[]; queued: { id: string }[] };
    jobResults: { job: string; status: string }[];
    inbox: { title: string }[];
};

const NOW = "2026-03-04T10:00:00Z";

function coordinator(): Sandbox {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    withProject(box, "alpha");
    return box;
}

/** Text of one digest section: the lines after its `<label> (n):` header up to the next blank line. */
function section(text: string, label: string): string[] {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.startsWith(`${label} (`));
    if (start < 0) throw new Error(`no "${label}" section in:\n${text}`);
    const end = lines.indexOf("", start);
    return [lines[start] ?? "", ...lines.slice(start + 1, end < 0 ? undefined : end)];
}

function finishJob(box: Sandbox, name: string, status: "ok" | "failed", now: string): void {
    const begun = JSON.parse(box.ok(["job", "begin", name, "--via", "session", "--json"], { now })) as {
        runId: string;
    };
    box.ok(["job", "finish", name, begun.runId, "--status", status], { stdin: `${name} result`, now });
}

describe("digest", () => {
    test("held tasks show under 'waiting on answer' with their question, and leave once answered", () => {
        const box = coordinator();
        box.ok(["task", "add", "alpha", "build it"]);
        box.ok(["task", "add", "alpha", "ask first"]);
        box.ok(["task", "add", "alpha", "later"]);
        box.ok(["task", "start", "T1"]);
        box.ok(["task", "hold", "T2", "--question", "which db?"]);

        const text = box.ok(["digest"], { now: NOW });
        expect(section(text, "in flight")).toEqual(["in flight (1):", "  T1 alpha: build it"]);
        expect(section(text, "waiting on answer")).toEqual([
            "waiting on answer (1):",
            "  T2 alpha: ask first (question: which db?)",
        ]);
        expect(section(text, "queued")).toEqual(["queued (1):", "  T3 alpha: later"]);

        box.ok(["task", "answer", "T2", "postgres"]);
        const after = JSON.parse(box.ok(["digest", "--json"], { now: NOW })) as Digest;
        expect(after.backlog.waiting).toEqual([]);
        expect(after.backlog.queued.map((task) => task.id)).toEqual(["T2", "T3"]);
    });

    test("only unseen inbox items and job results appear; acking clears them", () => {
        const box = coordinator();
        box.ok(["job", "add", "nightly", "--cron", "0 * * * *", "--prompt", "check"], { now: "2026-03-04T09:00:00Z" });
        box.ok(["inbox", "add", "--from", "m2", "--title", "old news"], { stdin: "x", now: "2026-03-04T09:10:00Z" });
        finishJob(box, "nightly", "failed", "2026-03-04T09:20:00Z");
        box.ok(["inbox", "ack"]);
        box.ok(["job", "ack"]);
        box.ok(["inbox", "add", "--from", "m3", "--title", "fresh news"], { stdin: "y", now: "2026-03-04T09:30:00Z" });

        const digest = JSON.parse(box.ok(["digest", "--json"], { now: NOW })) as Digest;
        expect(digest.inbox.map((item) => item.title)).toEqual(["fresh news"]);
        expect(digest.jobResults).toEqual([]);

        finishJob(box, "nightly", "ok", "2026-03-04T10:00:00Z");
        const text = box.ok(["digest"], { now: NOW });
        expect(section(text, "unseen job results")[0]).toBe("unseen job results (1):");
        expect(section(text, "unseen job results")[1]).toMatch(/^ {2}nightly ok \//);
        expect(section(text, "unseen inbox")).toEqual([
            "unseen inbox (1):",
            expect.stringMatching(/^ {2}m3: fresh news \//),
        ]);
    });

    test("empty sections say none", () => {
        const box = coordinator();
        const text = box.ok(["digest"], { now: NOW });
        for (const label of ["in flight", "waiting on answer", "queued", "unseen job results", "unseen inbox"]) {
            expect(section(text, label)).toEqual([`${label} (0):`, "  none"]);
        }
    });

    test("--fleet is refused on a worker", () => {
        const box = sandbox();
        box.ok([
            "init",
            "--name",
            "w1",
            "--role",
            "worker",
            "--coordinator-ssh",
            "m1",
            "--coordinator-root",
            "/srv/toli",
        ]);
        const result = box.toli(["digest", "--fleet"]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("coordinator only");
    });
});
