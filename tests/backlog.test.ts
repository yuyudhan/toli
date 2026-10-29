import { describe, expect, test } from "bun:test";
import { type Sandbox, sandbox, withProject } from "./helpers.ts";

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
            const result = box.mate(args);
            expect(result.code).toBe(1);
            expect(result.stderr).toMatch(/T[12] is (done|dropped)/);
        }
        expect(task(box, "T1").status).toBe("done");
    });

    test("answering a task that is not held fails and changes nothing", () => {
        const box = project();
        box.ok(["task", "add", "alpha", "a"]);
        const result = box.mate(["task", "answer", "T1", "yes"]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("not waiting on an answer");
        expect(task(box, "T1")).toMatchObject({ status: "queued", notes: [] });
    });

    test("hold needs a question; unknown ids and bad shapes are rejected", () => {
        const box = project();
        box.ok(["task", "add", "alpha", "a"]);
        expect(box.mate(["task", "hold", "T1"]).stderr).toContain("--question");
        expect(box.mate(["task", "start", "T9"]).stderr).toContain('unknown task "T9"');
        expect(box.mate(["task", "add", "alpha", "b", "--shape", "build"]).stderr).toContain("ship or scout");
        expect(box.mate(["task", "add", "nope", "b"]).code).toBe(1);
    });

    test("list filters by status and rejects unknown statuses", () => {
        const box = project();
        box.ok(["task", "add", "alpha", "a"]);
        box.ok(["task", "add", "alpha", "b"]);
        box.ok(["task", "hold", "T2", "--question", "q"]);
        const held = JSON.parse(box.ok(["task", "list", "--status", "held", "--json"])) as TaskJson[];
        expect(held.map((entry) => entry.id)).toEqual(["T2"]);
        expect(box.ok(["task", "list", "--status", "done"])).toBe("no tasks");
        expect(box.mate(["task", "list", "--status", "waiting"]).code).toBe(1);
    });
});
