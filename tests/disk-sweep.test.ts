import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { wipeTargetBetweenBuilds } from "../src/fleet/cargo-lock.ts";
import type { KeepReport } from "../src/fleet/disk.ts";
import { atimeVerdict, sweepStaleArtifacts } from "../src/fleet/stale-sweep.ts";
import { age, agedTarget, artifact, buildOutput, dfLine, holdLock, keeperBox, setCapacity } from "./disk-fixture.ts";
import { sandbox, tempDir, withProject } from "./helpers.ts";

// The keeper tests build a sandbox with git repos and several bin/toli runs: on a loaded machine that alone can take
// longer than bun's 5 s default.
setDefaultTimeout(60_000);

describe("sweeping stale artifacts out of a target in use", () => {
    test("while a build holds the lock it deletes what went unused past the age; the lock and fresh artifacts stay", () => {
        const target = join(realpathSync(tempDir("sweep")), "target");
        const { lock, stale, fresh } = agedTarget(target, 240);
        const release = holdLock(lock);
        try {
            expect(wipeTargetBetweenBuilds(target, 0)).toEqual({ wiped: false, reason: `a build holds ${lock}` });
            const swept = sweepStaleArtifacts(target, 180, false);
            expect(swept.artifacts).toBe(4);
            expect(swept.bytes).toBeGreaterThanOrEqual(4 * 4096);
            expect(swept.failed).toEqual([]);
            for (const path of stale) expect(existsSync(path)).toBe(false);
            for (const path of [...fresh, lock]) expect(existsSync(path)).toBe(true);
        } finally {
            release();
        }
    });

    test("the age setting decides what is stale; a dry run only counts", () => {
        const target = join(realpathSync(tempDir("sweep")), "target");
        const { lock, stale, fresh } = agedTarget(target, 120);
        expect(sweepStaleArtifacts(target, 180, false).artifacts).toBe(0);
        for (const path of stale) expect(existsSync(path)).toBe(true);
        const planned = sweepStaleArtifacts(target, 60, true);
        expect(planned.artifacts).toBe(4);
        for (const path of stale) expect(existsSync(path)).toBe(true);
        expect(sweepStaleArtifacts(target, 60, false).artifacts).toBe(4);
        for (const path of stale) expect(existsSync(path)).toBe(false);
        for (const path of [...fresh, lock]) expect(existsSync(path)).toBe(true);
    });

    test("a folder holding a cargo lock is never swept, however old", () => {
        const target = join(realpathSync(tempDir("sweep")), "target");
        const nested = artifact(join(target, "debug", "build", "old-9f9f", ".cargo-lock"), 0);
        age(nested, 600);
        age(dirname(nested), 600);
        artifact(join(target, "debug", ".fingerprint", "x", "lib-x"));
        expect(sweepStaleArtifacts(target, 60, false).artifacts).toBe(0);
        expect(existsSync(nested)).toBe(true);
    });

    test("atime tells use only where the mount keeps it current for that age", () => {
        expect(atimeVerdict("linux", ["rw", "noatime"], 180).atime).toBe(false);
        expect(atimeVerdict("linux", ["rw", "relatime"], 180).atime).toBe(false);
        expect(atimeVerdict("linux", ["rw", "relatime"], 24 * 60).atime).toBe(true);
        expect(atimeVerdict("linux", ["rw"], 180).atime).toBe(true);
        expect(atimeVerdict("darwin", ["apfs", "local", "journaled"], 180).atime).toBe(false);
        expect(atimeVerdict("darwin", ["apfs", "local", "strictatime"], 180).atime).toBe(true);
        expect(atimeVerdict("darwin", ["apfs", "noatime", "strictatime"], 180).atime).toBe(false);
    });

    test("under the emergency level disk keep sweeps a target a build keeps locked, at capacity.diskSweepStaleMinutes", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const clone = realpathSync(withProject(box, "alpha"));
        buildOutput(box, clone);
        const target = join(clone, "target");
        const { lock, stale, fresh } = agedTarget(target, 120);
        const machineFile = join(box.root, "config", "machine.json");
        const machine = JSON.parse(readFileSync(machineFile, "utf8")) as Record<string, unknown>;
        writeFileSync(machineFile, JSON.stringify({ ...machine, capacity: { diskSweepStaleMinutes: 60 } }));
        box.stub("docker", "exit 1");
        box.stub("sccache", "exit 2");
        // 1 GB free until the sweep removes the stale rlib, 100 GB after: floor 50, so the last resort never runs.
        box.stub(
            "df",
            `if [ -e "${stale[0]}" ]; then kb=1048576; else kb=104857600; fi
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/x 209715200 1 %s 50%% /\\n' "$kb"`,
        );
        const release = holdLock(lock);
        try {
            const keep = ["disk", "keep", "--floor", "50", "--json"];
            const report = JSON.parse(box.ok(keep, { env: { TOLI_DRY_RUN: "0" } })) as KeepReport;
            const lines = report.lines.join("\n");
            expect(lines).toContain(`kept ${target}: a build holds ${lock}`);
            expect(lines).toContain(`swept 4 stale artifacts from ${target} (unused for 60 min, by `);
            expect(report.swept).toHaveLength(1);
            expect(report.swept[0]?.target).toBe(target);
            expect(report.swept[0]?.artifacts).toBe(4);
            expect(report.swept[0]?.bytes).toBeGreaterThanOrEqual(4 * 4096);
            for (const path of stale) expect(existsSync(path)).toBe(false);
            for (const path of [...fresh, lock]) expect(existsSync(path)).toBe(true);
        } finally {
            release();
        }
    });

    test("over the emergency level disk keep never touches a target a build keeps locked, however old", () => {
        const box = keeperBox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const clone = realpathSync(withProject(box, "alpha"));
        buildOutput(box, clone);
        const target = join(clone, "target");
        const { lock, stale, fresh } = agedTarget(target, 240);
        setCapacity(box, { diskSweepStaleMinutes: 60 });
        box.stub("docker", "exit 1");
        box.stub("sccache", "exit 2");
        // 20 GB free of 200 GB: under the floor (50), over the emergency level (6).
        box.stub("df", `kb=${20 * 1048576}\n${dfLine(200)}`);
        const release = holdLock(lock);
        try {
            const keep = ["disk", "keep", "--floor", "50", "--json"];
            const report = JSON.parse(box.ok(keep, { env: { TOLI_DRY_RUN: "0" } })) as KeepReport;
            const lines = report.lines.join("\n");
            expect(report.emergencyGB).toBe(6);
            expect(report.lastResort).toBe(false);
            expect(lines).toContain(`kept ${target}: a build holds ${lock}`);
            expect(lines).toContain(`kept ${target} in use: free 20.0 GB is over the emergency level 6.0 GB`);
            expect(report.swept).toEqual([]);
            expect(lines).not.toContain("stale artifacts");
            for (const path of [...stale, ...fresh, lock]) expect(existsSync(path)).toBe(true);
        } finally {
            release();
        }
    });
});

describe("the disk keeper on a full disk", () => {
    test("with its lock and log unwritable it still frees, without the keeper lock and without crashing", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const idle = realpathSync(withProject(box, "alpha"));
        buildOutput(box, idle);
        box.stub("docker", "exit 1");
        box.stub("sccache", "exit 2");
        // A full disk for real: 1 GB free of 200 GB, under the emergency level, never this host's own free space.
        box.stub(
            "df",
            `printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/x 209715200 1 1048576 99%% /\\n'`,
        );
        // Every write the keeper would make fails, for root too: logs/ is a file, the lock file a folder.
        const logs = join(box.root, "logs");
        rmSync(logs, { recursive: true, force: true });
        writeFileSync(logs, "not a folder\n");
        const keeperLock = join(box.root, "state", "disk-keep.lock");
        mkdirSync(keeperLock, { recursive: true });
        const result = box.toli(["disk", "keep", "--floor", "1000000000", "--json"], { env: { TOLI_DRY_RUN: "0" } });
        expect(result.stderr).not.toContain("    at ");
        expect(result.code).toBe(0);
        const report = JSON.parse(result.stdout) as KeepReport;
        expect(report.ran).toBe(true);
        const lines = report.lines.join("\n");
        expect(lines).toContain(`cannot write ${keeperLock} (`);
        expect(lines).toContain("freeing without the keeper lock");
        expect(lines).toContain(`deleted ${join(idle, "target")}, freed `);
        expect(existsSync(join(idle, "target"))).toBe(false);
        expect(result.stderr).toContain("lines not written to logs/disk.log");
        expect(readFileSync(logs, "utf8")).toBe("not a folder\n");
    });

    test("when the keeper cannot start, the fallback still sweeps stale artifacts out of an idle target, no crash", () => {
        const box = keeperBox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const clone = realpathSync(withProject(box, "alpha"));
        buildOutput(box, clone);
        const { lock, stale, fresh } = agedTarget(join(clone, "target"), 240);
        box.stub("df", "exit 1");
        const result = box.toli(["disk", "keep"], { env: { TOLI_DRY_RUN: "0" } });
        expect(result.stderr).not.toContain("    at ");
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("toli: disk keeper failed: cannot read free disk: df exited 1");
        expect(result.stdout).toContain(`swept 4 stale artifacts from ${join(clone, "target")}`);
        for (const path of stale) expect(existsSync(path)).toBe(false);
        for (const path of [...fresh, lock]) expect(existsSync(path)).toBe(true);
    });

    test("the fallback keeps a target in use whole: a build holding its lock", () => {
        const box = keeperBox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const clone = realpathSync(withProject(box, "alpha"));
        buildOutput(box, clone);
        const target = join(clone, "target");
        const { lock, stale, fresh } = agedTarget(target, 240);
        box.stub("df", "exit 1");
        const release = holdLock(lock);
        try {
            const result = box.toli(["disk", "keep"], { env: { TOLI_DRY_RUN: "0" } });
            expect(result.code).toBe(1);
            expect(result.stdout).toContain(`kept ${target}: in use (a build holds ${lock})`);
            expect(result.stdout).not.toContain("stale artifacts from");
            for (const path of [...stale, ...fresh, lock]) expect(existsSync(path)).toBe(true);
        } finally {
            release();
        }
    });
});
