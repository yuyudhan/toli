// Shared fixture of the release catch-up tests (tests/catch-up.test.ts, tests/catch-up-stand-down.test.ts): machine m1
// with project alpha's clone on a fixed working branch, run records, and releases cut on alpha's bare origin.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOMY } from "./fleet-fixture.ts";
import { type Sandbox, sandbox, tempDir, withProject } from "./helpers.ts";

type RunRecord = {
    id: string;
    project: string | null;
    status: string;
    briefPath: string;
    cwd: string;
    catchUp?: string;
    replaces?: string[];
};
export type TaskRecord = { id: string; notes: string[] };

const BLOCKER = "j-20261120-080000-aaaa";

/** A jawan run record; `running` under this test process holds its slot and stays live. */
export function runRecord(box: Sandbox, id: string, fields: Record<string, unknown>): void {
    const dir = join(box.root, "state", "jawans");
    const runDir = join(dir, id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "brief.md"), "TOLI_BRIEF v1\n");
    writeFileSync(
        join(dir, `${id}.json`),
        JSON.stringify({
            id,
            harness: "omp",
            task: null,
            project: null,
            work: null,
            model: null,
            cwd: box.root,
            runDir,
            briefPath: join(runDir, "brief.md"),
            logPath: join(runDir, "output.log"),
            command: "omp",
            maxMinutes: null,
            status: "running",
            supervisorPid: process.pid,
            pid: process.pid,
            exitCode: null,
            signal: null,
            startedAt: "2026-11-20T08:00:00.000Z",
            endedAt: null,
            inbox: null,
            error: null,
            ...fields,
        }),
    );
}

export function runs(box: Sandbox): RunRecord[] {
    const dir = join(box.root, "state", "jawans");
    return readdirSync(dir)
        .filter((file) => file.endsWith(".json"))
        .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as RunRecord)
        .filter((run) => run.id !== BLOCKER);
}

/** The `TOLI_RUN_ID` env of the catch-up run for release `tag`: `catch-up merge` run as that jawan. */
export function asCatchUp(box: Sandbox, tag: string): { env: Record<string, string> } {
    const run = runs(box).find((entry) => entry.catchUp === tag);
    if (run === undefined) throw new Error(`no catch-up run for ${tag}`);
    return { env: { TOLI_RUN_ID: run.id } };
}

/** The machine fixture: its sandbox, alpha's clone, and alpha's bare origin. */
export type Machine = { box: Sandbox; clone: string; origin: string };

/**
 * Machine m1 with project alpha, its clone on the fixed working branch `nightly` (one commit past main), and one jawan
 * slot held by a live run outside the clone, so a catch-up spawn stays queued and nothing runs.
 */
export function machine(): Machine {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    const clone = withProject(box, "alpha");
    const config = join(box.root, "config", "machine.json");
    const current = JSON.parse(readFileSync(config, "utf8")) as Record<string, unknown>;
    writeFileSync(config, JSON.stringify({ ...current, capacity: { ...ROOMY, maxRuns: 1 } }));
    box.stub("omp", "true");
    runRecord(box, BLOCKER, {});
    box.git(clone, ["switch", "--quiet", "-c", "nightly"]);
    commitFile(box, clone, "work.txt", "nightly work\n");
    box.ok(["project", "set", "alpha", "--branch", "nightly"]);
    return { box, clone, origin: join(box.root, ".origin", "alpha.git") };
}

export function commitFile(box: Sandbox, dir: string, file: string, text: string): string {
    writeFileSync(join(dir, file), text);
    box.git(dir, ["add", file]);
    box.git(dir, ["commit", "--quiet", "-m", `edit ${file}`]);
    return box.git(dir, ["rev-parse", "HEAD"]);
}

/** Cut release `tag` on origin's main from a separate releaser clone; returns the tagged sha. */
export function release(box: Sandbox, origin: string, tag: string, file = "CHANGES", text = `${tag}\n`): string {
    const dir = tempDir("releaser");
    box.git(dir, ["clone", "--quiet", origin, "."]);
    const sha = commitFile(box, dir, file, text);
    box.git(dir, ["tag", tag]);
    box.git(dir, ["push", "--quiet", "origin", "main", tag]);
    return sha;
}
