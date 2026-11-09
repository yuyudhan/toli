import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GIT_ENV, type Sandbox, sandbox, TOLI_BIN, withProject } from "./helpers.ts";

// Gates run real detached runners and wait on them; on a loaded machine one test can take tens of seconds.
setDefaultTimeout(60_000);

/**
 * One stall minute lasts this many milliseconds, so `--stall 1` stops a gate silent for about three seconds: a loaded
 * machine can starve a recipe's shell for over a second between two lines, which a shorter limit would take for silence.
 */
const MINUTE_MS = "3000";
const FAST = { TOLI_RUN_MINUTE_MS: MINUTE_MS };

type GateRecord = {
    project: string;
    sha: string;
    recipe: string;
    status: string;
    pid: number | null;
    startedAt: string;
    endedAt: string | null;
    lastOutputAt: string | null;
    exitCode: number | null;
    log: string;
    reason?: string;
};

/** A coordinator with project "app"; returns the clone. */
function setup(): { box: Sandbox; dir: string } {
    const box = sandbox();
    box.ok(["init", "--name", "mini", "--role", "coordinator"]);
    return { box, dir: withProject(box, "app") };
}

/** A recipe script outside the clone (so the worktree stays clean) that counts its runs in `<root>/count`. */
function recipe(box: Sandbox, name: string, body: string): string {
    const file = join(box.root, `${name}.sh`);
    writeFileSync(file, `echo run >> "${join(box.root, "count")}"\n${body}\n`);
    return `sh ${file}`;
}

function runs(box: Sandbox): number {
    const file = join(box.root, "count");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").length : 0;
}

function commitFile(box: Sandbox, dir: string, name: string): string {
    writeFileSync(join(dir, name), `${name}\n`);
    box.git(dir, ["add", name]);
    box.git(dir, ["commit", "-m", `add ${name}`]);
    return box.git(dir, ["rev-parse", "HEAD"]);
}

function records(box: Sandbox): GateRecord[] {
    const dir = join(box.root, "state", "gates", "app");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as GateRecord);
}

function gatesLog(box: Sandbox): string {
    const file = join(box.root, "logs", "gates.log");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** `bin/toli` started in the background with the sandbox's environment, for a caller the test can kill. */
function spawnToli(box: Sandbox, args: string[], env: Record<string, string> = {}): Bun.Subprocess {
    return Bun.spawn([process.execPath, TOLI_BIN, ...args], {
        cwd: box.root,
        env: {
            ...process.env,
            ...GIT_ENV,
            PATH: [box.stubs, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
            TOLI_ROOT: box.root,
            TOLI_DRY_RUN: "1",
            ...env,
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
    });
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
        const silent = recipe(box, "silent", "echo started; sleep 30; echo never");
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
        // Eighteen seconds of silent CPU from three processes (a build linking quietly), past the twelve-second limit.
        const burn = `"${process.execPath}" -e 'const end = Date.now() + 18_000; while (Date.now() < end) {}'`;
        const busy = recipe(box, "busy", `for i in 1 2 3; do ${burn} & done; wait; echo linked`);
        const ok = box.toli(["gate", "run", "app", "--recipe", busy, "--stall", "4"], { env: FAST });
        expect(ok.stderr).not.toContain("stalled");
        expect(ok.code).toBe(0);
        expect(records(box).find((entry) => entry.recipe === busy)?.status).toBe("passed");
        commitFile(box, dir, "a.txt");
        const idle = recipe(box, "idle", "sleep 60; echo never");
        const started = Date.now();
        const stalled = box.toli(["gate", "run", "app", "--recipe", idle, "--stall", "4"], { env: FAST });
        expect(Date.now() - started).toBeLessThan(35_000);
        expect(stalled.code).toBe(1);
        const record = records(box).find((entry) => entry.recipe === idle);
        expect(record?.status).toBe("stalled");
        expect(record?.reason).toContain("CPU use");
        expect(readFileSync(record?.log ?? "", "utf8")).not.toContain("never");
    }, 120_000);

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
        box.git(dir, ["switch", "-c", "feature"]);
        const sha = commitFile(box, dir, "a.txt");
        const seen = join(box.root, "hook-env");
        writeFileSync(
            join(dir, ".git", "hooks", "pre-push"),
            `#!/bin/sh\necho "$TOLI_GATE_SHA $TOLI_GATE_RECIPE" > ${seen}\n`,
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
        expect(readFileSync(seen, "utf8").trim()).toBe(`${sha} ${verify}`);
        expect(box.git(dir, ["ls-remote", "origin", "refs/heads/feature"])).toContain(sha);
    });
});
