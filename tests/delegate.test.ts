import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storeCopy } from "../src/records/fleet-tasks.ts";
import { brief, type FleetList, inbox, pair, tasks } from "./delegate-fixture.ts";
import { inProcess, type Sandbox, withProject } from "./helpers.ts";

describe("delegate", () => {
    test("lands in the target's own backlog, wakes its lead, and records the fleet id on the --for task", () => {
        const { m1, m2 } = pair();
        withProject(m1, "app");
        m1.ok(["task", "add", "app", "parent work"]);
        const output = m1.ok([
            "delegate",
            "m2",
            "do the no-op",
            "--brief",
            brief(m1),
            "--note",
            "his words",
            "--for",
            "T1",
        ]);
        expect(output).toBe("delegated to m2/T1 (for T1): m2's lead dispatches it");

        const [received] = tasks(m2);
        expect(received).toMatchObject({ id: "T1", status: "queued", project: "toli" });
        expect(received?.delegatedBy).toMatchObject({ machine: "m1", task: "T1" });
        expect(received?.notes).toEqual(["his words", "delegated by m1/T1"]);
        expect(readFileSync(join(m2.root, "data", "projects", "toli", "briefs", "T1.md"), "utf8")).toContain("# no-op");
        const wake = JSON.parse(m2.ok(["wake", "--json"])) as { message: string };
        expect(wake.message).toContain("m1: delegated T1 from m1: do the no-op");
        expect(wake.message).toContain("it is yours now");

        const [parent] = tasks(m1);
        expect(parent).toMatchObject({ status: "active", agent: "m2/T1", delegatedTo: ["m2/T1"] });
    });

    test("refuses this machine, an unknown machine and a missing brief", () => {
        const { m1 } = pair();
        expect(m1.toli(["delegate", "m1", "x", "--brief", brief(m1)]).stderr).toContain("that is this machine");
        expect(m1.toli(["delegate", "m9", "x", "--brief", brief(m1)]).stderr).toContain('machine "m9" is not in');
        expect(m1.toli(["delegate", "m2", "x"]).stderr).toContain("delegate needs --brief <file>");
    });

    test("a repeated delivery of the same delegation makes one task", () => {
        const { m2 } = pair();
        const delegation = JSON.stringify({ id: "m1-1", from: "m1", title: "once", brief: "b" });
        expect(m2.ok(["delegation", "receive"], { stdin: delegation })).toBe("delegation-accepted m2/T1 created");
        expect(m2.ok(["delegation", "receive"], { stdin: delegation })).toBe("delegation-accepted m2/T1 existing");
        expect(tasks(m2)).toHaveLength(1);
        expect(inbox(m2)).toHaveLength(1);
    });

    test("an unreachable target gets the delegation from the tick, and the id arrives as a wake", () => {
        const { m1, m2, down, up } = pair();
        down();
        expect(m1.ok(["delegate", "m2", "later", "--brief", brief(m1)])).toContain("queued: m2 is unreachable");
        expect(readdirSync(join(m1.root, "state", "outbox"))).toHaveLength(1);
        expect(existsSync(join(m2.root, "data", "backlog.json"))).toBe(false);
        up();
        m1.ok(["job", "tick"]);
        m1.ok(["job", "tick"]);
        expect(tasks(m2).map((task) => task.id)).toEqual(["T1"]);
        expect(readdirSync(join(m1.root, "state", "outbox"))).toHaveLength(0);
        // The tick may post its own oversight items too; the delegation's is the one that names m2/T1.
        expect(inbox(m1).filter((item) => item.title.startsWith("delegated"))).toMatchObject([
            { title: "delegated m2/T1: later" },
        ]);
    });
});

describe("one open delegation per piece of work", () => {
    test("a queued copy that lands after a retry went through makes no second task", () => {
        const { m1, m2, down, up } = pair();
        withProject(m1, "app");
        m1.ok(["task", "add", "app", "parent work"]);
        down();
        expect(m1.ok(["delegate", "m2", "same work", "--brief", brief(m1), "--for", "T1"])).toContain("queued");
        up();
        expect(m1.ok(["delegate", "m2", "same work", "--brief", brief(m1), "--for", "T1"])).toContain(
            "delegated to m2/T1",
        );
        m1.ok(["job", "tick"]);
        expect(readdirSync(join(m1.root, "state", "outbox"))).toHaveLength(0);
        expect(tasks(m2).map((task) => task.id)).toEqual(["T1"]);
        const landed = inbox(m1).filter((item) => item.title === "delegated m2/T1: same work");
        expect(readFileSync(landed.at(-1)?.path ?? "", "utf8")).toContain("no second task was made");
        // Other work for the same task, or the same work once the first is done, is a new delegation.
        expect(m1.ok(["delegate", "m2", "other work", "--brief", brief(m1), "--for", "T1"])).toContain("m2/T2");
        m2.ok(["task", "done", "T1"]);
        expect(m1.ok(["delegate", "m2", "same work", "--brief", brief(m1), "--for", "T1"])).toContain("m2/T3");
    });
});

describe("delegated results go back", () => {
    test("done, held and dropped each report to the delegator's inbox, which wakes its lead", () => {
        const { m1, m2 } = pair();
        m1.ok(["delegate", "m2", "first", "--brief", brief(m1)]);
        m1.ok(["delegate", "m2", "second", "--brief", brief(m1)]);
        writeFileSync(join(m2.root, "report.md"), "all green\n");
        m2.ok(["task", "done", "T1", "--commit", "abc123", "--report", "report.md", "--note", "no-op done"]);
        m2.ok(["task", "hold", "T2", "--question", "Which one?", "--option", "a => fast", "--option", "b => slow"]);
        const titles = inbox(m1).map((item) => item.title);
        expect(titles).toEqual(["m2/T1 done: first", "m2/T2 held: second"]);
        const wake = JSON.parse(m1.ok(["wake", "--json"])) as { message: string };
        expect(wake.message).toContain("- commit: abc123");
        expect(wake.message).toContain("all green");
        expect(wake.message).toContain("no-op done");
        expect(wake.message).toContain("Which one?");
        expect(wake.message).toContain("1. a => fast");
        expect(wake.message).toContain('bin/toli task answer m2/T2 "<answer>"');
        expect(wake.message).toContain("bin/toli task escalate m2/T2");
        // A change that is not a new outcome (another note on a done task) sends nothing more.
        m2.ok(["task", "done", "T1", "--note", "again"]);
        expect(inbox(m1)).toHaveLength(2);
        m2.ok(["task", "drop", "T2"]);
        expect(inbox(m1).at(-1)?.title).toBe("m2/T2 dropped: second");
    });

    test("an answer recorded on the delegator goes to the owner, which releases the task and wakes its lead", () => {
        const { m1, m2 } = pair();
        m1.ok(["delegate", "m2", "ask", "--brief", brief(m1)]);
        m2.ok(["task", "hold", "T1", "--question", "Go?"]);
        const output = m1.ok(["task", "answer", "m2/T1", "yes, go"]);
        expect(output).toContain("m2 recorded the answer for m2/T1:");
        expect(output).toContain("unblocked: dispatch T1 now");
        const [task] = tasks(m2);
        expect(task?.status).toBe("queued");
        expect(inbox(m2).at(-1)?.title).toBe("answer recorded for T1: dispatch it");
        expect(task?.notes.at(-1)).toBe("Q: Go?\nA: yes, go (recorded by m1's lead)");
    });

    test("only the owner changes a task: other writes to another machine's task are refused", () => {
        const { m1, m2 } = pair();
        m2.ok(["delegation", "receive"], { stdin: JSON.stringify({ id: "m1-1", from: "m1", title: "t", brief: "b" }) });
        expect(m1.toli(["task", "done", "m2/T1"]).stderr).toContain("m2/T1 is m2's task: only its owner changes it");
        expect(tasks(m2)[0]?.status).toBe("queued");
        // This machine's own fleet id is the bare id.
        expect(m2.ok(["task", "start", "m2/T1", "--agent", "j-1"])).toContain("T1\tactive");
    });
});

describe("task list --fleet", () => {
    test("shows every machine's open tasks by fleet id; an unreachable one keeps its last copy", () => {
        const { m1, m2, down } = pair();
        withProject(m1, "app");
        m1.ok(["task", "add", "app", "mine"]);
        m1.ok(["delegate", "m2", "theirs", "--brief", brief(m1)]);
        m2.ok(["delegation", "receive"], {
            stdin: JSON.stringify({ id: "x-1", from: "m1", title: "closed", brief: "b" }),
        });
        m2.ok(["task", "done", "T2"]);

        const live = JSON.parse(m1.ok(["task", "list", "--fleet", "--json"])) as FleetList;
        expect(live.map((copy) => [copy.machine, copy.tasks.map((task) => task.fleetId)])).toEqual([
            ["m1", ["m1/T1"]],
            ["m2", ["m2/T1"]],
            ["m3", []],
        ]);
        expect(live[2]?.error).toContain("ssh host3 exited 255");
        expect(m1.ok(["task", "list", "--fleet", "--status", "done"])).toContain("m2/T2\tdone\ttoli\tclosed");

        down();
        const text = m1.ok(["task", "list", "--fleet"]);
        expect(text).toContain("## m2 (unreachable, copy from 0 min ago");
        expect(text).toContain("m2/T1\tqueued\ttoli\ttheirs\t(delegated by m1)");
        expect(text).toContain("## m3 (unreachable, never fetched");
        const cached = JSON.parse(m1.ok(["task", "list", "--fleet", "--cached", "--json"])) as FleetList;
        expect(cached[1]?.tasks.map((task) => task.fleetId)).toEqual(["m2/T1"]);
    });

    test("a copy taken earlier never replaces a later one", () => {
        const { m1 } = pair();
        inProcess(m1.root, () => {
            expect(storeCopy("m2", "2026-11-10T10:00:00.000Z", [])).toBe(true);
            expect(storeCopy("m2", "2026-11-10T09:00:00.000Z", [])).toBe(false);
            expect(storeCopy("m2", "2026-11-10T11:00:00.000Z", [])).toBe(true);
        });
        const copy = JSON.parse(readFileSync(join(m1.root, "state", "fleet-tasks", "m2.json"), "utf8"));
        expect(copy.fetchedAt).toBe("2026-11-10T11:00:00.000Z");
    });
});

describe("talk", () => {
    test("words go to the other machine's inbox with how to reply", () => {
        const { m1, m2 } = pair();
        expect(m1.ok(["talk", "m2", "can you take the build?"])).toBe(
            "sent to m2's lead; its reply arrives here as a wake",
        );
        const [item] = inbox(m2);
        expect(item?.title).toBe("message from m1");
        const body = readFileSync(item?.path ?? "", "utf8");
        expect(body).toContain("can you take the build?");
        expect(body).toContain('bin/toli talk m1 "<reply>"');
    });
});

type ShareRecord = {
    id: string;
    direction: string;
    to: string[];
    fromUser: boolean;
    answers: Record<string, { decision: string; into?: string; note?: string }>;
};

function shares(box: Sandbox): ShareRecord[] {
    return JSON.parse(box.ok(["share", "--list", "--json"])) as ShareRecord[];
}

describe("share", () => {
    test("a learning reaches the other leads as a wake; adopting writes it dated with its source and tells the sender", () => {
        const { m1, m2 } = pair();
        const output = m1.ok([
            "share",
            "Run the gate before every push",
            "--source",
            "his words: always gate",
            "--from-user",
        ]);
        expect(output).toMatch(/^shared m1-\S+ with m2$/m);
        expect(output).toMatch(/^queued m1-\S+ for m3 \(unreachable\)/m);
        const [sent] = shares(m1);
        expect(sent).toMatchObject({ direction: "sent", to: ["m2", "m3"], fromUser: true, answers: {} });
        const id = sent?.id ?? "";

        const wake = JSON.parse(m2.ok(["wake", "--json"])) as { message: string };
        expect(wake.message).toContain("m1: learning from m1: Run the gate before every push");
        expect(wake.message).toContain("This is the user's own word: treat it as his rule.");
        expect(wake.message).toContain(`bin/toli share answer ${id} adopt`);

        // The user's own word goes to preferences by default.
        expect(m2.ok(["share", "answer", id, "adopt"])).toContain("answer sent to m1");
        const preferences = readFileSync(join(m2.root, "data", "preferences.md"), "utf8");
        expect(preferences).toMatch(
            /^- \d{4}-\d{2}-\d{2}: Run the gate before every push \(shared by m1's lead; the user's own word; source: his words: always gate\)$/m,
        );
        expect(shares(m1)[0]?.answers).toEqual({
            m2: expect.objectContaining({ decision: "adopt", into: "preferences" }),
        });
        expect(inbox(m1).at(-1)?.title).toBe(`learning ${id}: m2 adopted`);
        const list = m1.ok(["share", "--list"]);
        expect(list).toContain("sent to m2, m3");
        expect(list).toContain("m2: adopt into preferences");
        expect(list).toContain("m3: no answer yet");
    });

    test("decline needs a reason, which reaches the sender; a lead's learning never goes into preferences", () => {
        const { m1, m2 } = pair();
        m1.ok(["share", "Prefer small commits", "--to", "m2"]);
        const id = shares(m1)[0]?.id ?? "";
        expect(m2.toli(["share", "answer", id, "adopt", "--into", "preferences"]).stderr).toContain(
            "preferences hold only the user's own words",
        );
        expect(m2.toli(["share", "answer", id, "decline"]).stderr).toContain('decline needs --note "<why>"');
        m2.ok(["share", "answer", id, "decline", "--note", "this machine batches on purpose"]);
        expect(existsSync(join(m2.root, "data", "learnings.md"))).toBe(false);
        expect(shares(m1)[0]?.answers.m2).toMatchObject({
            decision: "decline",
            note: "this machine batches on purpose",
        });
        expect(readFileSync(inbox(m1).at(-1)?.path ?? "", "utf8")).toContain(
            "m2's lead declined: this machine batches on purpose",
        );
        expect(m2.ok(["share", "--list"])).toContain("received from m1");
    });

    test("adapt writes the receiving lead's own version into learnings", () => {
        const { m1, m2 } = pair();
        m1.ok(["share", "Clean target/ nightly", "--to", "m2"]);
        const id = shares(m1)[0]?.id ?? "";
        expect(m2.toli(["share", "answer", id, "adapt"]).stderr).toContain('adapt needs --text "<your version>"');
        m2.ok(["share", "answer", id, "adapt", "--text", "Clean target/ weekly here: the disk is large"]);
        expect(readFileSync(join(m2.root, "data", "learnings.md"), "utf8")).toContain(
            ": Clean target/ weekly here: the disk is large (shared by m1's lead)",
        );
        expect(shares(m1)[0]?.answers.m2).toMatchObject({ decision: "adapt", into: "learnings" });
    });
});
