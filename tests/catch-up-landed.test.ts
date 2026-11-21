// T2209: a long-lived branch whose tip is already on origin's main (its task's work landed) gets no release
// catch-up: the scan reports it skipped and starts no jawan for it, and `catch-up merge` merges nothing into it.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOMY } from "./fleet-fixture.ts";
import { type Sandbox, sandbox, tempDir, withProject } from "./helpers.ts";

const BLOCKER = "j-20261120-080000-aaaa";

/** A live jawan run under this test process, outside the clone: it holds the one slot, so a catch-up stays queued. */
function blocker(box: Sandbox): void {
    const dir = join(box.root, "state", "jawans");
    const runDir = join(dir, BLOCKER);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "brief.md"), "TOLI_BRIEF v1\n");
    writeFileSync(
        join(dir, `${BLOCKER}.json`),
        JSON.stringify({
            id: BLOCKER,
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
        }),
    );
}

type RunRecord = { id: string };

/** The catch-up runs started (every run but the blocker). */
function catchUpRuns(box: Sandbox): string[] {
    const dir = join(box.root, "state", "jawans");
    const records = readdirSync(dir)
        .filter((file) => file.endsWith(".json") && file !== `${BLOCKER}.json`)
        .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as RunRecord);
    return records.map((record) => record.id);
}

function commitFile(box: Sandbox, dir: string, file: string, text: string): string {
    writeFileSync(join(dir, file), text);
    box.git(dir, ["add", file]);
    box.git(dir, ["commit", "--quiet", "-m", `edit ${file}`]);
    return box.git(dir, ["rev-parse", "HEAD"]);
}

/** Cut release `tag` on origin's main from a separate releaser clone. */
function release(box: Sandbox, origin: string, tag: string): void {
    const dir = tempDir("releaser");
    box.git(dir, ["clone", "--quiet", origin, "."]);
    commitFile(box, dir, "CHANGES", `${tag}\n`);
    box.git(dir, ["tag", tag]);
    box.git(dir, ["push", "--quiet", "origin", "main", tag]);
}

describe("catch-up of a branch already on origin/main", () => {
    test("is skipped by the scan and the merge; once it has new work it is caught up again", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const clone = withProject(box, "alpha");
        const config = join(box.root, "config", "machine.json");
        const current = JSON.parse(readFileSync(config, "utf8")) as Record<string, unknown>;
        writeFileSync(config, JSON.stringify({ ...current, capacity: { ...ROOMY, maxRuns: 1 } }));
        box.stub("omp", "true");
        blocker(box);
        const origin = join(box.root, ".origin", "alpha.git");

        // nightly's work landed: its tip is on origin's main, and a release followed.
        box.git(clone, ["switch", "--quiet", "-c", "nightly"]);
        const tip = commitFile(box, clone, "work.txt", "nightly work\n");
        box.ok(["project", "set", "alpha", "--branch", "nightly"]);
        box.git(clone, ["push", "--quiet", "origin", "nightly:main"]);
        release(box, origin, "v1.0.0");

        const skipped = `nightly: skipped: already on origin/main (${tip.slice(0, 12)})`;
        const scan = box.ok(["catch-up", "scan"]);
        expect(scan).toContain(skipped);
        expect(scan).not.toContain("catch-up run");
        expect(catchUpRuns(box)).toEqual([]);
        const merge = box.ok(["catch-up", "merge", "alpha", "--tag", "v1.0.0"]);
        expect(merge).toContain(`${skipped}; nothing merged`);
        expect(box.git(clone, ["rev-parse", "HEAD"])).toBe(tip);
        // Skipped, not attempted: the scan says so again rather than "already had a catch-up".
        expect(box.ok(["catch-up", "scan"])).toContain(skipped);

        // New work on nightly is not on main: the next scan catches it up.
        commitFile(box, clone, "more.txt", "more work\n");
        const next = box.ok(["catch-up", "scan"]);
        expect(next).not.toContain("skipped: already on");
        expect(next).toContain("for nightly");
        expect(catchUpRuns(box)).toHaveLength(1);
    });
});
