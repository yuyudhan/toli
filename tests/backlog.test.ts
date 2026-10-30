import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BacklogFile, loadBacklog, matchOption, taskCommand } from "../src/records/backlog.ts";
import { commandIn, inProcess, type Sandbox, sandbox, withProject } from "./helpers.ts";

type TaskJson = { id: string; status: string; question?: string; answer?: string; notes: string[]; startedAt?: string };

function project(): Sandbox {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    withProject(box, "alpha");
    return box;
}

const task = (box: Sandbox, id: string): TaskJson => {
    const found = (JSON.parse(box.ok(["task", "list", "--json"])) as TaskJson[]).find((entry) => entry.id === id);
    if (!found) throw new Error(`task ${id} not listed`);
    return found;
};

describe("task lifecycle", () => {
    test("ids increase and are never reused, even after a drop", () => {
        const box = project();
        expect(box.ok(["task", "add", "alpha", "first"])).toBe("T1");
        box.ok(["task", "drop", "T1"]);
        expect(box.ok(["task", "add", "alpha", "second"])).toBe("T2");
    });

    test("an answered task that was never started goes back to queued", () => {
        const box = project();
        box.ok(["task", "add", "alpha", "investigate"]);
        box.ok(["task", "hold", "T1", "--question", "which branch?"]);
        expect(task(box, "T1")).toMatchObject({ status: "held", question: "which branch?" });
        box.ok(["task", "answer", "T1", "main"]);
        const answered = task(box, "T1");
        expect(answered.status).toBe("queued");
        expect(answered.answer).toBe("main");
        expect(answered.notes).toEqual(["Q: which branch?\nA: main"]);
    });

    test("an answered task that had started resumes as active", () => {
        const box = project();
        box.ok(["task", "add", "alpha", "build"]);
        box.ok(["task", "start", "t1"]);
        box.ok(["task", "hold", "T1", "--question", "ok to delete?"]);
        box.ok(["task", "answer", "T1", "yes"]);
        expect(task(box, "T1").status).toBe("active");
    });

    test("re-holding clears the previous answer", () => {
        const box = project();
        box.ok(["task", "add", "alpha", "build"]);
        box.ok(["task", "hold", "T1", "--question", "q1"]);
        box.ok(["task", "answer", "T1", "a1"]);
        box.ok(["task", "hold", "T1", "--question", "q2"]);
        expect(task(box, "T1").answer).toBeUndefined();
    });

    test("finished and dropped tasks cannot be started or held again", () => {
        const box = project();
        box.ok(["task", "add", "alpha", "a"]);
        box.ok(["task", "add", "alpha", "b"]);
        box.ok(["task", "done", "T1", "--commit", "abc123"]);
        box.ok(["task", "drop", "T2"]);
        for (const args of [
            ["task", "start", "T1"],
            ["task", "hold", "T1", "--question", "q"],
            ["task", "start", "T2"],
        ]) {
            const result = box.toli(args);
            expect(result.code).toBe(1);
            expect(result.stderr).toMatch(/T[12] is (done|dropped)/);
        }
        expect(task(box, "T1").status).toBe("done");
    });

    test("answering a task that is not held fails and changes nothing", () => {
        const box = project();
        box.ok(["task", "add", "alpha", "a"]);
        const result = box.toli(["task", "answer", "T1", "yes"]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("not waiting on an answer");
        expect(task(box, "T1")).toMatchObject({ status: "queued", notes: [] });
    });

    test("hold needs a question; unknown ids and bad shapes are rejected", () => {
        const box = project();
        box.ok(["task", "add", "alpha", "a"]);
        expect(box.toli(["task", "hold", "T1"]).stderr).toContain("--question");
        expect(box.toli(["task", "start", "T9"]).stderr).toContain('unknown task "T9"');
        expect(box.toli(["task", "add", "alpha", "b", "--shape", "build"]).stderr).toContain("ship or scout");
        expect(box.toli(["task", "add", "nope", "b"]).code).toBe(1);
    });

    test("list filters by status and rejects unknown statuses", () => {
        const box = project();
        box.ok(["task", "add", "alpha", "a"]);
        box.ok(["task", "add", "alpha", "b"]);
        box.ok(["task", "hold", "T2", "--question", "q"]);
        const held = JSON.parse(box.ok(["task", "list", "--status", "held", "--json"])) as TaskJson[];
        expect(held.map((entry) => entry.id)).toEqual(["T2"]);
        expect(box.ok(["task", "list", "--status", "done"])).toBe("no tasks");
        expect(box.toli(["task", "list", "--status", "waiting"]).code).toBe(1);
    });
});

describe("task commands in process", () => {
    test("add, list, start, hold with options, answer by number, done and drop", () => {
        const box = project();
        const task = commandIn(box.root, taskCommand);
        expect(task(["add", "alpha", "Draft plan", "--shape", "scout", "--note", "from chat"])).toBe("T1");
        expect(task(["add", "alpha", "Ship it"])).toBe("T2");
        expect(task(["start", "t1", "--agent", "jawan-1"])).toBe(
            "T1\tactive\talpha\tscout\tDraft plan\t(agent: jawan-1)",
        );
        expect(
            task([
                "hold",
                "T1",
                "--question",
                " Which store? ",
                "--option",
                "Postgres => keep one database",
                "--option",
                "SQLite => embed it",
                "--recommend",
                "2",
                "--blocks",
                "T2",
            ]),
        ).toBe("T1\theld\talpha\tscout\tDraft plan\t(question: Which store?; agent: jawan-1)");
        const backlog = JSON.parse(readFileSync(join(box.root, "data", "backlog.json"), "utf8")) as BacklogFile;
        expect(backlog.tasks[0]).toMatchObject({
            options: [
                { choice: "Postgres", outcome: "keep one database" },
                { choice: "SQLite", outcome: "embed it" },
            ],
            recommend: "SQLite",
            blocks: "T2",
        });

        expect(task(["answer", "T1", "1"]).split("\n")).toEqual([
            "T1\tactive\talpha\tscout\tDraft plan\t(agent: jawan-1)",
            "unblocked: dispatch T1 now (toli-dispatch skill; put the answer in its brief, data/projects/alpha/briefs/T1.md)",
        ]);
        const decisions = readFileSync(join(box.root, "data", "projects", "alpha", "decisions.md"), "utf8");
        expect(decisions).toStartWith("# alpha decisions\n");
        expect(decisions).toContain("T1: Draft plan");
        expect(decisions).toContain("- Options: 1. Postgres => keep one database; 2. SQLite => embed it");
        expect(decisions).toContain("- Recommended: SQLite\n- A: 1\n- Chosen: Postgres => keep one database");

        expect(task(["done", "T1", "--report", "r.md", "--commit", "abc1234", "--note", "landed"])).toBe(
            "T1\tdone\talpha\tscout\tDraft plan\t(agent: jawan-1; commit: abc1234; report: r.md)",
        );
        expect(task(["drop", "T2"])).toBe("T2\tdropped\talpha\tship\tShip it");
        expect(task(["list", "--project", "alpha"]).split("\n")).toHaveLength(2);
        expect(task(["list", "--project", "beta"])).toBe("no tasks");
        const listed = JSON.parse(task(["list", "--status", "done", "--json"])) as { id: string; notes: string[] }[];
        expect(listed.map((entry) => entry.id)).toEqual(["T1"]);
        expect(listed[0]?.notes).toEqual(["from chat", "Q: Which store?\nA: 1 (= Postgres)", "landed"]);
    });

    test("refusals leave the backlog unchanged", () => {
        const box = project();
        const task = commandIn(box.root, taskCommand);
        task(["add", "alpha", "One"]);
        const refusals: [string[], string][] = [
            [["hold", "T1"], 'hold needs --question "..."'],
            [["hold", "T1", "--question", "q", "--option", "a => b"], "give 2-4 --option values, or none"],
            [["hold", "T1", "--question", "q", "--option", "no arrow", "--option", "x => y"], "--option must be"],
            [
                ["hold", "T1", "--question", "q", "--option", "a => b", "--option", "c => d", "--recommend", "e"],
                "--recommend must be",
            ],
            [["answer", "T1", "yes"], "T1 is queued, not waiting on an answer"],
            [["start", "T7"], 'unknown task "T7"'],
            [["list", "--status", "waiting"], "--status must be one of"],
            [["add", "alpha", "Two", "--shape", "build"], "--shape must be ship or scout"],
            [["rename", "T1"], "usage: toli task add|list|start|done|hold|answer|drop"],
        ];
        for (const [argv, message] of refusals) expect(() => task(argv)).toThrow(message);
        task(["drop", "T1"]);
        expect(() => task(["start", "T1"])).toThrow("T1 is dropped");
        expect(() => task(["hold", "T1", "--question", "q"])).toThrow("T1 is dropped");
        inProcess(box.root, () => expect(loadBacklog()).toMatchObject({ nextId: 2, tasks: [{ status: "dropped" }] }));
    });

    test("a free-text recommendation stands when the hold offers no options", () => {
        const box = project();
        const task = commandIn(box.root, taskCommand);
        task(["add", "alpha", "One"]);
        task(["hold", "T1", "--question", "go?", "--recommend", "wait for Monday"]);
        task(["answer", "T1", "later"]);
        const decisions = readFileSync(join(box.root, "data", "projects", "alpha", "decisions.md"), "utf8");
        expect(decisions).toContain("- Q: go?\n- Recommended: wait for Monday\n- A: later\n");
        expect(decisions).not.toContain("Options:");
    });
});

describe("matchOption", () => {
    const options = [
        { choice: "Yes", outcome: "ship" },
        { choice: "No", outcome: "wait" },
    ];
    test("takes a 1-based number or the exact choice in any case", () => {
        expect(matchOption(options, " 2 ")).toEqual({ choice: "No", outcome: "wait" });
        expect(matchOption(options, "yes")).toEqual({ choice: "Yes", outcome: "ship" });
        expect(matchOption(options, "3")).toBeUndefined();
        expect(matchOption(options, "maybe")).toBeUndefined();
    });
});
