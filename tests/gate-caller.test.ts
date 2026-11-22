// A gate runner never outlives what waits on it (T2310): once every `gate run` / `push --gate` that started or joined
// a gate is gone for a minute, the runner leaves the heavy-build slot's line, or stops its recipe's whole process
// group and frees the slot; `gate stop` does it at once; and a push stopped by a signal takes its pre-push hook's
// processes with it.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "../src/core/util.ts";
import { liveCaller, thisCaller } from "../src/forge/gate-caller.ts";
import type { GateRecord } from "../src/forge/gate-record.ts";
import { runs as cargoRuns, holdSlot, type Started, slotBox, start, toliArgs, until } from "./build-slot-fixture.ts";
import { recipe, runs as recipeRuns } from "./gate-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";

// Gates run real detached runners behind real slot holders; on a loaded machine one test can take tens of seconds.
setDefaultTimeout(90_000);

/** One run minute is a second here, so a gate's caller grace (CALLER_GRACE_MINUTES) is one second. */
const FAST = { TOLI_RUN_MINUTE_MS: "1000" };

/** One build slot of three cargo jobs and project "app"; returns the clone. */
function slotApp(): { box: Sandbox; dir: string; log: string } {
    const { box, log } = slotBox(1, 3);
    return { box, dir: withProject(box, "app"), log };
}

function gateFiles(box: Sandbox, suffix: string): string[] {
    const dir = join(box.root, "state", "gates", "app");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((name) => name.endsWith(suffix))
        .map((name) => join(dir, name));
}

function onlyRecord(box: Sandbox): GateRecord | null {
    const [file] = gateFiles(box, ".json");
    return file === undefined ? null : (JSON.parse(readFileSync(file, "utf8")) as GateRecord);
}

/** The pid a recipe wrote to `file`, once it has. */
function pidIn(file: string): number {
    return Number(readFileSync(file, "utf8").trim());
}

/**
 * A recipe that starts `sleep 300` as its child (pid in `<root>/child`) and one more as an orphan in its process group
 * (a subshell's background job, pid in `<root>/grand`): no parent pid leads to that one once the subshell exits.
 */
function sleepingRecipe(box: Sandbox): { verify: string; child: string; grand: string } {
    const child = join(box.root, "child");
    const grand = join(box.root, "grand");
    const verify = recipe(
        box,
        "verify",
        `(sleep 300 & echo $! > "${grand}")\nsleep 300 & echo $! > "${child}"\necho begin\nwait`,
    );
    return { verify, child, grand };
}

/** Kill what a test started that may still run (its own sandbox's processes only). */
function cleanUp(pids: (number | undefined)[], started: Started[]): void {
    for (const pid of pids) if (pid !== undefined && pid > 0 && pidAlive(pid)) process.kill(pid, "SIGKILL");
    for (const proc of started) proc.proc.kill("SIGKILL");
}

describe("a gate whose callers are gone", () => {
    test("stops its recipe's whole process group and frees its heavy-build slot", async () => {
        const { box, log } = slotApp();
        const { verify, child, grand } = sleepingRecipe(box);
        const caller = start(box, toliArgs("gate", "run", "app", "--recipe", verify, "--stall", "600"), FAST);
        const started: Started[] = [caller];
        let pids: number[] = [];
        try {
            await until("the gate's processes", () => existsSync(child) && existsSync(grand));
            const runner = onlyRecord(box)?.pid as number;
            pids = [runner, pidIn(child), pidIn(grand)];
            caller.proc.kill("SIGKILL");
            await caller.done;
            await until("the runner to stop the gate", () => onlyRecord(box)?.status !== "running", 30_000);
            const record = onlyRecord(box);
            expect(record?.status).toBe("killed");
            expect(record?.reason).toContain(
                `nothing waits on it any more: the process that started it (pid ${caller.proc.pid}) is gone`,
            );
            await until("the runner, its recipe and the orphan in its group to end", () => !pids.some(pidAlive));
            // The slot is free: the next build runs at once, without waiting in line.
            const next = start(box, toliArgs("build-slot", "--", "cargo", "build"), { STUB_LABEL: "b" });
            started.push(next);
            const { code, stderr } = await next.done;
            expect(code).toBe(0);
            expect(stderr).not.toContain("waiting for a heavy-build slot");
            expect(cargoRuns(log).find((run) => run.label === "b")).toMatchObject({ slot: "1" });
        } finally {
            cleanUp(pids, started);
        }
    });

    test("waiting in line for the slot, leaves the line and never runs its recipe", async () => {
        const { box, log } = slotApp();
        const holder = await holdSlot(box, log);
        const verify = recipe(box, "verify", "echo ran");
        const caller = start(box, toliArgs("gate", "run", "app", "--recipe", verify), FAST);
        const started: Started[] = [holder, caller];
        try {
            await until("the gate waiting for the busy slot", () =>
                gateFiles(box, ".log").some((file) =>
                    readFileSync(file, "utf8").includes("waiting for a heavy-build slot (1 busy)"),
                ),
            );
            caller.proc.kill("SIGKILL");
            await caller.done;
            await until("the runner to give up its place", () => onlyRecord(box)?.status !== "running", 30_000);
            const record = onlyRecord(box);
            expect(record?.status).toBe("killed");
            expect(record?.reason).toContain("is gone and none came back within 1 minute");
            expect(record?.reason).toContain("its recipe never ran");
            await until("the runner to end", () => !pidAlive(record?.pid as number));
            // The runner is gone, so nothing is left to run the recipe once the holder frees the slot.
            writeFileSync(`${log}.done-a`, "");
            expect((await holder.done).code).toBe(0);
            expect(recipeRuns(box)).toBe(0);
        } finally {
            cleanUp([onlyRecord(box)?.pid ?? undefined], started);
        }
    });

    test("a caller's pid now held by another process is not taken for the caller, and is never signalled", async () => {
        const { box } = slotApp();
        const { verify, child, grand } = sleepingRecipe(box);
        const caller = start(box, toliArgs("gate", "run", "app", "--recipe", verify, "--stall", "600"), FAST);
        const other = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
        const started: Started[] = [caller];
        let pids: number[] = [];
        try {
            await until("the gate's processes", () => existsSync(child) && existsSync(grand));
            await until("the runner to record the recipe's output", () => onlyRecord(box)?.lastOutputAt != null);
            pids = [onlyRecord(box)?.pid as number, pidIn(child), pidIn(grand)];
            // The recorded caller's pid now belongs to `other`, which started long after the recorded caller did.
            const [file] = gateFiles(box, ".json") as [string];
            const record = onlyRecord(box) as GateRecord;
            const old = new Date(Date.now() - 3_600_000).toISOString();
            writeFileSync(`${file}.tmp`, JSON.stringify({ ...record, callers: [{ pid: other.pid, startedAt: old }] }));
            renameSync(`${file}.tmp`, file);
            caller.proc.kill("SIGKILL");
            await caller.done;
            await until("the runner to stop the gate", () => onlyRecord(box)?.status !== "running", 30_000);
            expect(onlyRecord(box)?.reason).toContain(`(pid ${other.pid}) is gone`);
            await until("the gate's processes to end", () => !pids.some(pidAlive));
            expect(pidAlive(other.pid)).toBe(true);
            expect(other.exitCode).toBeNull();
        } finally {
            other.kill("SIGKILL");
            cleanUp(pids, started);
        }
    });

    test("gate stop stops it at once with its whole process group; it refuses while a caller waits", async () => {
        const { box } = slotApp();
        const { verify, child, grand } = sleepingRecipe(box);
        // A real minute of grace: the stop below, not the runner's own watch, ends this gate.
        const caller = start(box, toliArgs("gate", "run", "app", "--recipe", verify, "--stall", "600"));
        const started: Started[] = [caller];
        let pids: number[] = [];
        try {
            await until("the gate's processes", () => existsSync(child) && existsSync(grand));
            const record = onlyRecord(box) as GateRecord;
            pids = [record.pid as number, pidIn(child), pidIn(grand)];
            expect(record.owners).toBeUndefined();
            const refused = box.toli(["gate", "stop", record.sha.slice(0, 12)]);
            expect(refused.code).toBe(1);
            expect(refused.stderr).toContain(`caller pid ${caller.proc.pid} still waits on it`);
            expect(pids.every(pidAlive)).toBe(true);

            caller.proc.kill("SIGKILL");
            await caller.done;
            const stopped = box.toli(["gate", "stop", record.tree.slice(0, 12)]);
            expect({ code: stopped.code, stderr: stopped.stderr }).toMatchObject({ code: 0 });
            expect(stopped.stdout).toContain(`stopped runner pid ${record.pid}`);
            expect(onlyRecord(box)).toMatchObject({ status: "killed" });
            expect(onlyRecord(box)?.reason).toContain("stopped by toli: `gate stop`: nothing waits on it any more");
            await until("the runner, its recipe and the orphan in its group to end", () => !pids.some(pidAlive));
        } finally {
            cleanUp(pids, started);
        }
    });

    // A gate stopped while still queued once kept its runner, which later ran the whole gate in slot 1.
    test("gate stop on a gate still queued for the slot ends its runner, and its recipe never runs", async () => {
        const { box, log } = slotApp();
        const holder = await holdSlot(box, log);
        const verify = recipe(box, "verify", "echo ran");
        // A real minute of grace: the stop below, not the runner's own watch, ends this gate.
        const caller = start(box, toliArgs("gate", "run", "app", "--recipe", verify));
        const started: Started[] = [holder, caller];
        try {
            await until("the gate waiting for the busy slot", () =>
                gateFiles(box, ".log").some((file) =>
                    readFileSync(file, "utf8").includes("waiting for a heavy-build slot (1 busy)"),
                ),
            );
            const record = onlyRecord(box) as GateRecord;
            caller.proc.kill("SIGKILL");
            await caller.done;
            const stopped = box.toli(["gate", "stop", record.tree.slice(0, 12)]);
            expect({ code: stopped.code, stderr: stopped.stderr }).toMatchObject({ code: 0 });
            expect(onlyRecord(box)?.status).toBe("killed");
            expect(pidAlive(record.pid as number)).toBe(false);
            // The runner is gone, so nothing is left to run the recipe once the holder frees the slot.
            writeFileSync(`${log}.done-a`, "");
            expect((await holder.done).code).toBe(0);
            expect(recipeRuns(box)).toBe(0);
        } finally {
            cleanUp([onlyRecord(box)?.pid ?? undefined], started);
        }
    });
});

describe("a push stopped by a signal", () => {
    test("stops its pre-push hook's processes too, not only git", async () => {
        const { box, dir } = slotApp();
        box.ok(["project", "set", "app", "--standing-push", "yes"]);
        const hooked = join(box.root, "hooked");
        writeFileSync(join(dir, ".git", "hooks", "pre-push"), `#!/bin/sh\nsleep 300 & echo $! > "${hooked}"\nwait\n`, {
            mode: 0o755,
        });
        const push = start(box, toliArgs("push", "app"));
        let pid: number | undefined;
        try {
            await until("the hook's process", () => existsSync(hooked) && readFileSync(hooked, "utf8").trim() !== "");
            pid = pidIn(hooked);
            push.proc.kill("SIGTERM");
            await push.done;
            await until("the hook's process to end", () => !pidAlive(pid as number), 20_000);
        } finally {
            cleanUp([pid], [push]);
        }
    });
});

describe("liveCaller", () => {
    test("knows a caller by pid and start time: alive, gone, or a pid another process holds now", () => {
        const other = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
        const at = (callers?: GateRecord["callers"]): GateRecord => ({
            project: "app",
            sha: "a".repeat(40),
            tree: "b".repeat(40),
            recipe: "just verify",
            dir: "/tmp",
            status: "running",
            pid: 1,
            startedAt: new Date().toISOString(),
            ...(callers === undefined ? {} : { callers }),
            endedAt: null,
            lastOutputAt: null,
            exitCode: null,
            log: "/tmp/gate.log",
            stallMinutes: 30,
        });
        try {
            const me = thisCaller();
            expect(liveCaller(at([me]))).toEqual(me);
            const reused = { pid: other.pid, startedAt: new Date(Date.now() - 3_600_000).toISOString() };
            expect(liveCaller(at([reused]))).toBeNull();
            expect(liveCaller(at([reused, me]))).toEqual(me);
            expect(liveCaller(at([{ pid: 0, startedAt: "never" }]))).toBeNull();
            expect(liveCaller(at())).toBeUndefined();
            expect(pidAlive(other.pid)).toBe(true);
        } finally {
            other.kill("SIGKILL");
        }
    });
});
