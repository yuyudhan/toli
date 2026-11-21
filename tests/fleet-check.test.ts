// `bin/toli fleet check`: idle machines with waiting work, stale tasks, and the hourly check that never pauses.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENV, fleet, remoteSnapshot } from "./fleet-fixture.ts";
import { type Sandbox, SSH_STUB_ARGS, sandbox, withProject } from "./helpers.ts";

const START = "2026-03-04T08:00:00.000Z";

function inbox(box: Sandbox): string[] {
    const dir = join(box.root, "data", "inbox");
    return existsSync(dir)
        ? readdirSync(dir)
              .sort()
              .map((file) => readFileSync(join(dir, file), "utf8"))
        : [];
}

/** Answer m2's `resources --json` from `.m2.json` and its `fleet check --local --json` from `.m2-check.json`. */
function stubFleetCheck(box: Sandbox, m2Check: Record<string, unknown>): void {
    writeFileSync(join(box.root, ".m2-check.json"), JSON.stringify({ machine: "m2", ...m2Check }));
    box.stub(
        "ssh",
        [
            SSH_STUB_ARGS,
            'case "$host" in',
            `  host2) case "$cmd" in *"resources --json"*) cat "${join(box.root, ".m2.json")}" ;; *"fleet check --local --json"*) cat "${join(box.root, ".m2-check.json")}" ;; *) exit 1 ;; esac ;;`,
            "  *) echo 'ssh: connect to host host3 port 22: Connection refused' >&2; exit 255 ;;",
            "esac",
        ].join("\n"),
    );
}

describe("oversight never pauses in away mode", () => {
    test("fleet check names idle machines with waiting work for their clones, and each machine's stale tasks", () => {
        const box = fleet(remoteSnapshot("m2", { projects: ["alpha"] }));
        box.stub("omp", "true");
        withProject(box, "alpha");
        box.ok(["task", "add", "alpha", "queued slice"]);
        stubFleetCheck(box, {
            stale: [{ line: "T9 (alpha) is active but its run j-1 ended 3h ago", command: "re-dispatch it now" }],
            waiting: [{ id: "T9", project: "alpha", status: "active", title: "own slice" }],
        });
        writeFileSync(join(box.root, "state", "afk"), START);

        const output = box.ok(["fleet", "check", "--wake"], { env: ENV, now: "2026-03-04T09:00:00.000Z" });
        expect(output.split("\n").slice(0, 2)).toEqual([
            "fleet check at 2026-03-04T09:00:00.000Z: 1 active task with no live run, 2 idle machines with waiting work",
            "Lead: dispatch now (toli-dispatch skill), spreading the waiting work over the idle machines; away mode changes nothing here.",
        ]);
        expect(output).toContain("- [m2] T9 (alpha) is active but its run j-1 ended 3h ago\n  re-dispatch it now");
        expect(output).toContain("- m1: T1 (alpha, queued): queued slice\n");
        expect(output).toContain("- m2: T1 (alpha, queued): queued slice; T9 (alpha, active): own slice\n");
        expect(output).toMatch(/- m3: unreachable: ssh host3 exited 255/);
        const [posted] = inbox(box);
        expect(posted).toStartWith("# fleet check: 1 stale task, 2 idle machines with waiting work\n");
    });

    test("a machine whose jawans run as native subagents is busy, not idle; one with truly no jawan stays idle", () => {
        const at = "2026-03-04T09:00:00.000Z";
        const busy = { queued: 1, active: 2, held: 0, jawansRunning: 2, subagents: 2, jawansQueued: 0, depth: 3 };
        const box = fleet(remoteSnapshot("m2", { projects: ["alpha"], queue: busy }));
        withProject(box, "alpha");
        box.ok(["task", "add", "alpha", "queued slice"]);
        box.ok(["task", "add", "alpha", "subagent slice"]);
        // The lead's in-session subagent (omp task tool), not a `bin/toli spawn` run: no active run here.
        box.ok(["task", "start", "T2", "--agent", "T12Sub"], { now: at });
        stubFleetCheck(box, { stale: [], waiting: [{ id: "T5", project: "alpha", status: "queued", title: "own" }] });
        const idleMachines = (): string[] => {
            // `fleet check --json` prints a FleetCheck (src/fleet/oversight.ts).
            const check: { idle: { machine: string }[] } = JSON.parse(
                box.ok(["fleet", "check", "--json"], { env: ENV, now: at }),
            );
            return check.idle.map((machine) => machine.machine);
        };

        expect(idleMachines()).toEqual([]);

        writeFileSync(join(box.root, ".m2.json"), remoteSnapshot("m2", { projects: ["alpha"] }));
        expect(idleMachines()).toEqual(["m2"]);
    });

    test("the coordinator's tick runs the fleet check hourly while away, instead of staying silent", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        withProject(box, "alpha");
        box.ok(["task", "add", "alpha", "queued slice"]);
        writeFileSync(join(box.root, "state", "afk"), START);
        box.ok(["job", "tick"], { now: "2026-03-04T09:00:00.000Z" });
        const checks = (): string[] => inbox(box).filter((item) => item.startsWith("# fleet check:"));
        expect(checks()).toHaveLength(1);
        expect(checks()[0]).toContain("- m1: T1 (alpha, queued): queued slice");
        expect(readFileSync(join(box.root, "logs", "tick.log"), "utf8")).toContain("fleet check: posted data/inbox/");
        box.ok(["job", "tick"], { now: "2026-03-04T09:30:00.000Z" });
        expect(checks()).toHaveLength(1);
        box.ok(["job", "tick"], { now: "2026-03-04T10:00:00.000Z" });
        expect(checks()).toHaveLength(2);
    });

    // T2030: a coordinator reached none of 15 machines for 2 h 44 m and its fleet check still said "all clear".
    test("when more than half the machines cannot be checked, fleet check and fleet status say BLIND first", () => {
        const at = "2026-03-04T09:00:00.000Z";
        const box = fleet(remoteSnapshot("m2", { projects: ["alpha"] }));
        box.stub(
            "ssh",
            [SSH_STUB_ARGS, "echo 'ssh: connect to host port 22: Connection refused' >&2", "exit 255"].join("\n"),
        );

        const output = box.ok(["fleet", "check", "--wake"], { env: ENV, now: at });
        const lines = output.split("\n");
        expect(lines[0]).toBe(
            `fleet check at ${at}: BLIND: 2 of 3 machines not checked (m2, m3), so no all clear: what they run is unknown`,
        );
        expect(output).not.toContain("all clear,");
        // Both other machines refuse the same way: one network fault line stands for them (src/fleet/network-fault.ts).
        expect(output).toContain(
            "\n- network fault: 2 of 2 other machines unreachable the same way (connection refused): m2, m3;",
        );
        expect(output).not.toMatch(/\n- m[23]: unreachable: /);
        const [posted] = inbox(box);
        expect(posted).toStartWith("# fleet check: BLIND, 2 of 3 machines not checked\n");
        const json = JSON.parse(box.ok(["fleet", "check", "--json"], { env: ENV, now: at })) as { blind: boolean };
        expect(json.blind).toBe(true);

        const status = box.ok(["fleet", "status"], { env: ENV }).split("\n");
        expect(status[0]).toBe("BLIND: 2 of 3 machines not measured (m2, m3)");
        expect(status.slice(1).some((line) => line.startsWith("m2: unavailable: unreachable"))).toBe(true);
    });

    test("one machine of three unreachable is no blind check: all clear names it as not checked", () => {
        const at = "2026-03-04T09:00:00.000Z";
        const box = fleet(remoteSnapshot("m2", { projects: [] }));
        stubFleetCheck(box, { stale: [], waiting: [] });
        const output = box.ok(["fleet", "check"], { env: ENV, now: at });
        expect(output).toStartWith(`fleet check at ${at}: all clear, `);
        expect(output).toContain("; not checked: m3 (");
        expect(box.ok(["fleet", "status"], { env: ENV })).not.toContain("BLIND");
    });
});
