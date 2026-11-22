// T2265: a task parked with `task wait --on "<a free slot here>"` is queue: it waits only for a jawan slot on this
// machine, so `resources`, `fleet queues`, `pick`, the balancing pass, `fleet check` and the idle watchdog count it.
// A wait on anything else is not queue.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitsForSlot } from "../src/records/slot-wait.ts";
import { pair } from "./delegate-fixture.ts";
import { ENV, editBacklog, fleet, liveRun, ROOMY, remoteSnapshot, resourcesQueue, VM_STAT } from "./fleet-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";
import { pass, queued, queueItems, T0, withTasks } from "./queues-fixture.ts";

/** The verifier's synthetic list (T2265-verify.md): the documented grammar and nothing else. */
const COUNTED = [
    "slot",
    "Slot (3/3 busy)",
    "slot: after T610",
    "  SLOT; T2 first  ",
    "slot (3/3). then the staging check",
    "slot: check abc123 on main",
    "a free slot",
    "the free slot",
    "next free slot",
    "next free WEB slot",
    "next free jawan slot (3/3)",
    "next free web slot, after T610",
    "next free web slot after T598",
];
const REFUSED = [
    "the owner's answer on the redesign",
    "the v0.3.48 release",
    "push of T547 to origin",
    "m3/T88 (delegated)",
    "a build machine with the clone when a slot frees",
    "waiting for a slot to free on m3",
    "when a slot frees",
    "T610 then a free slot",
    "slotted after T610",
    "slotting review with the owner",
    "next free CPU",
    "the free tier reset",
    "a free moment of the owner's",
    "release slot on Thursday",
    // Another machine's slot.
    "a slot on m3",
    "next free slot on m3",
    "slot 3 on m3",
    "slot (3/3 busy) on m3",
    "slot: after T610 on M3.",
    // Not a jawan slot.
    "the slot machine refactor T500",
    "slot-machine fix lands (T500)",
    "free heavy-build slot",
    "a free gpu slot",
    "next free build slot",
    // Forms the grammar does not have.
    "a slot",
    "the slot",
    "next slot",
    "the next slot",
    "the next free slot",
    "a a free slot",
    "slots",
];

/** Park `id` with `task wait --on <on>`. */
function wait(box: Sandbox, id: string, on: string): void {
    box.ok(["task", "wait", id, "--on", on]);
}

describe("waits on a free slot here are queue (T2265)", () => {
    test("the matcher takes exactly the documented grammar, never another machine's slot", () => {
        const others = ["m2", "m3"];
        const counted = (waitingOn: string) => waitsForSlot({ status: "active", waitingOn }, others);
        expect(COUNTED.filter((text) => !counted(text))).toEqual([]);
        expect(REFUSED.filter(counted)).toEqual([]);
        expect(waitsForSlot({ status: "queued", waitingOn: "slot" }, others)).toBe(false);
        expect(waitsForSlot({ status: "held", waitingOn: "slot" }, others)).toBe(false);
        expect(waitsForSlot({ status: "active" }, others)).toBe(false);
    });

    test("slot waits count toward depth; waits on a person, a release, another machine or a held task do not", () => {
        const box = withTasks(queued(0), 9);
        wait(box, "T1", "slot: after T610, then the staging check");
        wait(box, "T2", "next free WEB slot (3/3 busy, 8 pieces queued ahead)");
        wait(box, "T3", "a free slot");
        wait(box, "T4", "the owner's answer on the redesign");
        wait(box, "T5", "the v0.3.48 release");
        wait(box, "T6", "m3 T546 reaching origin/main");
        wait(box, "T7", "a build machine with the clone when a slot frees");
        // A slot wait whose jawan then started works as that run, once; a held one is not queue.
        wait(box, "T8", "slot");
        liveRun(box, "j-1", "T8");
        wait(box, "T9", "next free slot");
        editBacklog(box, (tasks) => {
            const t9 = tasks.find((task) => task.id === "T9");
            if (t9 === undefined) throw new Error("no T9");
            t9.status = "held";
        });

        expect(resourcesQueue(box)).toMatchObject({ queued: 0, slotWaits: 3, jawansRunning: 1, depth: 4 });
        expect(box.ok(["fleet", "queues"], { env: ENV })).toContain(
            "m1 (this machine): queue 4 (0 queued + 3 waiting for a slot, 1 running + 0 waiting; 8 active, 1 held)",
        );
    });

    test("pick sees a machine at cap with slot waits as deeper than one with fewer queued per slot", () => {
        const box = fleet(queued(3), { ...ROOMY, maxRuns: 3 });
        withProject(box, "x");
        for (let n = 1; n <= 5; n++) box.ok(["task", "add", "x", `task ${n}`]);
        for (const n of [1, 2, 3]) box.ok(["task", "start", `T${n}`, "--agent", `T${n}Sub`]);
        wait(box, "T4", "next free x slot (3/3 busy)");
        wait(box, "T5", "slot (3/3 busy)");
        // m1: 3 running + 2 slot waits over 3 slots (1.67) against m2's 3 queued over 2 slots (1.5).
        expect(resourcesQueue(box)).toMatchObject({ jawansRunning: 3, slotWaits: 2, depth: 5 });
        expect(box.ok(["pick"], { env: ENV })).toBe("m2");
    });

    test("the balancing pass counts slot waits and offers them with --for; other waits stay here", async () => {
        const box = withTasks(queued(0), 4);
        wait(box, "T1", "slot");
        wait(box, "T2", "next free x slot");
        wait(box, "T3", "a free slot");
        wait(box, "T4", "the push");
        expect(await pass(box, T0)).toBe("queue: offered work to m2 (m1 3, m2 0)");
        const [offer] = queueItems(box);
        for (const id of ["T1", "T2", "T3"])
            expect(offer).toMatch(new RegExp(`${id}: bin/toli delegate m2 .* --for ${id}(\\n|$)`));
        expect(offer).not.toContain("T4:");
    });

    test("an older toli's queue without slotWaits keeps its own depth", () => {
        const old = { queued: 2, active: 5, held: 0, jawansRunning: 1, jawansQueued: 0, depth: 3 };
        const box = withTasks(queued(0, { queue: old }), 0);
        const json = JSON.parse(box.ok(["fleet", "queues", "--json"], { env: ENV })) as {
            machines: { machine: string; queue: Record<string, unknown> | null }[];
        };
        const m2 = json.machines.find((row) => row.machine === "m2");
        expect(m2?.queue).toEqual(old);
        expect(box.ok(["fleet", "queues"], { env: ENV })).toContain(
            "m2: queue 3 (2 queued, 1 running + 0 waiting; 5 active, 0 held)",
        );
    });

    test("fleet check counts a slot wait as waiting work only when the queue does: not run here, not delegated", () => {
        const box = withTasks(queued(0), 4);
        for (const id of ["T1", "T2", "T3", "T4"]) wait(box, id, "slot (3/3 busy)");
        liveRun(box, "j-1", "T1");
        editBacklog(box, (tasks) => {
            for (const task of tasks) {
                if (task.id === "T2")
                    Object.assign(task, { delegatedTo: ["m2/T1"], delegates: { "m2/T1": { status: "queued" } } });
                if (task.id === "T3") task.status = "held"; // its wait text left behind
            }
        });
        const check = JSON.parse(box.ok(["fleet", "check", "--local", "--json"], { env: ENV })) as {
            waiting: { id: string }[];
        };
        expect(check.waiting.map((task) => task.id)).toEqual(["T4"]);
        expect(resourcesQueue(box)).toMatchObject({ slotWaits: 1 });
    });

    test("the idle watchdog alerts on a slot wait here, never on one delegated away or a wait on something else", () => {
        const box = fleet(remoteSnapshot("m2"));
        withProject(box, "alpha");
        box.stub("omp", "true");
        for (const title of ["own piece", "handed piece", "pushed piece"]) box.ok(["task", "add", "alpha", title]);
        wait(box, "T1", "slot");
        wait(box, "T2", "slot");
        wait(box, "T3", "the push");
        editBacklog(box, (tasks) => {
            const t2 = tasks.find((task) => task.id === "T2");
            if (t2 === undefined) throw new Error("no T2");
            Object.assign(t2, { delegatedTo: ["m2/T9"], delegates: { "m2/T9": { status: "active" } } });
        });
        mkdirSync(join(box.root, "state", "agents"), { recursive: true });
        writeFileSync(
            join(box.root, "state", "agents", "Done.json"),
            JSON.stringify({ at: "2026-03-04T08:00:00.000Z" }),
        );
        box.ok(["job", "tick"], { now: "2026-03-04T08:31:00.000Z" });
        const alerts = readdirSync(join(box.root, "data", "inbox"))
            .map((file) => readFileSync(join(box.root, "data", "inbox", file), "utf8"))
            .filter((item) => item.startsWith("# m1: no agent activity for"));
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toContain("with 1 task waiting");
        expect(alerts[0]).toContain("- T1 (alpha, active): own piece");
        expect(alerts[0]).not.toContain("handed piece");
        expect(alerts[0]).not.toContain("pushed piece");
    });

    test("an offer taken as written hands the slot wait over: it leaves this machine's queue and fleet check", async () => {
        const { m1, m2 } = pair();
        m1.stub("vm_stat", `cat <<'EOF'\n${VM_STAT}\nEOF`);
        withProject(m1, "x");
        withProject(m2, "x");
        for (const n of [1, 2, 3]) {
            m1.ok(["task", "add", "x", `piece ${n}`]);
            // T1 still names the subagent that worked on it before it was parked (a leftover seen in the fleet).
            if (n === 1) m1.ok(["task", "start", "T1", "--agent", "OldSub"]);
            wait(m1, `T${n}`, "slot (3/3 busy)");
        }
        const briefs = join(m1.root, "data", "projects", "x", "briefs");
        mkdirSync(briefs, { recursive: true });
        writeFileSync(join(briefs, "T1.md"), "TOLI_BRIEF v1\n# piece 1\nReply done.\n");
        expect(resourcesQueue(m1)).toMatchObject({ slotWaits: 3, depth: 3 });
        expect(await pass(m1, T0)).toBe("queue: offered work to m2 (m1 3, m2 0)");
        const line = queueItems(m1)[0]
            ?.split("\n")
            .find((entry) => entry.startsWith("  T1: "));
        if (line === undefined) throw new Error("no offer line for T1");
        const words = [...line.replace("  T1: bin/toli ", "").matchAll(/'([^']*)'|(\S+)/g)].map(
            (match) => match[1] ?? match[2] ?? "",
        );
        const at = words.indexOf("--brief") + 1;
        words[at] = join(m1.root, words[at] ?? "");
        expect(m1.ok(words)).toContain("delegated to m2/T1");

        expect(resourcesQueue(m1)).toMatchObject({ slotWaits: 2, depth: 2 });
        const check = JSON.parse(m1.ok(["fleet", "check", "--local", "--json"], { env: ENV })) as {
            waiting: { id: string }[];
        };
        expect(check.waiting.map((task) => task.id)).toEqual(["T2", "T3"]);
        expect(m2.ok(["task", "list"])).toContain("piece 1");
        // A slot wait has no own jawan: the taken offer is T1's delegation, not a slice beside the old subagent, so
        // T1 works through m2/T1 and closes with it.
        const t1 = (
            JSON.parse(m1.ok(["task", "list", "--json"])) as {
                id: string;
                agent?: string;
                delegatedTo?: string[];
                slices?: string[];
            }[]
        ).find((task) => task.id === "T1");
        expect(t1).toMatchObject({ agent: "m2/T1", delegatedTo: ["m2/T1"] });
        expect(t1?.slices ?? []).toEqual([]);
    });
});
