// `task handback` on work forwarded on (A -> B -> C, T822): the handback returns the work to B, the machine that
// delegated it to C, whose task is queued again with the reason. A follows the chain through B's report and never
// gets a handback notice for a delegation it did not make, so it never refuses one ("no delegation ... is recorded
// here", src/peer/envelope.ts).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { brief, inbox, type Task, type Trio, tasks, trio } from "./delegate-fixture.ts";
import { type Sandbox, SSH_STUB_ARGS, TOLI_BIN, withProject } from "./helpers.ts";

function t1(box: Sandbox): Task {
    const task = tasks(box).find((entry) => entry.id === "T1");
    if (task === undefined) throw new Error("no T1");
    return task;
}

/** m1's T1 delegated to m2 as m2/T1, which m2 forwards to m3 as m3/T1 (`--for T1`) and keeps open. */
function forwarded(): Trio {
    const machines = trio();
    const { m1, m2 } = machines;
    withProject(m1, "app");
    m1.ok(["task", "add", "app", "parent work"]);
    m1.ok(["delegate", "m2", "the work", "--brief", brief(m1), "--for", "T1"]);
    m2.ok(["delegate", "m3", "forwarded work", "--brief", brief(m2), "--for", "T1"]);
    return machines;
}

describe("a handback of forwarded work (m1 -> m2 -> m3)", () => {
    test("reaches m2, whose task is queued again with the reason; m1 gets no handback notice", () => {
        const { m1, m2, m3 } = forwarded();
        expect(t1(m3).delegatedBy).toMatchObject({ machine: "m2", upstream: [{ machine: "m1", task: "T1" }] });
        expect(m3.ok(["task", "handback", "T1", "--reason", "not cloned here"])).toContain(
            "handed back to m2: not cloned here",
        );

        const mine = t1(m2);
        expect(mine.status).toBe("queued");
        expect(mine.agent).toBeUndefined();
        expect(mine.notes).toContain("m3/T1 handed the work back: not cloned here");
        const wake = inbox(m2).find((item) => item.title === "m3/T1 handed back: forwarded work");
        expect(readFileSync(wake?.path ?? "", "utf8")).toContain("T1 is queued again");

        // m1 follows the chain through m2's report: m2 holds the work again, so m1's task works through m2/T1.
        expect(inbox(m1).map((item) => item.title)).not.toContain("m3/T1 handed back: forwarded work");
        const following = t1(m1);
        expect(following).toMatchObject({ status: "active", agent: "m2/T1" });
        expect(following.delegates?.["m2/T1"]?.status).toBe("queued");
        expect(following.delegates?.["m3/T1"]).toMatchObject({ status: "dropped", handedBack: "not cloned here" });
    });

    test("never goes to a machine above that records no delegation to it, so nothing bounces", () => {
        const machines = forwarded();
        const { m2, m3 } = machines;
        // m3's ssh: m1 refuses every update as src/peer/envelope.ts does for a delegation it never recorded.
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
        const handed = m3.toli(["task", "handback", "T1", "--reason", "wrong machine"]);
        expect(handed.code).toBe(0);
        expect(handed.stderr).not.toContain("refused");
        expect(JSON.parse(m3.ok(["outbox", "list", "--cancelled", "--json"]))).toEqual([]);
        expect(inbox(m3).filter((item) => item.title.includes("not sent"))).toEqual([]);
        expect(t1(m2).status).toBe("queued");
    });
});
