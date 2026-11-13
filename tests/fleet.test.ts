import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execKillMs } from "../src/fleet/remote.ts";
import { ENV, fleet, ROOMY, remoteSnapshot, sshLog } from "./fleet-fixture.ts";
import { type Sandbox, sandbox, withProject } from "./helpers.ts";

type Snapshot = { machine: string; available: boolean; reasons: string[]; activeRuns: number };
type Entry = { machine: string; local: boolean; reachable: boolean; available: boolean; reasons: string[] };
type Pick = { machine: string | null; local: boolean; depth: number | null; candidates: { machine: string }[] };

/** What `remote` and `exec --from <other machine>` say instead of starting a jawan for another machine. */
const POINTER = "no machine starts a jawan on another machine; choose with `bin/toli pick --project <p>`";

describe("fleet status", () => {
    test("an unreachable machine is reported unavailable, not fatal, and the rest still shows", () => {
        const box = fleet(remoteSnapshot("m2"));
        const entries = JSON.parse(box.ok(["fleet", "status", "--json"], { env: ENV })) as Entry[];
        expect(entries.map((entry) => [entry.machine, entry.local, entry.available])).toEqual([
            ["m1", true, true],
            ["m2", false, true],
            ["m3", false, false],
        ]);
        const m3 = entries.find((entry) => entry.machine === "m3");
        expect(m3?.reachable).toBe(false);
        expect(m3?.reasons[0]).toStartWith("unreachable: ssh host3 exited 255: ssh: connect to host host3");
    });

    test("garbage from a reachable machine counts as unreachable", () => {
        const box = fleet("not json at all");
        const entries = JSON.parse(box.ok(["fleet", "status", "--json"], { env: ENV })) as Entry[];
        const m2 = entries.find((entry) => entry.machine === "m2");
        expect(m2?.available).toBe(false);
        expect(m2?.reasons[0]).toStartWith("unreachable: bad resources output from host2");
    });

    test("a machine's self-reported unavailability is taken as is", () => {
        const box = fleet(remoteSnapshot("m2", { available: false, reasons: ["2 of 2 runs active"] }));
        const entries = JSON.parse(box.ok(["fleet", "status", "--json"], { env: ENV })) as Entry[];
        expect(entries.find((entry) => entry.machine === "m2")?.reasons).toEqual(["2 of 2 runs active"]);
    });
});

describe("pick", () => {
    test("skips the unreachable machine and picks among the rest", () => {
        const box = fleet(remoteSnapshot("m2"));
        const pick = JSON.parse(box.ok(["pick", "--json"], { env: ENV })) as Pick;
        expect(pick.candidates.map((candidate) => candidate.machine).sort()).toEqual(["m1", "m2"]);
        expect(pick.machine).not.toBeNull();
    });

    test("a disk under diskKeepGB never makes a machine unavailable", () => {
        const box = fleet(remoteSnapshot("m2"), { ...ROOMY, diskKeepGB: 1e12 });
        const pick = JSON.parse(box.ok(["pick", "--json"], { env: ENV })) as Pick;
        expect(pick.candidates.map((candidate) => candidate.machine)).toContain("m1");
    });

    test("load and memory never leave a machine out; only unreachable machines are rejected", () => {
        const box = fleet(remoteSnapshot("m2", { available: false, reasons: ["load 9/8 cpus over 0.8"] }), {
            ...ROOMY,
            minMemAvailableMB: 1e12,
        });
        const pick = JSON.parse(box.ok(["pick", "--json"], { env: ENV })) as Pick & {
            rejected: { machine: string }[];
        };
        expect(pick.candidates.map((candidate) => candidate.machine)).toEqual(["m1", "m2"]);
        expect(pick.rejected.map((entry) => entry.machine)).toEqual(["m3"]);
        expect(pick).toMatchObject({ machine: "m1", local: true, depth: 0 });
    });

    test("no qualifying machine exits 2 and says why for each machine", () => {
        const box = fleet(remoteSnapshot("m2"));
        const result = box.toli(["pick", "--project", "ghost"], { env: ENV });
        expect(result.code).toBe(2);
        expect(result.stdout).toContain("no machine qualifies:");
        expect(result.stdout).toContain("m1: no clone of ghost, and its git URL is not registered here");
        expect(result.stdout).toContain("m2: no clone of ghost, and its git URL is not registered here");
        expect(result.stdout).toContain("m3: unreachable: ");
    });
});

describe("remote refuses", () => {
    test("remote auto and remote <machine> exit 1 with the delegate pointer and send nothing over ssh", () => {
        const box = fleet(remoteSnapshot("m2"));
        for (const args of [
            ["remote", "auto", "do the thing"],
            ["remote", "m2", 'it\'s "quoted"; $(rm -rf /)'],
            ["remote", "m3", "x"],
        ]) {
            const result = box.toli(args, { env: ENV });
            expect(result.code).toBe(1);
            expect(result.stdout).toBe("");
            expect(result.stderr).toContain(POINTER);
            expect(result.stderr).toContain('bin/toli delegate <machine> "<title>" --brief <file> [--project <p>]');
        }
        expect(sshLog(box)).toBe("");
        expect(existsSync(join(box.root, "data", "remote"))).toBe(false);
    });
});

describe("run records", () => {
    test("exec records the run while omp runs and removes it when omp fails", () => {
        const box = fleet(remoteSnapshot("m2"));
        const runs = join(box.root, "state", "runs");
        box.stub("omp", `ls "${runs}"; exit 3`);
        const result = box.toli(["exec", "--from", "m1", "--task", "T4"], { env: ENV, stdin: "fix the build\n" });
        expect(result.code).toBe(3);
        expect(result.stdout).toMatch(/^exec-.*\.json$/m);
        expect(readdirSync(runs)).toEqual([]);
    });

    test("exec refuses a prompt issued by another machine and records nothing", () => {
        const box = fleet(remoteSnapshot("m2"));
        box.stub("omp", `touch "${join(box.root, ".omp-ran")}"`);
        const result = box.toli(["exec", "--from", "m2", "--task", "T4"], { env: ENV, stdin: "fix the build\n" });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("exec: prompt issued by m2: ");
        expect(result.stderr).toContain(POINTER);
        expect(existsSync(join(box.root, ".omp-ran"))).toBe(false);
        expect(existsSync(join(box.root, "state", "runs"))).toBe(false);
        expect(box.ok(["runs", "--json"])).toBe("[]");
    });

    test("exec refuses to start when this machine's run slots are full, so a target picked by name is not overloaded", () => {
        const box = fleet(remoteSnapshot("m2"), { ...ROOMY, maxRuns: 1 });
        const runs = join(box.root, "state", "runs");
        mkdirSync(runs, { recursive: true });
        writeFileSync(
            join(runs, "busy.json"),
            JSON.stringify({ runId: "busy", pid: process.pid, from: "m1", task: null, startedAt: "", title: "busy" }),
        );
        box.stub("omp", "echo started");
        const result = box.toli(["exec", "--from", "m1"], { env: ENV, stdin: "work\n" });
        expect(result.code).not.toBe(0);
        expect(result.stdout).not.toContain("started");
        expect(result.stderr).toContain("is full (1 of 1 runs active); not starting this run here");
        expect(box.ok(["runs", "--json"])).toBe("[]");
    });

    test("exec is a jawan run here: listed as running while omp runs, then done or failed with its log", () => {
        const box = fleet(remoteSnapshot("m2"));
        const jawans = join(box.root, "state", "jawans");
        box.stub("omp", `grep -h '"status"' "${jawans}"/*.json; echo "said ok"`);
        const result = box.toli(["exec", "--from", "m1", "--task", "T4"], {
            env: { ...ENV, TOLI_EXEC_PROJECT: "acme" },
            stdin: "[toli remote from m1 to m2]\nheader\n\nreply ok\n",
        });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('"status": "running"');
        expect(result.stderr).toMatch(/exec: recorded as run j-\S+ on /);
        const runs = JSON.parse(box.ok(["runs", "--json"])) as {
            status: string;
            task: string;
            project: string;
            harness: string;
            logPath: string;
            exitCode: number;
            endedAt: string | null;
        }[];
        expect(runs).toHaveLength(1);
        const [done] = runs;
        expect(done).toMatchObject({ status: "done", task: "T4", project: "acme", harness: "omp", exitCode: 0 });
        expect(done?.endedAt).not.toBeNull();
        expect(done?.logPath).toContain(join("data", "projects", "acme", "runs"));
        expect(readFileSync(done?.logPath ?? "", "utf8")).toContain("said ok");
        expect(box.ok(["runs", "--active"])).toBe("no active jawan runs");

        box.stub("omp", "exit 4");
        expect(box.toli(["exec", "--from", "m1"], { env: ENV, stdin: "fail\n" }).code).toBe(4);
        const failed = JSON.parse(box.ok(["runs", "--json"])) as { status: string; project: string | null }[];
        expect(failed.map((entry) => entry.status).sort()).toEqual(["done", "failed"]);
        expect(failed.find((entry) => entry.status === "failed")?.project).toBeNull();
    });

    test("exec hands the issuing machine and task to the run, so a push in it is logged as theirs", () => {
        const box = fleet(remoteSnapshot("m2"));
        box.stub("omp", `echo "by=$TOLI_ISSUED_BY task=\${TOLI_ISSUED_TASK-unset}"`);
        const run = (args: string[], env: Record<string, string> = {}): string =>
            box.ok(["exec", ...args], { env: { ...ENV, ...env }, stdin: "push it\n" });
        expect(run(["--from", "m1", "--task", "T4"])).toBe("by=m1 task=T4");
        // No --from: this machine issued it. No --task: an inherited TOLI_ISSUED_TASK must not leak into the run.
        expect(run([], { TOLI_ISSUED_TASK: "T99" })).toBe("by=m1 task=unset");
        expect(box.toli(["exec", "--task", "../x"], { env: ENV, stdin: "x\n" }).stderr).toContain(
            'invalid task name "../x"',
        );
    });

    test("remote with --task, --project or --max-time still refuses and runs no exec anywhere", () => {
        const box = fleet(remoteSnapshot("m2"));
        for (const flags of [
            ["--task", "T118"],
            ["--project", "acme"],
            ["--max-time", "5"],
            ["--max-time", "soon"],
        ]) {
            const result = box.toli(["remote", "m2", "ship it", ...flags], { env: ENV });
            expect(result.code).toBe(1);
            expect(result.stderr).toContain(POINTER);
        }
        expect(sshLog(box)).not.toContain("bin/toli exec");
        expect(box.ok(["runs", "--json"])).toBe("[]");
    });

    test("exec gives omp no time limit by default; an explicit one is killed 5 minutes after it", () => {
        const box = fleet(remoteSnapshot("m2"));
        box.stub("omp", 'echo "$*"');
        const run = (env: Record<string, string> = {}): string =>
            box.ok(["exec", "--from", "m1"], { env: { ...ENV, ...env }, stdin: "work\n" });
        const unlimited = run();
        expect(unlimited).not.toContain("--max-time");
        expect(unlimited).toContain("--session-dir ");
        expect(unlimited).toContain(" work");
        expect(run({ TOLI_EXEC_MAX_MINUTES: "5" })).toContain("--max-time 5m ");
        expect(execKillMs(5)).toBe(10 * 60 * 1000);
        expect(execKillMs(180)).toBe(185 * 60 * 1000);
        expect(execKillMs(null)).toBeUndefined();
    });

    test("only records whose pid is alive count; dead ones are deleted", () => {
        const box = fleet(remoteSnapshot("m2"));
        const runs = join(box.root, "state", "runs");
        mkdirSync(runs, { recursive: true });
        const dead = Bun.spawnSync(["true"]).pid;
        const record = (runId: string, pid: number): void =>
            writeFileSync(
                join(runs, `${runId}.json`),
                JSON.stringify({ runId, pid, from: "m1", task: null, startedAt: "x", title: "t" }),
            );
        record("dead", dead);
        record("alive", process.pid);
        const snapshot = JSON.parse(box.ok(["resources", "--json"], { env: ENV })) as Snapshot;
        expect(snapshot.activeRuns).toBe(1);
        expect(readdirSync(runs)).toEqual(["alive.json"]);
    });

    test("active runs at maxRuns make the machine unavailable", () => {
        const box = fleet(remoteSnapshot("m2"), { ...ROOMY, maxRuns: 1 });
        const runs = join(box.root, "state", "runs");
        mkdirSync(runs, { recursive: true });
        writeFileSync(join(runs, "a.json"), JSON.stringify({ runId: "a", pid: process.pid }));
        const snapshot = JSON.parse(box.ok(["resources", "--json"], { env: ENV })) as Snapshot;
        expect(snapshot.available).toBe(false);
        expect(snapshot.reasons).toEqual(["1 of 1 runs active"]);
    });
});

describe("project ensure", () => {
    function originOnly(): { box: Sandbox; url: string } {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        withProject(box, "x");
        const url = JSON.parse(box.ok(["project", "list", "--json"]))[0].url as string;
        return { box, url };
    }

    test("registered and cloned: no-op", () => {
        const { box, url } = originOnly();
        expect(box.ok(["project", "ensure", "x", url])).toContain("already registered and cloned");
    });

    test("clone present but unregistered: registers it without recloning", () => {
        const { box, url } = originOnly();
        box.ok(["project", "drop", "x"]);
        writeFileSync(join(box.root, "projects", "x", "local-marker"), "kept\n");
        expect(box.ok(["project", "ensure", "x", url])).toContain("registered the existing clone");
        expect(existsSync(join(box.root, "projects", "x", "local-marker"))).toBe(true);
        expect(box.ok(["project", "ensure", "x", url])).toContain("already registered and cloned");
    });

    test("neither: clones and registers, then is a no-op", () => {
        const { box, url } = originOnly();
        box.ok(["project", "drop", "x", "--delete-clone"]);
        expect(box.ok(["project", "ensure", "x", url, "--mode", "pr"])).toContain("cloned into");
        const listed = JSON.parse(box.ok(["project", "list", "--json"])) as {
            name: string;
            mode: string;
            cloned: boolean;
        }[];
        expect(listed.map((entry) => [entry.name, entry.mode, entry.cloned])).toEqual([["x", "pr", true]]);
        expect(box.ok(["project", "ensure", "x", url])).toContain("already registered and cloned");
    });
});

describe("legacy owner field", () => {
    test("is ignored by project list and dropped on the next write", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const file = join(box.root, "data", "projects.json");
        writeFileSync(
            file,
            JSON.stringify({
                projects: [
                    {
                        name: "old",
                        url: "git@example.com:a/old.git",
                        owner: "m9",
                        mode: "commit",
                        addedAt: "2026-01-01T00:00:00.000Z",
                    },
                ],
            }),
        );
        const listed = box.ok(["project", "list"]);
        expect(listed).toContain("old\tmode=commit");
        expect(listed).not.toContain("owner");
        box.ok(["project", "set", "old", "--mode", "pr"]);
        expect(readFileSync(file, "utf8")).not.toContain("owner");
    });

    test("--owner is no longer accepted", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        expect(box.toli(["project", "add", "x", "git@example.com:a/x.git", "--owner", "m2"]).code).toBe(1);
    });
});
