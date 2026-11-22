import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pidAlive } from "../src/core/util.ts";
import { claimForStop, joinGate, liveOwner } from "../src/forge/gate-owner.ts";
import type { GateRecord } from "../src/forge/gate-record.ts";
import type { JawanRun } from "../src/jawans/runs.ts";
import { stillRecorded } from "../src/jawans/stop.ts";
import { gatesLog, recipe, records, runs, setup } from "./gate-fixture.ts";
import { GIT_ENV, type Sandbox, TOLI_BIN, tempDir } from "./helpers.ts";

// A stopped runner gets its grace, and gates run real detached runners.
setDefaultTimeout(90_000);

/** A `bin/toli spawn` run record with `status`, as toli writes it (no supervisor: listRuns takes the status as is). */
function writeRun(box: Sandbox, id: string, status: string, fields: Record<string, unknown> = {}): void {
    const dir = join(box.root, "state", "jawans");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, `${id}.json`),
        JSON.stringify({
            id,
            status,
            task: "T1",
            supervisorPid: null,
            startedAt: "2026-11-22T00:00:00.000Z",
            ...fields,
        }),
    );
}

function spawnToli(box: Sandbox, args: string[], env: Record<string, string>) {
    return Bun.spawn([process.execPath, TOLI_BIN, ...args], {
        cwd: box.root,
        env: {
            ...process.env,
            ...GIT_ENV,
            PATH: [box.stubs, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
            TOLI_ROOT: box.root,
            TOLI_DRY_RUN: "1",
            TOLI_BUILD_SCOPE: "off",
            TOLI_PROCESS_TABLE: join(box.root, ".process-table"),
            TOLI_TASK: "",
            ...env,
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
    });
}

/** Poll a condition another process makes true (a detached runner's record); fake timers cannot drive it. */
async function until(what: string, check: () => boolean, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(100);
    }
}

describe("gate runners of jawans", () => {
    test("gate stop refuses while the owning jawan lives, then stops the runner and its processes once it ended", async () => {
        const { box } = setup();
        writeRun(box, "j1", "running");
        const pidFile = join(box.root, "child");
        const verify = recipe(box, "verify", `sleep 300 & echo $! > "${pidFile}"; echo begin; wait`);
        const caller = spawnToli(box, ["gate", "run", "app", "--recipe", verify], { TOLI_RUN_ID: "j1" });
        await until("the gate's child", () => existsSync(pidFile) && records(box)[0]?.pid != null);
        const child = Number(readFileSync(pidFile, "utf8").trim());
        const started = records(box)[0] as GateRecord;
        const runner = started.pid as number;
        try {
            expect(started).toMatchObject({ status: "running", owners: ["j1"] });
            const refused = box.toli(["gate", "stop", started.sha.slice(0, 12)]);
            expect(refused.code).toBe(1);
            expect(refused.stderr).toContain("belongs to live jawan j1 (running, task T1)");
            expect(pidAlive(child)).toBe(true);

            writeRun(box, "j1", "killed");
            const stopped = box.toli(["gate", "stop", started.tree.slice(0, 12)]);
            expect({ code: stopped.code, stderr: stopped.stderr }).toMatchObject({ code: 0 });
            expect(stopped.stdout).toContain(`stopped runner pid ${runner}`);
            const record = records(box)[0];
            expect(record?.status).toBe("killed");
            expect(record?.reason).toContain("stopped by toli: `gate stop`: its jawan (j1) ended");
            expect(pidAlive(child)).toBe(false);
            expect(pidAlive(runner)).toBe(false);
            expect(await caller.exited).toBe(1);
            expect(gatesLog(box)).toMatch(/ app [0-9a-f]{12} stopped: /);
        } finally {
            for (const pid of [child, runner]) if (pidAlive(pid)) process.kill(pid, "SIGKILL");
            caller.kill("SIGKILL");
        }
    });

    test("gate stop refuses a gate no jawan owns, and a selector that names no running gate", async () => {
        const { box } = setup();
        const verify = recipe(box, "verify", "echo begin; sleep 300 && echo never");
        const caller = spawnToli(box, ["gate", "run", "app", "--recipe", verify], {});
        await until("the gate to start", () => records(box)[0]?.pid != null);
        const started = records(box)[0] as GateRecord;
        try {
            expect(started.owners).toBeUndefined();
            const refused = box.toli(["gate", "stop", started.sha]);
            expect(refused.code).toBe(1);
            expect(refused.stderr).toContain("outside any `bin/toli spawn` jawan");
            expect(pidAlive(started.pid as number)).toBe(true);
            expect(box.toli(["gate", "stop", "abcdef0"]).stderr).toContain("no running gate matches abcdef0");
            expect(box.toli(["gate", "stop", "../x"]).stderr).toContain("is not a gate id");
        } finally {
            // The test started this runner: stop it and the recipe with it.
            process.kill(started.pid as number, "SIGTERM");
            await until("the runner to end", () => records(box)[0]?.status !== "running");
            caller.kill("SIGKILL");
        }
    });

    test("pid reuse: a record whose pid is another process now never gets that process signalled", async () => {
        const { box } = setup();
        writeRun(box, "j1", "killed");
        const dir = join(box.root, "state", "gates", "app");
        mkdirSync(dir, { recursive: true });
        // An unrelated process holds the recorded pid: once started long after the record's runner, once at the
        // recorded moment but running another command.
        const other = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
        try {
            for (const [name, pidStartedAt] of [
                ["a".repeat(40), new Date(Date.now() - 3_600_000).toISOString()],
                ["b".repeat(40), new Date().toISOString()],
            ] as const) {
                const file = join(dir, `${name}-0123456789abcdef.json`);
                const record: GateRecord = {
                    project: "app",
                    sha: name,
                    tree: name,
                    recipe: "just verify",
                    dir: box.root,
                    status: "running",
                    pid: other.pid,
                    pidStartedAt,
                    startedAt: pidStartedAt,
                    owners: ["j1"],
                    endedAt: null,
                    lastOutputAt: null,
                    exitCode: null,
                    log: file.replace(/\.json$/, ".log"),
                    stallMinutes: 30,
                };
                writeFileSync(file, JSON.stringify(record));
                const result = box.toli(["gate", "stop", `${name}-0123456789abcdef`]);
                expect(result.code).toBe(1);
                expect(result.stderr).toContain(`runner pid ${other.pid} is not the recorded runner any more`);
                expect(pidAlive(other.pid)).toBe(true);
                // The record no longer claims a runner it does not have, so nothing attaches to it.
                expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ status: "killed", pid: other.pid });
            }
            expect(other.exitCode).toBeNull();
        } finally {
            other.kill("SIGKILL");
        }
    });

    test("a gate being stopped is never joined: a new gate run waits for it to end, then runs its own", async () => {
        const { box, dir } = setup();
        writeRun(box, "j2", "running");
        const verify = recipe(box, "verify", "echo ok");
        const tree = box.git(dir, ["rev-parse", "HEAD^{tree}"]);
        const hash = createHash("sha256").update(verify).digest("hex").slice(0, 16);
        const gates = join(box.root, "state", "gates", "app");
        mkdirSync(gates, { recursive: true });
        const file = join(gates, `${tree}-${hash}.json`);
        // A runner toli is stopping: alive still, the record already `stopping`.
        const runner = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
        const stopping: GateRecord = {
            project: "app",
            sha: box.git(dir, ["rev-parse", "HEAD"]),
            tree,
            recipe: verify,
            dir,
            status: "stopping",
            pid: runner.pid,
            pidStartedAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            owners: ["j1"],
            endedAt: null,
            lastOutputAt: null,
            exitCode: null,
            log: file.replace(/\.json$/, ".log"),
            stallMinutes: 30,
        };
        writeFileSync(file, JSON.stringify(stopping));
        try {
            const caller = spawnToli(box, ["gate", "run", "app", "--recipe", verify], { TOLI_RUN_ID: "j2" });
            // Real time for the caller to decide: what is under test is that it neither joins nor starts meanwhile.
            await Bun.sleep(3000);
            expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ status: "stopping", owners: ["j1"] });
            expect(runs(box)).toBe(0);
            // Atomically, as toli writes records: the polling caller never reads half a file.
            writeFileSync(
                `${file}.tmp`,
                JSON.stringify({ ...stopping, status: "killed", endedAt: new Date().toISOString() }),
            );
            renameSync(`${file}.tmp`, file);
            expect(await caller.exited).toBe(0);
            expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ status: "passed", owners: ["j2"] });
            expect(runs(box)).toBe(1);
        } finally {
            runner.kill("SIGKILL");
        }
    });
});

describe("gate owners (in process)", () => {
    const gate = (owners?: string[]): GateRecord => ({
        project: "app",
        sha: "0".repeat(40),
        tree: "1".repeat(40),
        recipe: "just verify",
        dir: "/tmp/app",
        status: "running",
        pid: 1,
        startedAt: "2026-11-22T00:00:00.000Z",
        ...(owners === undefined ? {} : { owners }),
        endedAt: null,
        lastOutputAt: null,
        exitCode: null,
        log: "/tmp/app.log",
        stallMinutes: 30,
    });
    const run = (id: string, status: JawanRun["status"], fields: Partial<JawanRun> = {}) =>
        ({ id, status, task: null, ...fields }) as JawanRun;

    test("a gate is owned while any owner, or a run that continues one, is active", () => {
        expect(liveOwner(gate(), [])).toBeUndefined();
        expect(liveOwner(gate(["a"]), [run("a", "running")])?.id).toBe("a");
        expect(liveOwner(gate(["a"]), [run("a", "killed")])).toBeNull();
        expect(liveOwner(gate(["gone"]), [])).toBeNull();
        const resumed = [run("a", "stalled", { resumedBy: "b" }), run("b", "queued")];
        expect(liveOwner(gate(["a"]), resumed)?.id).toBe("b");
        const replaced = [run("a", "killed", { replacedBy: "c" }), run("c", "done")];
        expect(liveOwner(gate(["a"]), replaced)).toBeNull();
        expect(liveOwner(gate(["a", "d"]), [run("a", "done"), run("d", "starting")])?.id).toBe("d");
        const loop = [run("a", "failed", { resumedBy: "b" }), run("b", "failed", { resumedBy: "a" })];
        expect(liveOwner(gate(["a"]), loop)).toBeNull();
    });

    test("a stop claims the gate under its lock only while it still runs with the owners the stop saw", () => {
        const dir = tempDir("gate-claim");
        const file = join(dir, "t-h.json");
        writeFileSync(file, JSON.stringify(gate(["a"])));
        expect(claimForStop(file, gate(["a"]))?.status).toBe("stopping");
        expect(JSON.parse(readFileSync(file, "utf8")).status).toBe("stopping");
        // A run joined after the stop read the record: the stop backs off and the gate runs on for it.
        writeFileSync(file, JSON.stringify(gate(["a", "b"])));
        expect(claimForStop(file, gate(["a"]))).toBeNull();
        expect(JSON.parse(readFileSync(file, "utf8")).status).toBe("running");
        writeFileSync(file, JSON.stringify({ ...gate(["a"]), status: "passed" }));
        expect(claimForStop(file, gate(["a"]))).toBeNull();
        writeFileSync(file, JSON.stringify({ ...gate(["a"]), pid: 2 }));
        expect(claimForStop(file, gate(["a"]))).toBeNull();
    });

    test("a jawan joining adds itself; anyone else joining leaves the gate unowned for good", () => {
        const owned = gate(["a"]);
        joinGate(owned, "b");
        joinGate(owned, "a");
        expect(owned.owners).toEqual(["a", "b"]);
        joinGate(owned, null);
        expect(owned.owners).toBeUndefined();
        joinGate(owned, "c");
        expect(owned.owners).toBeUndefined();
    });

    test("a recorded process is recognised only by its pid, start time and command together", () => {
        const at = Date.parse("2026-11-22T01:00:00.000Z");
        const row = (elapsed: string, args: string) => `  4242     1  4242 S ${elapsed} ${args}\n`;
        const runner = "/usr/bin/bun /opt/toli/bin/toli gate runner /r/state/gates/app/t-h.json";
        const recorded = { pid: 4242, spawnedAtMs: at - 600_000, command: ["gate runner", "t-h.json"] };
        expect(stillRecorded(row("10:00", runner), at, recorded)).toBe(true);
        // The pid was handed to a process started after the runner, or one long before it.
        expect(stillRecorded(row("05:00", runner), at, recorded)).toBe(false);
        expect(stillRecorded(row("01:00:00", runner), at, recorded)).toBe(false);
        expect(stillRecorded(row("10:00", "sleep 300"), at, recorded)).toBe(false);
        expect(stillRecorded(row("10:00", runner.replace("t-h", "other")), at, recorded)).toBe(false);
        expect(stillRecorded("", at, recorded)).toBe(false);
        expect(stillRecorded(`  4242     1  4242 Z 10:00 ${runner}\n`, at, recorded)).toBe(false);
    });
});
