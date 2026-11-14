import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pidAlive } from "../src/core/util.ts";
import { changedWhileRunning, changesText, checkoutChanges, parseGateWait } from "../src/forge/gate.ts";
import type { GateRecord as SrcGateRecord } from "../src/forge/gate-record.ts";
import { repo } from "./commit-fixture.ts";
import { commitFile, type GateRecord, gatesLog, recipe, records, runs, setup } from "./gate-fixture.ts";
import { GIT_ENV, type Sandbox, TOLI_BIN } from "./helpers.ts";

// Gates run real detached runners and wait on them; on a loaded machine one test can take tens of seconds.
setDefaultTimeout(60_000);

/**
 * One stall minute lasts this many milliseconds, so `--stall 1` stops a gate silent for about three seconds: a loaded
 * machine can starve a recipe's shell for over a second between two lines, which a shorter limit would take for silence.
 */
const MINUTE_MS = "3000";
const FAST = { TOLI_RUN_MINUTE_MS: MINUTE_MS };

/** `bin/toli` started in the background with the sandbox's environment, for a caller the test can kill or read. */
function spawnToli(box: Sandbox, args: string[], env: Record<string, string> = {}) {
    return Bun.spawn([process.execPath, TOLI_BIN, ...args], {
        cwd: box.root,
        env: {
            ...process.env,
            ...GIT_ENV,
            PATH: [box.stubs, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
            TOLI_ROOT: box.root,
            TOLI_DRY_RUN: "1",
            TOLI_PROCESS_TABLE: join(box.root, ".process-table"),
            ...env,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
    });
}

/** Read `stdout` until it contains `text` (the process says it reached a state); returns what was read. */
async function readUntil(stdout: ReadableStream<Uint8Array>, text: string): Promise<string> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    try {
        while (!seen.includes(text)) {
            const { value, done } = await reader.read();
            if (done) throw new Error(`output ended before "${text}":\n${seen}`);
            seen += decoder.decode(value, { stream: true });
        }
        return seen;
    } finally {
        reader.releaseLock();
    }
}

/** Poll a condition another process makes true (a detached runner's record); fake timers cannot drive it. */
async function until(what: string, check: () => boolean, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(50);
    }
}

describe("gate", () => {
    test("a passed gate is not re-run on the same commit, and the skip says why", () => {
        const { box, dir } = setup();
        const sha = box.git(dir, ["rev-parse", "HEAD"]);
        const verify = recipe(box, "verify", "echo all green");
        const first = box.ok(["gate", "run", "app", "--recipe", verify]);
        expect(first).toContain("gate: starting");
        expect(first).toContain("passed");
        expect(runs(box)).toBe(1);
        const second = box.ok(["gate", "run", "app", "--recipe", verify]);
        expect(second).toContain(`gate: ${verify} already passed at ${sha.slice(0, 12)}`);
        expect(second).toContain("skipping the re-run");
        expect(runs(box)).toBe(1);
        const [record] = records(box);
        expect(record).toMatchObject({ project: "app", sha, recipe: verify, status: "passed", exitCode: 0 });
        expect(readFileSync(record?.log ?? "", "utf8")).toContain("all green");
        expect(gatesLog(box)).toMatch(/ app [0-9a-f]{12} start: /);
        expect(gatesLog(box)).toMatch(/ app [0-9a-f]{12} skip: .*already passed/);
    });

    test("a new commit runs the gate again", () => {
        const { box, dir } = setup();
        const verify = recipe(box, "verify", "echo ok");
        box.ok(["gate", "run", "app", "--recipe", verify]);
        commitFile(box, dir, "a.txt");
        box.ok(["gate", "run", "app", "--recipe", verify]);
        expect(runs(box)).toBe(2);
        expect(records(box).map((record) => record.status)).toEqual(["passed", "passed"]);
    });

    test("a failing gate is recorded failed and never cached", () => {
        const { box } = setup();
        const verify = recipe(box, "verify", "echo broken; exit 3");
        const first = box.toli(["gate", "run", "app", "--recipe", verify]);
        expect(first.code).toBe(1);
        expect(first.stderr).toContain("failed");
        expect(records(box)[0]).toMatchObject({ status: "failed", exitCode: 3 });
        expect(box.toli(["gate", "run", "app", "--recipe", verify]).code).toBe(1);
        expect(runs(box)).toBe(2);
    });

    test("a checkout with changed tracked or untracked files is refused, since its result would fit no commit", () => {
        const { box, dir } = setup();
        const verify = recipe(box, "verify", "echo ok");
        writeFileSync(join(dir, "README"), "changed\n");
        const changed = box.toli(["gate", "run", "app", "--recipe", verify]);
        expect(changed.code).toBe(1);
        expect(changed.stderr).toContain("differs from its HEAD commit (README)");
        box.git(dir, ["checkout", "README"]);
        writeFileSync(join(dir, "new.ts"), "untracked\n");
        const untracked = box.toli(["gate", "run", "app", "--recipe", verify]);
        expect(untracked.code).toBe(1);
        expect(untracked.stderr).toContain("differs from its HEAD commit (new.ts)");
        expect(runs(box)).toBe(0);
    });

    test("a gate that passes after the checkout changed under it is recorded failed, not passed", () => {
        const { box } = setup();
        const verify = recipe(box, "verify", "echo edited >> README");
        const result = box.toli(["gate", "run", "app", "--recipe", verify]);
        expect(result.code).toBe(1);
        const [record] = records(box);
        expect(record).toMatchObject({ status: "failed", exitCode: 0 });
        expect(record?.reason).toContain("the checkout changed while it ran (README)");
    });

    test("a gate printing steadily outlives the stall limit; a silent one is stopped and recorded stalled", () => {
        const { box, dir } = setup();
        // Nine seconds of output every 0.2 s, three times the three-second stall limit.
        const steady = recipe(
            box,
            "steady",
            "i=1; while [ $i -le 45 ]; do echo tick $i; i=$((i + 1)); sleep 0.2; done",
        );
        const ok = box.ok(["gate", "run", "app", "--recipe", steady, "--stall", "1"], { env: FAST });
        expect(ok).toContain("passed");
        commitFile(box, dir, "a.txt");
        // `&&`: a shell signalled with its group can still run the next line once sleep died (macOS sh, under load).
        const silent = recipe(box, "silent", "echo started; sleep 30 && echo never");
        const started = Date.now();
        const stalled = box.toli(["gate", "run", "app", "--recipe", silent, "--stall", "1"], { env: FAST });
        expect(Date.now() - started).toBeLessThan(20_000);
        expect(stalled.code).toBe(1);
        expect(stalled.stderr).toContain("stalled");
        const record = records(box).find((entry) => entry.recipe === silent);
        expect(record?.status).toBe("stalled");
        expect(record?.reason).toContain("no new output");
        expect(readFileSync(record?.log ?? "", "utf8")).not.toContain("never");
        expect(gatesLog(box)).toMatch(/ app [0-9a-f]{12} stall: /);
    });

    test("a silent gate whose processes burn CPU outlives the stall limit; an idle silent one is still stopped", () => {
        const { box, dir } = setup();
        // The default stall limit (30 minutes, the CPU rule's 10 seconds about 0.6% of a core) squeezed into three
        // seconds: a 100 ms minute. A one-minute limit would ask a sixth of a core, which a loaded machine can deny.
        const minutes = { TOLI_RUN_MINUTE_MS: "100" };
        // Seven seconds of silent CPU from one process (a build linking quietly), over twice the three-second limit.
        const burn = `"${process.execPath}" -e 'const end = Date.now() + 7000; while (Date.now() < end) {}'`;
        const busy = recipe(box, "busy", `${burn}; echo linked`);
        const ok = box.toli(["gate", "run", "app", "--recipe", busy, "--stall", "30"], { env: minutes });
        // The whole record on a mismatch: its status, reason and timestamps say how the run ended.
        expect(records(box).find((entry) => entry.recipe === busy)).toMatchObject({ status: "passed", exitCode: 0 });
        expect(ok.stderr).not.toContain("stalled");
        expect(ok.code).toBe(0);
        commitFile(box, dir, "a.txt");
        const idle = recipe(box, "idle", "sleep 30 && echo never");
        const started = Date.now();
        const stalled = box.toli(["gate", "run", "app", "--recipe", idle, "--stall", "30"], { env: minutes });
        const record = records(box).find((entry) => entry.recipe === idle);
        expect({ record, ms: Date.now() - started }).toMatchObject({ record: { status: "stalled" } });
        expect(Date.now() - started).toBeLessThan(20_000);
        expect(stalled.code).toBe(1);
        expect(record?.reason).toContain("CPU use");
        expect(readFileSync(record?.log ?? "", "utf8")).not.toContain("never");
    });

    test("a stopped gate's child that ignores SIGTERM is killed; a process started alongside survives", () => {
        const { box } = setup();
        const pidFile = join(box.root, "survivor");
        const body = `(trap "" TERM; exec sleep 300) & echo $! > "${pidFile}"; wait`;
        const stubborn = recipe(box, "stubborn", body);
        const alongside = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
        const result = box.toli(["gate", "run", "app", "--recipe", stubborn, "--stall", "1"], { env: FAST });
        const survivor = Number(readFileSync(pidFile, "utf8").trim());
        try {
            expect(records(box).find((entry) => entry.recipe === stubborn)).toMatchObject({ status: "stalled" });
            expect(result.code).toBe(1);
            expect(pidAlive(survivor)).toBe(false);
            expect(pidAlive(alongside.pid)).toBe(true);
        } finally {
            if (pidAlive(survivor)) process.kill(survivor, "SIGKILL");
            alongside.kill("SIGKILL");
        }
    });

    test("a second run attaches to the running gate, and the runner outlives a killed caller", async () => {
        const { box } = setup();
        const verify = recipe(box, "verify", "echo begin; sleep 2; echo done");
        const caller = spawnToli(box, ["gate", "run", "app", "--recipe", verify]);
        await until("the gate to start", () => records(box).some((record) => record.pid !== null));
        caller.kill("SIGKILL");
        await caller.exited;
        const attached = box.ok(["gate", "run", "app", "--recipe", verify]);
        expect(attached).toContain("gate: attaching");
        expect(attached).toContain("passed");
        expect(runs(box)).toBe(1);
        expect(records(box)[0]?.status).toBe("passed");
        expect(gatesLog(box)).toMatch(/ app [0-9a-f]{12} attach: /);
    });

    test("gate check exits 0 only when HEAD has a passed record for the recipe", () => {
        const { box, dir } = setup();
        const verify = recipe(box, "verify", "echo ok");
        expect(box.toli(["gate", "check", "app", "--recipe", verify]).code).toBe(1);
        box.ok(["gate", "run", "app", "--recipe", verify]);
        const passed = box.toli(["gate", "check", "app", "--recipe", verify]);
        expect(passed.code).toBe(0);
        expect(passed.stdout).toContain("passed");
        expect(box.toli(["gate", "check", "app", "--recipe", "just other"]).code).toBe(1);
        const first = box.git(dir, ["rev-parse", "HEAD"]);
        commitFile(box, dir, "a.txt");
        expect(box.toli(["gate", "check", "app", "--recipe", verify]).code).toBe(1);
        expect(box.toli(["gate", "check", "app", "--sha", first, "--recipe", verify]).code).toBe(0);
    });

    test("gate status lists records newest first", () => {
        const { box, dir } = setup();
        const verify = recipe(box, "verify", "echo ok");
        box.ok(["gate", "run", "app", "--recipe", verify], { now: "2026-11-09T01:00:00.000Z" });
        const second = commitFile(box, dir, "a.txt");
        box.ok(["gate", "run", "app", "--recipe", verify], { now: "2026-11-09T02:00:00.000Z" });
        const listed = JSON.parse(box.ok(["gate", "status", "app", "--json"])) as GateRecord[];
        expect(listed.map((record) => record.startedAt)).toEqual([
            "2026-11-09T02:00:00.000Z",
            "2026-11-09T01:00:00.000Z",
        ]);
        expect(box.ok(["gate", "status", "app"]).split("\n")[0]).toContain(second.slice(0, 12));
    });

    test("push --gate pushes only after the gate passed and tells the hooks which gate passed", () => {
        const { box, dir } = setup();
        box.ok(["project", "set", "app", "--standing-push", "yes"]);
        box.git(dir, ["switch", "-c", "feature"]);
        const sha = commitFile(box, dir, "a.txt");
        const seen = join(box.root, "hook-env");
        writeFileSync(
            join(dir, ".git", "hooks", "pre-push"),
            `#!/bin/sh\necho "$TOLI_GATE_PROJECT $TOLI_GATE_SHA $TOLI_GATE_TREE $TOLI_GATE_RECIPE" > ${seen}\n`,
            {
                mode: 0o755,
            },
        );
        const failing = recipe(box, "broken", "exit 1");
        const refused = box.toli(["push", "app", "--gate", failing]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("refusing to push");
        expect(existsSync(seen)).toBe(false);
        const verify = recipe(box, "verify", "echo ok");
        box.ok(["push", "app", "--gate", verify]);
        const tree = box.git(dir, ["rev-parse", "HEAD^{tree}"]);
        expect(readFileSync(seen, "utf8").trim()).toBe(`app ${sha} ${tree} ${verify}`);
        expect(box.git(dir, ["ls-remote", "origin", "refs/heads/feature"])).toContain(sha);
    });

    test("push --gate waits for another jawan's uncommitted edit to be committed, then gates exactly HEAD (T1383)", async () => {
        // In a shared same-branch clone another jawan's edit made every push --gate refuse at once.
        const { box, dir } = setup();
        box.ok(["project", "set", "app", "--standing-push", "yes"]);
        box.git(dir, ["switch", "-c", "feature"]);
        commitFile(box, dir, "a.txt");
        writeFileSync(join(dir, "other.ts"), "another jawan's edit, not committed yet\n");
        const verify = recipe(box, "verify", "echo ok");
        const push = spawnToli(box, ["push", "app", "--gate", verify, "--gate-wait", "5"], FAST);
        const waiting = await readUntil(push.stdout, "for them to be committed");
        expect(waiting).toContain("differs from its HEAD commit (other.ts), uncommitted edits such as other");
        expect(runs(box)).toBe(0);
        const sha = commitFile(box, dir, "other.ts");
        expect(await readUntil(push.stdout, "push log:")).toContain("matches its HEAD commit again; running the gate");
        expect(await push.exited).toBe(0);
        expect(runs(box)).toBe(1);
        expect(records(box)).toMatchObject([{ status: "passed", sha }]);
        expect(box.git(dir, ["ls-remote", "origin", "refs/heads/feature"])).toContain(sha);

        // Edits still uncommitted when the wait ends are refused, naming them; --gate-wait 0 refuses at once.
        writeFileSync(join(dir, "late.ts"), "still uncommitted\n");
        const refused = box.toli(["push", "app", "--gate", verify, "--gate-wait", "0"]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("differs from its HEAD commit (late.ts) still, at the end of the wait");
        expect(runs(box)).toBe(1);
    });

    test("push --gate runs the gate again when the checkout changed under it, once the change is committed", async () => {
        const { box, dir } = setup();
        box.ok(["project", "set", "app", "--standing-push", "yes"]);
        box.git(dir, ["switch", "-c", "feature"]);
        commitFile(box, dir, "a.txt");
        // The first run sees another jawan's file appear while it runs; later runs see a quiet checkout.
        const once = join(box.root, "once");
        const verify = recipe(box, "verify", `[ -e ${once} ] || { touch ${once}; echo edit > ${join(dir, "b.txt")}; }`);
        const push = box.toliAsync(["push", "app", "--gate", verify, "--gate-wait", "5"], { env: FAST });
        await until("the first run to end", () => records(box).some((record) => record.status === "failed"));
        const sha = commitFile(box, dir, "b.txt");
        const result = await push;
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("the checkout changed while it ran (b.txt)");
        expect(result.stdout).toContain("running it again on the new tree");
        expect(runs(box)).toBe(2);
        expect(box.git(dir, ["ls-remote", "origin", "refs/heads/feature"])).toContain(sha);
    });
});

describe("gate helpers (in process)", () => {
    const record = (fields: Partial<SrcGateRecord>): SrcGateRecord => ({
        project: "app",
        sha: "0".repeat(40),
        tree: "1".repeat(40),
        recipe: "just verify",
        dir: "/tmp/app",
        status: "failed",
        pid: null,
        startedAt: "2026-11-14T00:00:00.000Z",
        endedAt: "2026-11-14T00:01:00.000Z",
        lastOutputAt: null,
        exitCode: 0,
        log: "/tmp/app.log",
        stallMinutes: 30,
        ...fields,
    });

    test("--gate-wait: 30 minutes by default, 0 means not at all, anything else but whole minutes is refused", () => {
        expect(parseGateWait(undefined)).toBe(30);
        expect(parseGateWait("0")).toBe(0);
        expect(parseGateWait("12")).toBe(12);
        for (const bad of ["-1", "1.5", "soon"])
            expect(() => parseGateWait(bad)).toThrow("--gate-wait must be a whole number of minutes");
    });

    test("only a passing recipe voided by a change while it ran is run again", () => {
        expect(changedWhileRunning(record({ reason: "HEAD moved while it ran" }))).toBe(true);
        expect(changedWhileRunning(record({ exitCode: 1, reason: "HEAD moved while it ran" }))).toBe(false);
        expect(changedWhileRunning(record({ reason: "stalled: no output for 30 minutes" }))).toBe(false);
        expect(changedWhileRunning(record({ status: "passed" }))).toBe(false);
    });

    test("the checkout's changes: null when it is exactly HEAD, else at most five paths named", () => {
        const dir = repo({ "a.txt": "a\n" });
        expect(checkoutChanges(dir)).toBeNull();
        writeFileSync(join(dir, "a.txt"), "edited\n");
        writeFileSync(join(dir, "new.txt"), "new\n");
        const changes = checkoutChanges(dir);
        expect(changes).toEqual([" M a.txt", "?? new.txt"]);
        expect(changesText(changes ?? [])).toBe("a.txt, new.txt");
        expect(changesText([])).toBe("changes git status did not list");
        const many = ["a", "b", "c", "d", "e", "f", "g"].map((name) => ` M ${name}`);
        expect(changesText(many)).toBe("a, b, c, d, e and 2 more");
    });
});
