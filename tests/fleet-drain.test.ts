// T497: `bin/toli fleet reboot --drain` (docs/fleet.md "Rebooting the fleet"): pause new dispatch on every machine of
// the wave, wait (bounded) for running gates and push checks to finish, reboot in one wave, then resume dispatch as
// each machine comes back; it reports what it waited on and what it cut. `fleet drain pause|status|resume` is each
// machine's own step.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DrainRunner, type MachineDrain, rebootFleet } from "../src/fleet/drain.ts";
import type { LocalDrain } from "../src/fleet/drain-local.ts";
import { sandbox } from "./helpers.ts";

const BOOT = "2026-11-23T10:00:00.000Z";
const NEW_BOOT = "2026-11-23T17:20:00.000Z";
const POLL_MS = 30_000;

function drain(machine: string, fields: Partial<LocalDrain> = {}): LocalDrain {
    return { machine, bootedAt: BOOT, paused: true, gates: [], pushChecks: [], jawans: [], unread: [], ...fields };
}

type World = {
    /** Per machine, what each read in turn finds (the last one repeats): the pause's own read first. */
    rounds?: Record<string, Partial<LocalDrain>[]>;
    unreachable?: string[];
    rebootFails?: string[];
    neverBack?: string[];
};

/** A fake fleet: records every step in order and advances its clock only when the drain sleeps. */
function fakeFleet(world: World): { runner: DrainRunner; events: string[] } {
    const events: string[] = [];
    const reads = new Map<string, number>();
    const rebooted = new Set<string>();
    let clock = 0;
    const read = (machine: string): MachineDrain => {
        if (world.unreachable?.includes(machine)) return { machine, drain: null, error: "ssh: connection refused" };
        if (rebooted.has(machine))
            return world.neverBack?.includes(machine)
                ? { machine, drain: null, error: "no answer within 20s" }
                : { machine, drain: drain(machine, { bootedAt: NEW_BOOT, paused: false }), error: null };
        const rounds = world.rounds?.[machine] ?? [{}];
        const count = reads.get(machine) ?? 0;
        reads.set(machine, count + 1);
        return { machine, drain: drain(machine, rounds[Math.min(count, rounds.length - 1)]), error: null };
    };
    const runner: DrainRunner = {
        pause: async (machines, minutes) => {
            events.push(`pause ${machines.join(",")} for ${minutes} min`);
            return machines.map(read);
        },
        status: async (machines) => {
            events.push(`status ${machines.join(",")}`);
            return machines.map(read);
        },
        reboot: async (machines) => {
            events.push(`reboot ${machines.join(",")}`);
            return machines.map((machine) => {
                if (world.unreachable?.includes(machine)) return { machine, error: "ssh: connection refused" };
                if (world.rebootFails?.includes(machine)) return { machine, error: "sudo: a password is required" };
                rebooted.add(machine);
                return { machine, error: null };
            });
        },
        resume: async (machines) => {
            events.push(`resume ${machines.join(",")}`);
            return machines.map((machine) => ({ machine, drain: drain(machine, { paused: false }), error: null }));
        },
        sleep: async (ms) => {
            clock += ms;
        },
        clock: () => clock,
    };
    return { runner, events };
}

const plan = (fields: Partial<Parameters<typeof rebootFleet>[1]> = {}): Parameters<typeof rebootFleet>[1] => ({
    machines: ["m2", "m3"],
    self: null,
    drain: true,
    waitMs: 30 * 60_000,
    pollMs: POLL_MS,
    backMs: 10 * 60_000,
    progress: () => undefined,
    ...fields,
});

describe("fleet reboot --drain", () => {
    test("pauses, waits for the gates and push checks, reboots in one wave, then resumes", async () => {
        const gate = "alpha aaaaaaaaaaaa: just verify (pid 41)";
        const push = "no-mistakes run r-7 (running)";
        const { runner, events } = fakeFleet({
            rounds: {
                m2: [{ gates: [gate] }, { gates: [gate] }, {}],
                m3: [{ pushChecks: [push], jawans: ["j-1 (T41)"] }, { jawans: ["j-1 (T41)"] }],
            },
        });
        const report = await rebootFleet(runner, plan());

        expect(events).toEqual([
            "pause m2,m3 for 70 min",
            "status m2,m3",
            "status m2,m3",
            "reboot m2,m3",
            "status m2,m3",
            "resume m2,m3",
        ]);
        expect(report.paused).toEqual(["m2", "m3"]);
        expect(report.waitedOn).toEqual([
            { machine: "m2", what: `gate ${gate}` },
            { machine: "m3", what: `push check ${push}` },
        ]);
        expect(report.drained).toBe(true);
        expect(report.waitedMs).toBe(2 * POLL_MS);
        expect(report.cut).toEqual([{ machine: "m3", what: "jawan j-1 (T41)" }]);
        expect(report.rebooted).toEqual(["m2", "m3"]);
        expect(report.resumed).toEqual(["m2", "m3"]);
        expect(report.notBack).toEqual([]);
    });

    test("the wait is bounded: past it the wave reboots anyway and names what it cut", async () => {
        const gate = "alpha aaaaaaaaaaaa: just verify (pid 41)";
        const { runner, events } = fakeFleet({ rounds: { m2: [{ gates: [gate] }] } });
        const report = await rebootFleet(runner, plan({ machines: ["m2"], waitMs: 3 * POLL_MS }));

        expect(events).toEqual([
            "pause m2 for 42 min",
            "status m2",
            "status m2",
            "status m2",
            "reboot m2",
            "status m2",
            "resume m2",
        ]);
        expect(report.drained).toBe(false);
        expect(report.waitedMs).toBe(3 * POLL_MS);
        expect(report.cut).toEqual([{ machine: "m2", what: `gate ${gate}` }]);
    });

    test("a machine not paused is named as cut; one that did not reboot resumes at once", async () => {
        const { runner, events } = fakeFleet({ unreachable: ["m3"], rebootFails: ["m2"] });
        const report = await rebootFleet(runner, plan());

        expect(events).toEqual(["pause m2,m3 for 70 min", "reboot m2,m3", "resume m2"]);
        expect(report.notPaused).toEqual([{ machine: "m3", reason: "ssh: connection refused" }]);
        expect(report.cut).toEqual([{ machine: "m3", what: "not drained: ssh: connection refused" }]);
        expect(report.rebooted).toEqual([]);
        expect(report.notRebooted).toEqual([
            { machine: "m2", reason: "sudo: a password is required" },
            { machine: "m3", reason: "ssh: connection refused" },
        ]);
        expect(report.resumed).toEqual(["m2"]);
    });

    test("a machine not back within the bound resumes by itself at boot", async () => {
        const { runner, events } = fakeFleet({ neverBack: ["m2"] });
        const report = await rebootFleet(runner, plan({ machines: ["m2"], backMs: 2 * POLL_MS }));

        expect(events).toEqual(["pause m2 for 61 min", "reboot m2", "status m2", "status m2"]);
        expect(report.resumed).toEqual([]);
        expect(report.notBack).toEqual(["m2"]);
    });

    test("--self reboots this machine last, after the others resumed", async () => {
        const { runner, events } = fakeFleet({});
        const report = await rebootFleet(runner, plan({ machines: ["m2"], self: "m1" }));

        expect(events).toEqual(["pause m1,m2 for 70 min", "reboot m2", "status m2", "resume m2", "reboot m1"]);
        expect(report.rebooted).toEqual(["m2", "m1"]);
        expect(report.resumed).toEqual(["m2"]);
    });

    test("without --drain it reboots at once, naming what it cut", async () => {
        const gate = "alpha aaaaaaaaaaaa: just verify (pid 41)";
        const { runner, events } = fakeFleet({ rounds: { m2: [{ gates: [gate], paused: false }] } });
        const report = await rebootFleet(runner, plan({ machines: ["m2"], drain: false }));

        expect(events).toEqual(["status m2", "reboot m2"]);
        expect(report.paused).toEqual([]);
        expect(report.cut).toEqual([{ machine: "m2", what: `gate ${gate}` }]);
        expect(report.resumed).toEqual([]);
    });
});

describe("fleet drain: each machine's own step", () => {
    test("a pause holds new jawan runs until resumed, names running gates and push checks, and ends with the boot", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const gates = join(box.root, "state", "gates", "alpha");
        mkdirSync(gates, { recursive: true });
        writeFileSync(
            join(gates, `${"b".repeat(40)}-0123456789abcdef.json`),
            JSON.stringify({
                project: "alpha",
                sha: "a".repeat(40),
                tree: "b".repeat(40),
                recipe: "just verify",
                dir: box.root,
                status: "running",
                pid: process.pid,
                startedAt: "",
                endedAt: null,
            }),
        );
        const nm = join(box.root, ".no-mistakes");
        const worktree = join(nm, "worktrees", "repo1", "r-7");
        mkdirSync(worktree, { recursive: true });
        const db = new Database(join(nm, "state.sqlite"));
        db.run("CREATE TABLE runs (id TEXT, repo_id TEXT, status TEXT, worktree_dir TEXT)");
        db.run("INSERT INTO runs VALUES ('r-7', 'repo1', 'running', NULL), ('r-6', 'repo1', 'completed', NULL)");
        db.close();

        const paused = JSON.parse(box.ok(["fleet", "drain", "pause", "--minutes", "60", "--json"])) as LocalDrain;
        expect(paused.paused).toBe(true);
        expect(paused.gates).toEqual([`alpha aaaaaaaaaaaa: just verify (pid ${process.pid})`]);
        expect(paused.pushChecks).toEqual(["no-mistakes run r-7 (running)"]);

        box.stub("omp", "true");
        const brief = join(box.root, "brief.md");
        writeFileSync(brief, "TOLI_BRIEF v1\nsay hi\n");
        const spawned = box.ok(["spawn", "--harness", "omp", "--brief", brief, "--cwd", box.root]);
        expect(spawned).toMatch(/^queued j-\S+: new jobs paused \(since \S+\): fleet reboot --drain/m);

        const resumed = JSON.parse(box.ok(["fleet", "drain", "resume", "--json"])) as LocalDrain;
        expect(resumed.paused).toBe(false);

        // A pause set in an earlier boot is over: the machine rebooted since.
        const file = join(box.root, "state", "dispatch-pause.json");
        const until = new Date(Date.now() + 60 * 60_000).toISOString();
        writeFileSync(file, JSON.stringify({ reason: "fleet reboot --drain", since: BOOT, until, bootedAt: BOOT }));
        expect((JSON.parse(box.ok(["fleet", "drain", "status", "--json"])) as LocalDrain).paused).toBe(false);
    });
});
