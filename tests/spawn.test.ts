import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, sandbox, withProject } from "./helpers.ts";

type Run = {
    id: string;
    harness: string;
    status: string;
    task: string | null;
    project: string | null;
    cwd: string;
    logPath: string;
    pid: number | null;
    supervisorPid: number | null;
    exitCode: number | null;
    inbox: string | null;
    model: string | null;
};

function coordinator(): Sandbox {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    return box;
}

function brief(box: Sandbox, body = "say hi"): string {
    const path = join(box.root, "brief.md");
    writeFileSync(path, `TOLI_BRIEF v1\n${body}\n`);
    return path;
}

function runs(box: Sandbox): Run[] {
    return JSON.parse(box.ok(["runs", "--json"])) as Run[];
}
/**
 * Poll the run until `done` holds, failing after ~10 s. Real time is unavoidable here: the supervisor and the
 * harness are separate detached OS processes, so there is no in-process promise or event to await.
 */
async function waitFor(box: Sandbox, id: string, done: (run: Run) => boolean): Promise<Run> {
    for (let attempt = 0; attempt < 100; attempt++) {
        const run = JSON.parse(box.ok(["run", "status", id, "--json"])) as Run;
        if (done(run)) return run;
        await Bun.sleep(100);
    }
    throw new Error(`run ${id} never reached the expected state: ${box.ok(["run", "status", id])}`);
}

function spawnJson(box: Sandbox, args: string[]): Run {
    return JSON.parse(box.ok(["spawn", ...args, "--json"])) as Run;
}

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

    test("a failing harness is recorded as failed with its exit code", async () => {
        const box = coordinator();
        box.stub("omp", 'echo "boom"; exit 3');
        const started = spawnJson(box, ["--harness", "omp", "--brief", brief(box), "--cwd", box.root]);
        const done = await waitFor(box, started.id, (run) => run.inbox !== null);
        expect(done.status).toBe("failed");
        expect(done.exitCode).toBe(3);
        expect(readFileSync(done.inbox ?? "", "utf8")).toContain("- status: failed (exit 3)");
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

    test("config routes work types to harnesses and supplies the model", async () => {
        const box = coordinator();
        const machine = JSON.parse(readFileSync(join(box.root, "config", "machine.json"), "utf8"));
        machine.harness = { jawan: "claude", byWork: { scout: "omp" }, models: { omp: "fast-model" } };
        writeFileSync(join(box.root, "config", "machine.json"), JSON.stringify(machine));
        box.stub("omp", 'echo "omp $*" | grep -o -- "--model fast-model"');
        box.stub("claude", "cat >/dev/null; echo claude");
        const scout = spawnJson(box, ["--work", "scout", "--brief", brief(box), "--cwd", box.root]);
        expect(scout.harness).toBe("omp");
        expect(scout.model).toBe("fast-model");
        const ship = spawnJson(box, ["--brief", brief(box), "--cwd", box.root]);
        expect(ship.harness).toBe("claude");
        expect(readFileSync((await waitFor(box, scout.id, (run) => run.inbox !== null)).logPath, "utf8")).toBe(
            "--model fast-model\n",
        );
        await waitFor(box, ship.id, (run) => run.inbox !== null);
        expect(runs(box).map((run) => run.status)).toEqual(["done", "done"]);
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
});
