import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, withProject } from "./helpers.ts";
import { brief, coordinator, type Run, runs, spawnJson, waitFor } from "./jawan-fixture.ts";

// Each test runs several bin/toli processes and waits on detached runs (up to 10 s per waitFor); on a loaded machine
// that passes Bun's 5 s default, so this file allows 30 s per test.
setDefaultTimeout(30_000);

describe("spawn", () => {
    test("runs detached, moves starting -> running -> done, logs output, and posts the outcome to the inbox", async () => {
        const box = coordinator();
        box.stub("omp", 'echo "role=$TOLI_ROLE run=$TOLI_RUN_ID"; sleep 1; echo "final answer"');
        const started = spawnJson(box, ["--harness", "omp", "--brief", brief(box), "--cwd", box.root]);
        expect(started.status).toBe("starting");
        expect(started.supervisorPid).toBeGreaterThan(0);

        const running = await waitFor(box, started.id, (run) => run.status === "running");
        expect(running.pid).toBeGreaterThan(0);
        const done = await waitFor(box, started.id, (run) => run.status === "done" && run.inbox !== null);
        expect(done.exitCode).toBe(0);
        expect(readFileSync(done.logPath, "utf8")).toBe(`role=jawan run=${started.id}\nfinal answer\n`);

        const inbox = readFileSync(done.inbox ?? "", "utf8");
        expect(inbox.split("\n")[0]).toBe(`# jawan ${started.id} done: omp`);
        expect(inbox).toContain("final answer");
        const wake = box.ok(["wake"]);
        expect(wake).toContain(`[toli wake] 1 new result arrived.`);
        expect(wake).toContain(`m1: jawan ${started.id} done: omp`);
        expect(box.ok(["runs", "--active"])).toBe("no active jawan runs");
        // The load record (state/runs) is gone once the run ends.
        expect(existsSync(join(box.root, "state", "runs", `${started.id}.json`))).toBe(false);
    });

    test("claude gets the brief on stdin, runs in the task's project clone, and logs under the project's runs dir", async () => {
        const box = coordinator();
        const clone = withProject(box, "alpha");
        box.ok(["task", "add", "alpha", "look around", "--shape", "scout"]);
        box.stub("claude", 'echo "cwd=$(pwd)"; echo "args=$*"; cat');
        const started = spawnJson(box, ["--harness", "claude", "--task", "T1", "--brief", brief(box, "inspect")]);
        expect(started.project).toBe("alpha");
        expect(started.logPath.startsWith(join(box.root, "data", "projects", "alpha", "runs", started.id))).toBe(true);
        expect(box.ok(["task", "list"])).toContain(`T1\tactive\talpha\tscout\tlook around\t(agent: ${started.id})`);
        const done = await waitFor(box, started.id, (run) => run.inbox !== null);
        const log = readFileSync(done.logPath, "utf8");
        expect(log).toContain(`cwd=${realpathSync(clone)}`);
        expect(log).toContain("--permission-mode acceptEdits");
        expect(log).toContain("TOLI_BRIEF v1\ninspect");
        expect(readFileSync(done.inbox ?? "", "utf8").split("\n")[0]).toBe(
            `# jawan ${started.id} done: claude T1 (alpha)`,
        );
    });

    test("run kill stops the process group and the outcome still reaches the inbox as killed", async () => {
        const box = coordinator();
        box.stub("omp", "sleep 30");
        const started = spawnJson(box, ["--harness", "omp", "--brief", brief(box), "--cwd", box.root]);
        await waitFor(box, started.id, (run) => run.status === "running");
        expect(box.ok(["run", "kill", started.id])).toContain(`killing ${started.id}`);
        const done = await waitFor(box, started.id, (run) => run.inbox !== null);
        expect(done.status).toBe("killed");
        expect(readFileSync(done.inbox ?? "", "utf8")).toContain("- status: killed (signal SIGTERM)");
    });

    test("config routes work types to harnesses; the work's tier beats harness.models, which covers runs without one", async () => {
        const box = coordinator();
        const machine = JSON.parse(readFileSync(join(box.root, "config", "machine.json"), "utf8"));
        machine.harness = { jawan: "claude", byWork: { scout: "omp" }, models: { omp: "fast-model" } };
        writeFileSync(join(box.root, "config", "machine.json"), JSON.stringify(machine));
        box.stub("omp", 'echo "omp $*" | grep -o -- "--model [a-z0-9-]*"');
        box.stub("claude", 'cat >/dev/null; echo "claude $*"');
        const scout = spawnJson(box, ["--work", "scout", "--brief", brief(box), "--cwd", box.root]);
        expect(scout.harness).toBe("omp");
        expect(scout.model).toBe("claude-sonnet-5-5");
        expect(scout.tier).toBe("standard");
        const plain = spawnJson(box, ["--harness", "omp", "--brief", brief(box), "--cwd", box.root]);
        expect(plain.model).toBe("fast-model");
        expect(plain.modelSource).toBe("models");
        const ship = spawnJson(box, ["--brief", brief(box), "--cwd", box.root]);
        expect(ship.harness).toBe("claude");
        expect(ship.model).toBeNull();
        expect(readFileSync((await waitFor(box, scout.id, (run) => run.inbox !== null)).logPath, "utf8")).toBe(
            "--model claude-sonnet-5-5\n",
        );
        expect(readFileSync((await waitFor(box, plain.id, (run) => run.inbox !== null)).logPath, "utf8")).toBe(
            "--model fast-model\n",
        );
        const shipped = await waitFor(box, ship.id, (run) => run.inbox !== null);
        expect(readFileSync(shipped.logPath, "utf8")).not.toContain("--model");
        expect(runs(box).map((run) => run.status)).toEqual(["done", "done", "done"]);
    });

    test("--dry-run shows the model each kind of work runs on, writing nothing", () => {
        const box = coordinator();
        box.stub("omp", "true");
        const dry = (args: string[]): string => box.ok(["spawn", "--dry-run", "--cwd", box.root, ...args]);
        expect(dry(["--work", "scout"])).toContain("would spawn: omp claude-sonnet-5-5 (standard, work), work scout");
        expect(dry(["--work", "mechanical"])).toContain("omp claude-haiku-5-5 (light, work)");
        expect(dry(["--work", "verify"])).toContain("omp claude-opus-5-5 (deep, work)");
        expect(dry(["--work", "verify", "--tier", "standard"])).toContain("claude-sonnet-5-5 (standard, --tier)");
        expect(dry(["--work", "verify", "--tier", "light", "--model", "m"])).toContain("omp m (--model)");
        expect(dry(["--work", "mechanical", "--brief", brief(box, "Tier: deep\ndo it")])).toContain(
            "claude-opus-5-5 (deep, brief)",
        );
        expect(box.toli(["spawn", "--dry-run", "--tier", "max"]).stderr).toContain("--tier must be one of");
        expect(runs(box)).toEqual([]);
    });

    test("a task's tier beats its shape, and the run record carries model, tier and source", async () => {
        const box = coordinator();
        withProject(box, "alpha");
        box.ok(["task", "add", "alpha", "hard scout", "--shape", "scout", "--tier", "deep"]);
        box.stub("omp", 'echo "$*" | grep -o -- "--model [a-z0-9-]*"');
        const started = spawnJson(box, ["--task", "T1", "--brief", brief(box)]);
        expect([started.model, started.tier, started.modelSource]).toEqual(["claude-opus-5-5", "deep", "task"]);
        const done = await waitFor(box, started.id, (run) => run.inbox !== null);
        expect(readFileSync(done.logPath, "utf8")).toBe("--model claude-opus-5-5\n");
        expect(box.ok(["runs"])).toContain("\tomp claude-opus-5-5 (deep)\tT1 alpha\t");
        expect(box.ok(["run", "status", started.id])).toContain("model: claude-opus-5-5 (deep, task)");
        expect(readFileSync(done.inbox ?? "", "utf8")).toContain(
            "- harness: omp claude-opus-5-5 (deep) (model from task)",
        );
    });

    test("a verify run stopped by a rate limit retries once on standard, never light, and records the fallback", async () => {
        const box = coordinator();
        // TOLI_RUN_MINUTE_MS shortens the 15-minute reset wait, and with it the 30-minute stall to 600 ms, which a stub
        // starved under load outlasts: the stall watch then stopped it instead of the limit. 10,000 minutes (200 s)
        // outlasts the test, so its runs end only by their own exit.
        const machinePath = join(box.root, "config", "machine.json");
        const machine = JSON.parse(readFileSync(machinePath, "utf8"));
        writeFileSync(
            machinePath,
            JSON.stringify({ ...machine, capacity: { ...machine.capacity, stallMinutes: 10_000 } }),
        );
        const calls = join(box.root, ".calls");
        box.stub(
            "omp",
            `echo "$*" | grep -o -- "--model [a-z0-9-]*" >> "${calls}"
if [ "$(wc -l < "${calls}" | tr -d ' ')" -le 3 ]; then echo 'Error: 429 rate_limit_error'; exit 1; fi
echo "verified"`,
        );
        const env = { TOLI_RUN_MINUTE_MS: "20" };
        const verify = (args: string[]): Run =>
            JSON.parse(
                box.ok(["spawn", "--work", "verify", ...args, "--brief", brief(box), "--cwd", box.root, "--json"], {
                    env,
                }),
            ) as Run;
        const first = verify([]);
        const opus = await waitFor(box, first.id, (run) => run.inbox !== null);
        // opus hit the limit, the retry on sonnet hit it too: one retry only, so the run failed on sonnet.
        expect(opus.status).toBe("failed");
        expect([opus.model, opus.tier]).toEqual(["claude-sonnet-5-5", "standard"]);
        expect(opus.fallback).toMatchObject({ from: "claude-opus-5-5", to: "claude-sonnet-5-5", waitedMinutes: 0 });
        expect(readFileSync(opus.logPath, "utf8")).toContain(
            "[toli] claude-opus-5-5 hit a rate/usage limit; retrying once on claude-sonnet-5-5 (deep -> standard)",
        );
        // On standard already, a verify waits for the reset and retries on standard rather than dropping to light.
        const second = verify(["--tier", "standard"]);
        const sonnet = await waitFor(box, second.id, (run) => run.inbox !== null);
        expect(sonnet.status).toBe("done");
        expect(sonnet.fallback).toMatchObject({
            from: "claude-sonnet-5-5",
            to: "claude-sonnet-5-5",
            waitedMinutes: 15,
        });
        expect(readFileSync(calls, "utf8").trimEnd().split("\n")).toEqual([
            "--model claude-opus-5-5",
            "--model claude-sonnet-5-5",
            "--model claude-sonnet-5-5",
            "--model claude-sonnet-5-5",
        ]);
    });

    test("a missing harness CLI fails cleanly with install and login hints, writing nothing", () => {
        const box = coordinator();
        const result = box.toli(["spawn", "--harness", "codex", "--brief", brief(box), "--cwd", box.root]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("Codex CLI is not installed on this machine (`codex` is not on PATH)");
        expect(result.stderr).toContain("npm install -g @openai/codex");
        expect(result.stderr).toContain("codex login");
        expect(runs(box)).toEqual([]);
    });

    test("refuses a brief without the TOLI_BRIEF header, unknown harnesses and unknown tasks", () => {
        const box = coordinator();
        box.stub("omp", "true");
        const bad = join(box.root, "bad.md");
        writeFileSync(bad, "do things\n");
        expect(box.toli(["spawn", "--harness", "omp", "--brief", bad]).stderr).toContain(
            'the brief\'s first line must be "TOLI_BRIEF v1"',
        );
        expect(box.toli(["spawn", "--harness", "vim", "--brief", brief(box)]).stderr).toContain(
            "--harness must be one of omp, claude, codex, cursor, grok, pi",
        );
        expect(box.toli(["spawn", "--harness", "omp", "--task", "T9", "--brief", brief(box)]).stderr).toContain(
            'unknown task "T9"',
        );
    });

    test("a ship brief without a Goal section is warned about but still spawned; scouts and goal briefs are not", () => {
        const box = coordinator();
        box.stub("omp", "true");
        const warning = 'has no "## Goal" section';
        const bare = box.toli([
            "spawn",
            "--harness",
            "omp",
            "--work",
            "ship",
            "--brief",
            brief(box),
            "--cwd",
            box.root,
        ]);
        expect(bare.code).toBe(0);
        expect(bare.stderr).toContain(warning);
        const scout = box.toli([
            "spawn",
            "--harness",
            "omp",
            "--work",
            "scout",
            "--brief",
            brief(box),
            "--cwd",
            box.root,
        ]);
        expect(scout.stderr).not.toContain(warning);
        const goal = brief(box, "## Goal\n\n- Objective: say hi\n- Stop when: hi was said");
        const withGoal = box.toli(["spawn", "--harness", "omp", "--work", "ship", "--brief", goal, "--cwd", box.root]);
        expect(withGoal.code).toBe(0);
        expect(withGoal.stderr).not.toContain(warning);
    });
});

describe("one live jawan per task", () => {
    /** A coordinator with project alpha and scout tasks T1 and T2 (scouts need no workspace), and a long-running omp. */
    function withTasks(): Sandbox {
        const box = coordinator();
        withProject(box, "alpha");
        box.ok(["task", "add", "alpha", "look around", "--shape", "scout"]);
        box.ok(["task", "add", "alpha", "look elsewhere", "--shape", "scout"]);
        box.stub("omp", "sleep 30");
        return box;
    }

    function spawnTask(box: Sandbox, task: string, extra: string[] = []): Run {
        return spawnJson(box, ["--harness", "omp", "--task", task, "--brief", brief(box), ...extra]);
    }

    function stop(box: Sandbox, ids: string[]): void {
        for (const id of ids) box.toli(["run", "kill", id]);
    }

    test("a second spawn on a task with a live run is refused, naming the run and how to steer or replace it", async () => {
        const box = withTasks();
        const live = spawnTask(box, "T1");
        await waitFor(box, live.id, (run) => run.status === "running");
        const refused = box.toli(["spawn", "--harness", "omp", "--task", "T1", "--brief", brief(box)]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain(`T1 already has a live jawan: ${live.id} (running)`);
        expect(refused.stderr).toContain(`write agent://${live.id}`);
        expect(refused.stderr).toContain("--replace");
        expect(runs(box).map((run) => run.id)).toEqual([live.id]);
        expect((await waitFor(box, live.id, (run) => run.status === "running")).status).toBe("running");
        stop(box, [live.id]);
    });

    test("--replace stops the live run as run kill does, records the replacement on both, and starts the new one", async () => {
        const box = withTasks();
        const old = spawnTask(box, "T1");
        await waitFor(box, old.id, (run) => run.status === "running");
        const next = spawnTask(box, "T1", ["--replace"]);
        expect(next.replaces).toEqual([old.id]);
        expect(next.status).toBe("starting");
        const stopped = await waitFor(box, old.id, (run) => run.inbox !== null);
        expect(stopped.status).toBe("killed");
        expect(stopped.replacedBy).toBe(next.id);
        expect(readFileSync(stopped.inbox ?? "", "utf8")).toContain("- status: killed (signal SIGTERM)");
        expect(box.ok(["task", "list"])).toContain(`(agent: ${next.id})`);
        stop(box, [next.id]);
    });

    test("a dead run left marked running does not block: it is recorded failed and the spawn proceeds", () => {
        const box = withTasks();
        const dead = Bun.spawnSync(["true"]).pid;
        const id = "j-20260101-000000-dead";
        const record = {
            id,
            harness: "omp",
            task: "T1",
            project: "alpha",
            work: "scout",
            model: null,
            cwd: box.root,
            runDir: join(box.root, "state", "jawans", id),
            briefPath: join(box.root, "brief.md"),
            logPath: join(box.root, "state", "jawans", id, "output.log"),
            command: "omp <brief>",
            maxMinutes: 120,
            status: "running",
            supervisorPid: dead,
            pid: dead,
            exitCode: null,
            signal: null,
            startedAt: "2026-01-01T00:00:00.000Z",
            endedAt: null,
            inbox: null,
            error: null,
        };
        mkdirSync(join(box.root, "state", "jawans"), { recursive: true });
        writeFileSync(join(box.root, "state", "jawans", `${id}.json`), JSON.stringify(record));
        const started = spawnTask(box, "T1");
        expect(started.replaces).toBeUndefined();
        const stale = JSON.parse(box.ok(["run", "status", id, "--json"])) as Run;
        expect(stale.status).toBe("failed");
        stop(box, [started.id]);
    });

    test("a live run on one task leaves other tasks free to spawn", async () => {
        const box = withTasks();
        const first = spawnTask(box, "T1");
        await waitFor(box, first.id, (run) => run.status === "running");
        const other = spawnTask(box, "T2");
        expect(other.task).toBe("T2");
        expect(other.replaces).toBeUndefined();
        const ids = runs(box).map((run) => run.id);
        expect(ids.sort()).toEqual([first.id, other.id].sort());
        stop(box, [first.id, other.id]);
    });
});
