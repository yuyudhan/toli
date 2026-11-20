import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brief, inbox, type Task, type Trio, tasks, trio } from "./delegate-fixture.ts";
import { type Sandbox, SSH_STUB_ARGS, TOLI_BIN, withProject } from "./helpers.ts";

function parent(box: Sandbox): Task {
    const task = tasks(box).find((entry) => entry.id === "T1");
    if (task === undefined) throw new Error("no T1");
    return task;
}

describe("work forwarded on (m1 -> m2 -> m3)", () => {
    /** m1's T1 delegated to m2 as m2/T1, which m2 delegates on to m3 as m3/T1 (`--for T1`) and drops. */
    function forwarded(): Trio {
        const machines = trio();
        const { m1, m2 } = machines;
        withProject(m1, "app");
        m1.ok(["task", "add", "app", "parent work"]);
        m1.ok(["delegate", "m2", "the work", "--brief", brief(m1), "--for", "T1"]);
        m2.ok(["delegate", "m3", "forwarded work", "--brief", brief(m2), "--for", "T1"]);
        m2.ok(["task", "drop", "T1"]);
        return machines;
    }

    test("the originator's task follows the live owner and gets its done report", () => {
        const { m1, m3 } = forwarded();
        expect(tasks(m3)[0]?.delegatedBy).toMatchObject({
            machine: "m2",
            task: "T1",
            upstream: [{ machine: "m1", task: "T1" }],
        });
        const following = parent(m1);
        expect(following).toMatchObject({ status: "active", agent: "m3/T1", delegatedTo: ["m2/T1", "m3/T1"] });
        expect(following.notes).toContain("m2/T1 forwarded the work to m3/T1");
        expect(following.notes).toContain("m2/T1 is forwarded to m3/T1");
        expect(inbox(m1).map((item) => item.title)).toContain("m2/T1 forwarded to m3/T1: the work");

        writeFileSync(join(m3.root, "report.md"), "shipped\n");
        m3.ok(["task", "done", "T1", "--commit", "f0rward", "--report", "report.md"]);
        expect(parent(m1)).toMatchObject({ status: "done", commit: "f0rward" });
        const wake = inbox(m1).find((item) => item.title === "m3/T1 done: forwarded work");
        const body = readFileSync(wake?.path ?? "", "utf8");
        expect(body).toContain("- for: T1 on m1");
        expect(body).toContain("- via: m2/T1, which forwarded it");
        expect(body).toContain("shipped");
    });

    test("the originator answers the live owner's question", () => {
        const { m1, m3 } = forwarded();
        m3.ok(["task", "hold", "T1", "--question", "Which?", "--option", "a => fast", "--option", "b => slow"]);
        expect(parent(m1).delegates?.["m3/T1"]).toMatchObject({ status: "held", question: "Which?" });
        expect(m1.ok(["task", "answer", "m3/T1", "a"])).toContain("m3 recorded the answer for m3/T1:");
        expect(tasks(m3)[0]?.status).toBe("queued");
    });

    test("task link to the forwarded task is still refused: only its own delegator links it", () => {
        const { m1, m3 } = forwarded();
        m1.ok(["task", "add", "app", "other work"]);
        const refused = m1.toli(["task", "link", "T2", "m3/T1"]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("m3 refused the link: T1 was delegated by m2, not m1");
        expect(tasks(m3)[0]?.delegatedBy).toMatchObject({ machine: "m2", task: "T1" });
    });

    test("the live owner handing the work back queues the originator's task again, never drops it", () => {
        const { m1, m3 } = forwarded();
        m3.ok(["task", "handback", "T1", "--reason", "verifier only"]);
        const task = parent(m1);
        expect(task.status).toBe("queued");
        expect(task.agent).toBeUndefined();
        expect(task.notes).toContain("m3/T1 handed the work back: verifier only");
    });
});

describe("a slice forwarded on (T2045)", () => {
    test("reports only to the machine that forwarded it: the slice's delegator follows that machine's task", () => {
        const { m1, m2, m3 } = trio();
        withProject(m1, "app");
        m1.ok(["task", "add", "app", "release"]);
        m1.ok(["task", "start", "T1", "--agent", "ReleaseSub"]);
        m1.ok(["delegate", "m2", "verify slice", "--brief", brief(m1), "--for", "T1"]);
        expect(parent(m1)).toMatchObject({ slices: ["m2/T1"] });
        expect(tasks(m2)[0]?.delegatedBy).toMatchObject({ machine: "m1", task: "T1", slice: true });
        m2.ok(["delegate", "m3", "placed verify", "--brief", brief(m2), "--for", "T1"]);
        const by = tasks(m3)[0]?.delegatedBy;
        expect(by).toMatchObject({ machine: "m2", task: "T1" });
        expect(by?.upstream).toBeUndefined();
        m3.ok(["task", "start", "T1", "--agent", "VerifySub"]);
        expect(tasks(m2)[0]?.delegates?.["m3/T1"]).toMatchObject({ status: "active" });
        expect(parent(m1).delegates?.["m3/T1"]).toBeUndefined();
    });
});

describe("a machine above that records no delegation of the task (T2045)", () => {
    /** m3's ssh: m1 refuses every update as src/peer/envelope.ts does; m2 applies them. */
    function refusingAbove({ m2, m3 }: Trio): void {
        m3.stub(
            "ssh",
            [
                SSH_STUB_ARGS,
                'if [ "$host" = host1 ]; then cat >/dev/null; echo "toli: no delegation of T1 to m3/T1 is recorded here" >&2; exit 1; fi',
                `[ "$host" = host2 ] || { echo "ssh: connect to host $host port 22: Connection refused" >&2; exit 255; }`,
                `cmd=$(printf '%s' "$cmd" | sed "s#bin/toli #'${process.execPath}' '${TOLI_BIN}' #")`,
                `TOLI_ROOT="${m2.root}" exec sh -c "$cmd"`,
            ].join("\n"),
        );
    }

    test("refuses once: the task stops reporting there, with one alert, and still reports to its delegator", () => {
        const machines = trio();
        const { m1, m2, m3 } = machines;
        withProject(m1, "app");
        m1.ok(["task", "add", "app", "parent work"]);
        m1.ok(["delegate", "m2", "the work", "--brief", brief(m1), "--for", "T1"]);
        m2.ok(["delegate", "m3", "forwarded work", "--brief", brief(m2), "--for", "T1"]);
        expect(tasks(m3)[0]?.delegatedBy?.upstream).toEqual([{ machine: "m1", task: "T1" }]);
        refusingAbove(machines);

        const started = m3.toli(["task", "start", "T1", "--agent", "OwnSub"]);
        expect(started.code).toBe(0);
        expect(started.stderr).toContain("T1: m1 refused its report: no delegation of T1 to m3/T1 is recorded here");
        expect(started.stderr).not.toContain("the minute tick retries");
        const by = tasks(m3)[0]?.delegatedBy;
        expect(by).toMatchObject({ machine: "m2", task: "T1", refusedBy: ["m1"] });
        m3.ok(["task", "hold", "T1", "--question", "Which?", "--option", "a => fast", "--option", "b => slow"]);
        m3.ok(["task", "answer", "T1", "a"]);

        const refused = JSON.parse(m3.ok(["outbox", "list", "--cancelled", "--json"])) as Array<{ reason: string }>;
        expect(refused.map((item) => item.reason)).toEqual([
            "m1 refused it: no delegation of T1 to m3/T1 is recorded here",
        ]);
        const alerts = inbox(m3).filter((item) => item.title.includes("not sent"));
        expect(alerts).toHaveLength(1);
        expect(readFileSync(alerts[0]?.path ?? "", "utf8")).toContain(
            "m3/T1 no longer reports to m1: it records no delegation of T1 to m3/T1",
        );
        expect(tasks(m2)[0]?.notes).toContain("m3/T1 is held");
    });
});
