import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, sandbox, withProject } from "./helpers.ts";

type Snapshot = { machine: string; available: boolean; reasons: string[]; activeRuns: number };
type Entry = { machine: string; local: boolean; reachable: boolean; available: boolean; reasons: string[] };
type Pick = { machine: string | null; local: boolean; candidates: { machine: string }[] };

/** Thresholds loose enough that this test host is always available, whatever its real load and disk. */
const ROOMY = { maxRuns: 50, maxLoadPerCpu: 1000, minMemAvailableMB: 0, minDiskFreeGB: 0 };

/** 1 GiB "available" memory from a stubbed vm_stat, so memory never depends on the test host. */
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                               262144.
Pages active:                                  1.
Pages inactive:                                0.
Pages speculative:                             0.
Pages throttled:                               0.
Pages wired down:                              1.
Pages purgeable:                               0.`;

const ENV = { TOLI_PLATFORM: "darwin" };

function remoteSnapshot(machine: string, overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        machine,
        platform: "linux",
        cpus: 8,
        load1: 1,
        load5: 1,
        memTotalMB: 16000,
        memAvailableMB: 8000,
        diskFreeGB: 100,
        activeRuns: 0,
        maxRuns: 2,
        maxLoadPerCpu: 0.8,
        projects: [],
        available: true,
        reasons: [],
        at: "2026-10-29T00:00:00.000Z",
        ...overrides,
    });
}

/**
 * Coordinator m1 with fleet machines m2 (answers `resources --json` with `m2Snapshot`) and m3 (ssh fails).
 * Every ssh invocation is appended to `.ssh.log`.
 */
function fleet(m2Snapshot: string, capacity: Record<string, number> = ROOMY): Sandbox {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    const machinePath = join(box.root, "config", "machine.json");
    writeFileSync(machinePath, JSON.stringify({ ...JSON.parse(readFileSync(machinePath, "utf8")), capacity }));
    writeFileSync(
        join(box.root, "config", "fleet.json"),
        JSON.stringify({
            machines: [
                { name: "m1", ssh: "host1", root: "/srv/toli" },
                { name: "m2", ssh: "host2", root: "/srv/toli" },
                { name: "m3", ssh: "host3", root: "/srv/toli" },
            ],
        }),
    );
    writeFileSync(join(box.root, ".m2.json"), m2Snapshot);
    box.stub("vm_stat", `cat <<'EOF'\n${VM_STAT}\nEOF`);
    box.stub(
        "ssh",
        [
            `printf '%s\\n' "$*" >> "${join(box.root, ".ssh.log")}"`,
            'case "$5" in',
            `  host2) case "$6" in *"resources --json"*) cat "${join(box.root, ".m2.json")}" ;; *) cat >/dev/null; echo "ran on m2" ;; esac ;;`,
            "  *) echo 'ssh: connect to host host3 port 22: Connection refused' >&2; exit 255 ;;",
            "esac",
        ].join("\n"),
    );
    return box;
}

const sshLog = (box: Sandbox): string => {
    const path = join(box.root, ".ssh.log");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
};

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

    test("nothing available exits 2 and says why for each machine", () => {
        const box = fleet(remoteSnapshot("m2", { available: false, reasons: ["load 9/8 cpus over 0.8"] }), {
            ...ROOMY,
            minDiskFreeGB: 1e12,
        });
        const result = box.toli(["pick"], { env: ENV });
        expect(result.code).toBe(2);
        expect(result.stdout).toContain("no machine available:");
        expect(result.stdout).toContain("m1: disk ");
        expect(result.stdout).toContain("m2: load 9/8 cpus over 0.8");
        expect(result.stdout).toContain("m3: unreachable: ");
    });
});

describe("remote auto", () => {
    test("prints local and dispatches nothing when this machine wins", () => {
        // m2 has almost no free memory, so its score is far below this machine's.
        const box = fleet(remoteSnapshot("m2", { memAvailableMB: 1 }));
        expect(box.ok(["remote", "auto", "do the thing"], { env: ENV })).toBe("local");
        expect(sshLog(box)).not.toContain("exec");
        expect(existsSync(join(box.root, "data", "remote"))).toBe(false);
    });

    test("sends the prompt on stdin to the picked machine's exec", () => {
        const box = fleet(remoteSnapshot("m2", { memAvailableMB: 16000, load1: 0 }), { ...ROOMY, minDiskFreeGB: 1e12 });
        const output = box.ok(["remote", "auto", 'it\'s "quoted"; $(rm -rf /)'], { env: ENV });
        expect(output).toContain("ran on m2");
        expect(sshLog(box)).toContain("cd /srv/toli && bin/toli exec --from m1");
        expect(sshLog(box)).not.toContain("rm -rf");
    });

    test("nothing available exits 2 without dispatching", () => {
        const box = fleet(remoteSnapshot("m2", { available: false, reasons: ["busy"] }), {
            ...ROOMY,
            minDiskFreeGB: 1e12,
        });
        const result = box.toli(["remote", "auto", "x"], { env: ENV });
        expect(result.code).toBe(2);
        expect(sshLog(box)).not.toContain("exec");
    });
});

describe("run records", () => {
    test("exec records the run while omp runs and removes it when omp fails", () => {
        const box = fleet(remoteSnapshot("m2"));
        const runs = join(box.root, "state", "runs");
        box.stub("omp", `ls "${runs}"; exit 3`);
        const result = box.toli(["exec", "--from", "m2", "--task", "T4"], { env: ENV, stdin: "fix the build\n" });
        expect(result.code).toBe(3);
        expect(result.stdout).toMatch(/^exec-.*\.json$/m);
        expect(readdirSync(runs)).toEqual([]);
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
