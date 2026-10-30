import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    test("held tasks head the digest under 'Needs you' with their question, and leave once answered", () => {
        const box = coordinator();
        box.ok(["task", "add", "alpha", "build it"]);
        box.ok(["task", "add", "alpha", "ask first"]);
        box.ok(["task", "add", "alpha", "later"]);
        box.ok(["task", "start", "T1"]);
        box.ok(["task", "hold", "T2", "--question", "which db?"], { now: "2026-03-01T10:00:00Z" });

        const text = box.ok(["digest"], { now: NOW });
        const lines = text.split("\n");
        expect(lines.findIndex((line) => line.startsWith("Needs you ("))).toBeLessThan(
            lines.findIndex((line) => line.startsWith("projects (")),
        );
        expect(section(text, "in flight")).toEqual(["in flight (1):", "  T1 alpha: build it"]);
        expect(section(text, "Needs you")).toEqual([
            "Needs you (1):",
            "  alpha:",
            "    T2 ask first: which db? (held 3d)",
            '      reply "T2: <answer>"',
            '  record each reply verbatim: bin/toli task answer T<n> "<the user\'s words>", then dispatch it',
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
        expect(section(text, "Needs you")).toEqual(["Needs you (0):", "  nothing is waiting on the user"]);
        for (const label of ["in flight", "queued", "unseen job results", "unseen inbox"]) {
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

    test("Next recommends concrete actions from state, most urgent first", () => {
        const box = coordinator();
        box.stub("omp", "true");
        const machinePath = join(box.root, "config", "machine.json");
        const machine = JSON.parse(readFileSync(machinePath, "utf8"));
        writeFileSync(machinePath, JSON.stringify({ ...machine, harness: { byWork: { verify: "codex" } } }));
        box.ok(["task", "add", "alpha", "ask first"]);
        box.ok(["task", "add", "alpha", "build it", "--shape", "ship"]);
        box.ok(["task", "hold", "T1", "--question", "which db?"]);
        box.ok(["inbox", "add", "--from", "m2", "--title", "news"], { stdin: "x", now: "2026-03-04T09:00:00Z" });
        const next = section(box.ok(["digest"], { now: NOW }), "Next");
        expect(next[0]).toBe("Next (5):");
        expect(next[1]).toBe(
            '  - Ask the user about T1 (alpha): which db?: bin/toli needs; record each reply verbatim with bin/toli task answer T<n> "<answer>" and dispatch the unblocked task at once (the toli-ahoy skill)',
        );
        expect(next[2]).toStartWith("  - Relay 1 new result to the user in plain words: then bin/toli inbox ack");
        expect(next[3]).toStartWith(
            "  - Dispatch T2 (alpha, ship): build it: load the toli-dispatch skill, then a background jawan recorded on the task (bin/toli task start T2 --agent <id>",
        );
        expect(next[4]).toMatch(/^ {2}- 1 project needs setup \(alpha: .*\): \/setup-project alpha/);
        expect(next[5]).toStartWith(
            "  - Install Codex CLI: config/machine.json routes jawans to it: npm install -g @openai/codex",
        );
        const json = JSON.parse(box.ok(["digest", "--json"], { now: NOW })) as { next: { action: string }[] };
        expect(json.next).toHaveLength(5);
    });

    test("Next says nothing is pending when there is nothing to do; persona line heads the digest", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        box.stub("omp", "true");
        const text = box.ok(["digest"], { now: NOW });
        expect(text.split("\n")[1]).toStartWith('Names: the user is "Malik"');
        expect(section(text, "Next")).toEqual([
            "Next (1):",
            "  - Nothing pending: greet the user and wait for a request",
        ]);
        expect(section(text, "jawan runs")).toEqual(["jawan runs (0):", "  none"]);
    });

    test("an active task with no recorded jawan is flagged until one is recorded with task start --agent", () => {
        const box = coordinator();
        box.stub("omp", "true");
        box.ok(["task", "add", "alpha", "fix kb"]);
        box.ok(["task", "start", "T1"]);
        const flagged = section(box.ok(["digest"], { now: NOW }), "Next");
        expect(flagged[1]).toStartWith("  - T1 (alpha) is active but no running jawan is recorded on it: dispatch one");
        box.ok(["task", "start", "T1", "--agent", "FixKb"]);
        const text = box.ok(["digest"], { now: NOW });
        expect(section(text, "in flight")).toEqual(["in flight (1):", "  T1 alpha: fix kb [jawan FixKb]"]);
        expect(section(text, "Next").some((line) => line.includes("no running jawan"))).toBe(false);
        expect(box.ok(["task", "list"])).toContain("(agent: FixKb)");
    });
});
