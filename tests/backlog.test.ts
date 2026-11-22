import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type BacklogFile, loadBacklog, taskCommand } from "../src/records/backlog.ts";
import { irreversibleTopic, matchOption } from "../src/records/hold-options.ts";
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
        box.ok([
            "task",
            "hold",
            "T1",
            "--question",
            "which branch?",
            "--option",
            "main => base it on main",
            "--option",
            "dev => base it on dev",
        ]);
        expect(task(box, "T1")).toMatchObject({ status: "held", question: "which branch?" });
        box.ok(["task", "answer", "T1", "main"]);
        const answered = task(box, "T1");
        expect(answered.status).toBe("queued");
        expect(answered.answer).toBe("main");
        expect(answered.notes).toEqual(["Q: which branch?\nA: main (= main)"]);
    });

    test("an answered task that had started resumes as active", () => {
        const box = project();
        box.ok(["task", "add", "alpha", "build"]);
        box.ok(["task", "start", "t1"]);
        box.ok([
            "task",
            "hold",
            "T1",
            "--question",
            "ok to delete?",
            "--option",
            "yes => delete",
            "--option",
            "no => keep",
        ]);
        box.ok(["task", "answer", "T1", "yes"]);
        expect(task(box, "T1").status).toBe("active");
    });

    test("re-holding clears the previous answer", () => {
        const box = project();
        box.ok(["task", "add", "alpha", "build"]);
        box.ok(["task", "hold", "T1", "--question", "q1", "--option", "a => x", "--option", "b => y"]);
        box.ok(["task", "answer", "T1", "a1"]);
        box.ok(["task", "hold", "T1", "--question", "q2", "--option", "a => x", "--option", "b => y"]);
        expect(task(box, "T1").answer).toBeUndefined();
    });

    test("finished and dropped tasks cannot be started again", () => {
        const box = project();
        box.ok(["task", "add", "alpha", "a"]);
        box.ok(["task", "add", "alpha", "b"]);
        box.ok(["task", "done", "T1", "--commit", "abc123"]);
        box.ok(["task", "drop", "T2"]);
        for (const id of ["T1", "T2"]) {
            const result = box.toli(["task", "start", id]);
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
        box.ok(["task", "hold", "T2", "--question", "q", "--option", "a => x", "--option", "b => y"]);
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
            "waiting on T1: T2 (alpha, queued): Ship it - named in T1's blocks; re-dispatch it now",
        ]);
        expect(existsSync(join(box.root, "data", "inbox"))).toBe(false);
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
            [["hold", "T1", "--question", "q"], "hold needs --question"],
            [["hold", "T1", "--question", "q", "--option", "a => b"], "2-4 --option"],
            [
                [
                    "hold",
                    "T1",
                    "--question",
                    "q",
                    ...["a", "b", "c", "d", "e"].flatMap((c) => ["--option", `${c} => x`]),
                ],
                "got 5",
            ],
            [["hold", "T1", "--question", "q", "--option", "no arrow", "--option", "x => y"], "--option must be"],
            // T2300: the template's placeholders left in an option are no choice for the user.
            [
                [
                    "hold",
                    "T1",
                    "--question",
                    "q",
                    ...["--option", "<choice> => <what happens then>", "--option", "<choice> => <what happens then>"],
                ],
                "is the template's placeholder",
            ],
            [
                ["hold", "T1", "--question", "q", "--option", "yes => ship it", "--option", "no => <then>"],
                "is the template's placeholder",
            ],
            [
                ["hold", "T1", "--question", "q", "--option", "a => b", "--option", "c => d", "--recommend", "e"],
                "--recommend must be",
            ],
            [["answer", "T1", "yes"], "T1 is queued, not waiting on an answer"],
            [["start", "T7"], 'unknown task "T7"'],
            [["list", "--status", "waiting"], "--status must be one of"],
            [["add", "alpha", "Two", "--shape", "build"], "--shape must be ship or scout"],
            [["rename", "T1"], "usage: toli task add|list|start|wait|done|hold|answer|drop"],
        ];
        for (const [argv, message] of refusals) expect(() => task(argv)).toThrow(message);
        task(["drop", "T1"]);
        expect(() => task(["start", "T1"])).toThrow("T1 is dropped");
        inProcess(box.root, () => expect(loadBacklog()).toMatchObject({ nextId: 2, tasks: [{ status: "dropped" }] }));
    });

    // T2300: only a whole `<...>` is a placeholder; a choice naming something in angle brackets is a real one.
    test("hold accepts an option that only mentions something in angle brackets", () => {
        const box = project();
        const task = commandIn(box.root, taskCommand);
        task(["add", "alpha", "One"]);
        task(["hold", "T1", "--question", "q", "--option", "merge <T12> first => ship it", "--option", "wait => hold"]);
        inProcess(box.root, () =>
            expect(loadBacklog().tasks[0]).toMatchObject({
                status: "held",
                options: [
                    { choice: "merge <T12> first", outcome: "ship it" },
                    { choice: "wait", outcome: "hold" },
                ],
            }),
        );
    });

    // T1905: a follow-up on a done task had no way to make it active again.
    test("start --reopen makes a done or dropped task active again, noted; plain start names the flag", () => {
        const box = project();
        const task = commandIn(box.root, taskCommand);
        task(["add", "alpha", "One"]);
        task(["start", "T1"]);
        task(["done", "T1"]);
        expect(() => task(["start", "T1"])).toThrow(
            "T1 is done; a follow-up reopens it: bin/toli task start T1 --reopen",
        );
        expect(task(["start", "T1", "--reopen"])).toMatch(/\nT1: reopened from done by .+ for a follow-up$/);
        inProcess(box.root, () => {
            const [reopened] = loadBacklog().tasks;
            expect(reopened?.status).toBe("active");
            expect(reopened?.doneAt).toBeUndefined();
            expect(reopened?.notes.at(-1)).toMatch(/^reopened from done by .+ for a follow-up$/);
        });
        // An open task starts as before; --reopen changes nothing there.
        expect(task(["start", "T1", "--reopen"])).not.toContain("reopened");
    });

    test("a hold without options names the format and the count it got", () => {
        const box = project();
        const task = commandIn(box.root, taskCommand);
        task(["add", "alpha", "One"]);
        expect(() => task(["hold", "T1", "--question", "go?", "--recommend", "wait for Monday"])).toThrow(
            'hold needs --question "..." and 2-4 --option "<choice> => <what happens then>" values, so the user answers by number; got 0',
        );
        inProcess(box.root, () => expect(loadBacklog().tasks[0]?.status).toBe("queued"));
    });

    test("--reversible marks the hold, needs a recommendation, and a re-hold without it clears the mark", () => {
        const box = project();
        const task = commandIn(box.root, taskCommand);
        task(["add", "alpha", "One"]);
        const colour = [
            "--question",
            "button colour?",
            "--option",
            "blue => matches the theme",
            "--option",
            "grey => quieter",
        ];
        expect(() => task(["hold", "T1", ...colour, "--reversible"])).toThrow("--reversible needs --recommend");
        task(["hold", "T1", ...colour, "--recommend", "1", "--reversible"]);
        inProcess(box.root, () => expect(loadBacklog().tasks[0]).toMatchObject({ status: "held", reversible: true }));
        expect(box.ok(["needs"])).toContain("reversible: the recommendation applies if it stays unanswered");
        task(["hold", "T1", ...colour, "--recommend", "1"]);
        inProcess(box.root, () => expect(loadBacklog().tasks[0]?.reversible).toBeUndefined());
    });

    test("--reversible is refused for push, merge, main, MR, tag, release, destructive, security and money holds", () => {
        const box = project();
        const task = commandIn(box.root, taskCommand);
        task(["add", "alpha", "One"]);
        const questions = [
            "push now?",
            "merge it into main?",
            "open the MR?",
            "tag v1?",
            "cut the release?",
            "delete the table?",
            "rotate the token?",
            "raise the price?",
        ];
        for (const question of questions)
            expect(() =>
                task([
                    "hold",
                    "T1",
                    "--question",
                    question,
                    "--option",
                    "a => b",
                    "--option",
                    "c => d",
                    "--recommend",
                    "1",
                    "--reversible",
                ]),
            ).toThrow("--reversible refused");
        inProcess(box.root, () => expect(loadBacklog().tasks[0]).toMatchObject({ status: "queued" }));
    });
});

describe("irreversibleTopic", () => {
    test("names the first irreversible word, whole words only", () => {
        expect(irreversibleTopic(["Push the branch?"])).toBe("Push");
        expect(irreversibleTopic([undefined, "two options", "drop the column"])).toBe("drop");
        expect(irreversibleTopic(["the dropdown label", "domain wording", "pushy copy"])).toBeUndefined();
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
