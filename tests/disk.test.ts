import { describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { wipeTargetBetweenBuilds } from "../src/fleet/cargo-lock.ts";
import type { KeepReport } from "../src/fleet/disk.ts";
import { parseSccacheStats } from "../src/fleet/disk-caches.ts";
import type { HeldFile, ProcessUse, UseProbes } from "../src/fleet/disk-scan.ts";
import { buildOutput, dfLine, holdLock, keeperBox, keeperTest, libc } from "./disk-fixture.ts";
import { type Sandbox, tempDir, withProject } from "./helpers.ts";

/** A running jawan run of `project` working in `cwd`, its supervisor this (live) test process. */
function runningJawan(box: Sandbox, project: string, cwd: string): void {
    const dir = join(box.root, "state", "jawans");
    mkdirSync(dir, { recursive: true });
    const id = "j-20261105-000000-test";
    writeFileSync(
        join(dir, `${id}.json`),
        JSON.stringify({
            id,
            harness: "omp",
            task: "T1",
            project,
            work: "ship",
            model: null,
            cwd,
            runDir: dir,
            briefPath: join(dir, "brief.md"),
            logPath: join(dir, "log"),
            command: "omp",
            maxMinutes: 60,
            status: "running",
            supervisorPid: process.pid,
            pid: process.pid,
            exitCode: null,
            signal: null,
            startedAt: "2026-11-05T00:00:00.000Z",
            endedAt: null,
            inbox: null,
            error: null,
        }),
    );
}

describe("disk keeper", () => {
    keeperTest("above the floor it does nothing", () => {
        const box = keeperBox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        expect(box.ok(["disk", "keep", "--floor", "0"])).toContain("nothing to do");
    });

    keeperTest(
        "under the floor it plans idle build output first, skips a running jawan's clone, never tracked files or a main clone's node_modules",
        () => {
            const box = keeperBox();
            box.ok(["init", "--name", "m1", "--role", "coordinator"]);
            const idle = realpathSync(withProject(box, "alpha"));
            const busy = realpathSync(withProject(box, "beta"));
            buildOutput(box, idle);
            buildOutput(box, busy);
            // An idle worktree of alpha (a queue copy): its node_modules is rebuildable output, unlike the main clone's.
            const copy = join(box.root, "projects", ".worktrees", "alpha", "T1");
            box.git(idle, ["worktree", "add", "--detach", copy]);
            const tree = realpathSync(copy);
            mkdirSync(join(tree, "web", "node_modules", "pkg"), { recursive: true });
            writeFileSync(join(tree, "web", "node_modules", "pkg", "index.js"), "1\n");
            runningJawan(box, "beta", busy);
            box.stub("docker", "exit 1");
            box.stub("sccache", "exit 2");
            box.stub("df", `kb=${100 * 1048576}\n${dfLine(200)}`);
            const report = JSON.parse(
                box.ok(["disk", "keep", "--dry-run", "--floor", "1000000000", "--json"]),
            ) as KeepReport;
            expect(report.ran).toBe(true);
            expect(report.dryRun).toBe(true);
            const lines = report.lines.join("\n");
            expect(lines).toContain(`would delete ${join(idle, "target")} (`);
            expect(lines).toContain(
                `kept ${join(idle, "web", "node_modules")}: a main clone's dependencies (its builds cannot reinstall them)`,
            );
            expect(lines).not.toContain(`would delete ${join(idle, "web", "node_modules")}`);
            expect(lines).toContain(`would delete ${join(tree, "web", "node_modules")} (`);
            expect(lines).toContain(`would delete ${join(idle, "web", "dist")} (`);
            expect(lines).toContain(`skipped ${join(busy, "target")}: jawan j-20261105-000000-test works in it`);
            expect(lines).toContain(`kept ${join(busy, "web", "node_modules")}: a main clone's dependencies`);
            expect(lines).not.toContain(`would delete ${join(busy, "web", "node_modules")}`);
            expect(lines).not.toContain("docs/dist");
            expect(lines).toContain("docker: skipped (daemon not reachable)");
            expect(lines).toContain(`kept ${join(busy, "target")} in use: free 100.0 GB is over the emergency level`);
            const order = ["alpha/target", "T1/web/node_modules", "docker:", "beta/target in use"];
            const at = order.map((text) => lines.indexOf(text));
            expect(at).toEqual([...at].sort((a, b) => a - b));
            expect(existsSync(join(idle, "target"))).toBe(true);
            expect(existsSync(join(idle, "web", "node_modules"))).toBe(true);
        },
    );

    /** Idle `alpha` and `beta`, held by a jawan and a cargo lock, on a 200 GB disk (emergency level 6 GB): 1 GB free
     * while alpha's target exists, `afterGB` once it is gone. */
    function heldTree(box: Sandbox, afterGB = 100): { idle: string; busy: string; release: () => void } {
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const idle = realpathSync(withProject(box, "alpha"));
        const busy = realpathSync(withProject(box, "beta"));
        buildOutput(box, idle);
        buildOutput(box, busy);
        writeFileSync(join(busy, "main.rs"), "fn main() {}\n");
        runningJawan(box, "beta", busy);
        box.stub("docker", "exit 1");
        box.stub("sccache", "exit 2");
        box.stub(
            "df",
            `if [ -e "${join(idle, "target")}" ]; then kb=1048576; else kb=${afterGB * 1048576}; fi
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/x 209715200 1 %s 50%% /\\n' "$kb"`,
        );
        return { idle, busy, release: holdLock(join(busy, "target", "debug", ".cargo-lock")) };
    }

    keeperTest(
        "still under the emergency level after the normal tiers, it deletes held build output too, never sources, git or a main clone's node_modules",
        () => {
            const box = keeperBox();
            const { idle, busy, release } = heldTree(box, 1);
            const browsers = join(box.root, ".playwright");
            mkdirSync(join(browsers, "chromium-1140"), { recursive: true });
            writeFileSync(join(browsers, "chromium-1140", "chrome"), "x");
            writeFileSync(join(browsers, "notes.txt"), "not a browser\n");
            try {
                const keep = ["disk", "keep", "--floor", "50", "--json"];
                const report = JSON.parse(box.ok(keep, { env: { TOLI_DRY_RUN: "0" } })) as KeepReport;
                const lines = report.lines.join("\n");
                expect(report.emergencyGB).toBe(6);
                expect(report.lastResort).toBe(true);
                expect(lines).toContain("free 1.0 GB is under the emergency level 6.0 GB: deleting every build folder");
                expect(lines).toContain(`deleted ${join(idle, "target")}, freed `);
                expect(lines).toContain(`kept ${join(busy, "target")}: a build holds `);
                expect(lines).toContain(`${join(busy, "target")} is in use (a build holds `);
                expect(lines).toContain(`deleted ${join(busy, "target")}, freed `);
                expect(lines).toContain(`kept ${join(busy, "web", "node_modules")}: a main clone's dependencies`);
                expect(lines).toContain(`deleted ${join(browsers, "chromium-1140")}, freed `);
                for (const gone of ["target", "web/dist"]) expect(existsSync(join(busy, gone))).toBe(false);
                // Even the last resort spares a main clone's dependencies: its builds cannot reinstall them.
                expect(existsSync(join(busy, "web", "node_modules", "pkg", "index.js"))).toBe(true);
                expect(existsSync(join(browsers, "chromium-1140"))).toBe(false);
                expect(readFileSync(join(browsers, "notes.txt"), "utf8")).toBe("not a browser\n");
                expect(readFileSync(join(busy, "main.rs"), "utf8")).toBe("fn main() {}\n");
                expect(readFileSync(join(busy, "docs", "dist", "page.html"), "utf8")).toBe("tracked\n");
                expect(box.git(busy, ["log", "--format=%s", "-1"])).toBe("tracked dist");
            } finally {
                release();
            }
        },
    );

    keeperTest("back above the floor after the normal tiers, it keeps held build output", () => {
        const box = keeperBox();
        const { idle, busy, release } = heldTree(box);
        try {
            // Floor 50, goal 70: deleting idle alpha's target brings free from 1 GB to 100 GB.
            const keep = ["disk", "keep", "--floor", "50", "--json"];
            const report = JSON.parse(box.ok(keep, { env: { TOLI_DRY_RUN: "0" } })) as KeepReport;
            const lines = report.lines.join("\n");
            expect(report.lastResort).toBe(false);
            expect(lines).toContain(`deleted ${join(idle, "target")}, freed `);
            expect(lines).not.toContain("still under the floor");
            for (const held of ["target/debug/deps/libx.rlib", "web/node_modules/pkg/index.js", "web/dist/app.js"])
                expect(existsSync(join(busy, held))).toBe(true);
        } finally {
            release();
        }
    });

    keeperTest("under the floor but over the emergency level, it never deletes build output in use", () => {
        const box = keeperBox();
        const { idle, busy, release } = heldTree(box, 45); // floor 50, emergency 6: 45 GB free after alpha's target
        try {
            const keep = ["disk", "keep", "--floor", "50", "--json"];
            const report = JSON.parse(box.ok(keep, { env: { TOLI_DRY_RUN: "0" } })) as KeepReport;
            const lines = report.lines.join("\n");
            expect(report.lastResort).toBe(false);
            expect(lines).toContain(`deleted ${join(idle, "target")}, freed `);
            expect(lines).not.toContain("deleting it anyway");
            expect(lines).toContain("done, still under the floor");
            for (const held of ["target/debug/deps/libx.rlib", "web/node_modules/pkg/index.js", "web/dist/app.js"])
                expect(existsSync(join(busy, held))).toBe(true);
        } finally {
            release();
        }
    });

    keeperTest("a live pid in state/disk-keep.pause holds it off, logged once; a dead pid's pause is stale", () => {
        const box = keeperBox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const idle = realpathSync(withProject(box, "alpha"));
        buildOutput(box, idle);
        box.stub("docker", "exit 1");
        box.stub("sccache", "exit 2");
        const keep = (): KeepReport =>
            JSON.parse(box.ok(["disk", "keep", "--dry-run", "--floor", "1000000000", "--json"])) as KeepReport;
        const pause = join(box.root, "state", "disk-keep.pause");
        const diskLog = join(box.root, "logs", "disk.log");
        writeFileSync(pause, `${process.pid}\nrelease gate\n`);
        for (const _ of [1, 2, 3]) {
            const report = keep();
            expect(report.ran).toBe(false);
            expect(report.pausedBy).toBe(process.pid);
            expect(report.lines.join("\n")).toContain(`paused by pid ${process.pid} (release gate)`);
            expect(report.lines.join("\n")).not.toContain("would delete");
        }
        const pausedLines = readFileSync(diskLog, "utf8")
            .split("\n")
            .filter((line) => line.includes("paused by"));
        expect(pausedLines).toHaveLength(1);

        const dead = Bun.spawnSync(["true"]).pid;
        writeFileSync(pause, `${dead}\n`);
        const report = keep();
        expect(report.ran).toBe(true);
        expect(report.pausedBy).toBeUndefined();
        expect(report.lines.join("\n")).toContain(`would delete ${join(idle, "target")} (`);
    });

    keeperTest("beside another live keeper it logs that once, not on every run", () => {
        const box = keeperBox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        mkdirSync(join(box.root, "state"), { recursive: true });
        writeFileSync(join(box.root, "state", "disk-keep.lock"), String(process.pid));
        for (const _ of [1, 2, 3]) {
            const report = JSON.parse(box.ok(["disk", "keep", "--floor", "1000000000", "--json"])) as KeepReport;
            expect(report.ran).toBe(false);
            expect(report.lines.join("\n")).toContain(`another disk keeper (pid ${process.pid}) is already running`);
        }
        const log = readFileSync(join(box.root, "logs", "disk.log"), "utf8");
        expect(log.split("\n").filter((line) => line.includes("already running"))).toHaveLength(1);
    });
});

describe("wiping a target between build steps", () => {
    /** The processes, open files, cargo runs and configured build tools a wipe sees: injected, never the host's. */
    type Machine = {
        processes: ProcessUse[];
        openFiles: HeldFile[];
        cargos: { pid: string; cwd: string }[];
        buildTools: string[];
    };

    function quiet(): Machine {
        return { processes: [], openFiles: [], cargos: [], buildTools: [] };
    }

    function probes(machine: Machine): UseProbes {
        return {
            processes: () => machine.processes,
            openFiles: () => machine.openFiles,
            cargos: () => machine.cargos,
            buildTools: () => machine.buildTools,
        };
    }

    /** A `sleep` working in `cwd`: it runs and maps nothing but `/bin/sleep`. */
    function sleeping(pid: string, cwd: string): ProcessUse {
        return { pid, args: "/bin/sleep 30", files: ["/bin/sleep"], cwd };
    }

    test("keeps the target while a build holds cargo's lock, wipes it once the lock is free", () => {
        const target = join(tempDir("disk"), "target");
        mkdirSync(join(target, "debug", "deps"), { recursive: true });
        const lock = join(target, "debug", ".cargo-lock");
        writeFileSync(lock, "");
        const fd = openSync(lock, "r");
        expect(libc.symbols.flock(fd, 2 | 4)).toBe(0);
        const held = wipeTargetBetweenBuilds(target, 0, undefined, probes(quiet()));
        expect(held).toEqual({ wiped: false, reason: `a build holds ${lock}` });
        expect(existsSync(target)).toBe(true);
        libc.symbols.flock(fd, 8);
        closeSync(fd);
        expect(wipeTargetBetweenBuilds(target, 0, undefined, probes(quiet()))).toEqual({ wiped: true });
        expect(existsSync(target)).toBe(false);
    });

    /** A cargo-like target with its lock file, in a workspace folder of its own. */
    function workspaceTarget(): { workspace: string; target: string } {
        const workspace = realpathSync(tempDir("disk"));
        const target = join(workspace, "target");
        mkdirSync(join(target, "debug", "deps"), { recursive: true });
        writeFileSync(join(target, "debug", ".cargo-lock"), "");
        return { workspace, target };
    }

    test("keeps the target while a test binary built into it runs, though no build holds the lock", () => {
        const { target } = workspaceTarget();
        const binary = join(target, "debug", "deps", "robo_agent_kit_store-0123");
        writeFileSync(binary, "");
        const machine = quiet();
        machine.processes.push({ pid: "4101", args: binary, files: [binary], cwd: realpathSync(tempDir("elsewhere")) });
        const outcome = wipeTargetBetweenBuilds(target, 0, undefined, probes(machine));
        expect(outcome).toEqual({ wiped: false, reason: `process 4101 runs ${binary}` });
        expect(existsSync(binary)).toBe(true);
    });

    test("keeps the target while a process works inside its workspace", () => {
        const { workspace, target } = workspaceTarget();
        const crate = join(workspace, "crates", "store");
        mkdirSync(crate, { recursive: true });
        const machine = quiet();
        machine.processes.push(sleeping("4102", crate));
        const outcome = wipeTargetBetweenBuilds(target, 0, undefined, probes(machine));
        expect(outcome).toEqual({ wiped: false, reason: `process 4102 runs in ${crate}` });
        expect(existsSync(target)).toBe(true);
    });

    test("wipes an idle target that no build locks and no process uses", () => {
        const { workspace, target } = workspaceTarget();
        const machine = quiet();
        machine.processes.push(sleeping("4103", realpathSync(tempDir("elsewhere"))));
        expect(wipeTargetBetweenBuilds(target, 0, undefined, probes(machine))).toEqual({ wiped: true });
        expect(existsSync(target)).toBe(false);
        expect(existsSync(workspace)).toBe(true);
    });

    test("keeps the target while a process holds a file in it open, wipes it once the file is closed", () => {
        const { target } = workspaceTarget();
        const log = join(target, "debug", "build.log");
        writeFileSync(log, "");
        const machine = quiet();
        machine.openFiles.push({ path: log, pid: "4104" });
        const busy = wipeTargetBetweenBuilds(target, 0, undefined, probes(machine));
        expect(busy).toEqual({ wiped: false, reason: `open files, e.g. ${log} (pid 4104)` });
        expect(existsSync(target)).toBe(true);
        machine.openFiles.length = 0;
        expect(wipeTargetBetweenBuilds(target, 0, undefined, probes(machine))).toEqual({ wiped: true });
        expect(existsSync(target)).toBe(false);
    });

    test("keeps the target while a test binary runs from it, wipes it once the binary exits", () => {
        const { workspace, target } = workspaceTarget();
        const binary = join(target, "debug", "deps", "robo_store-0123abcd");
        writeFileSync(binary, "");
        const machine = quiet();
        machine.processes.push({ pid: "4105", args: binary, files: [binary], cwd: workspace });
        const busy = wipeTargetBetweenBuilds(target, 0, undefined, probes(machine));
        expect(busy.wiped).toBe(false);
        expect(existsSync(target)).toBe(true);
        machine.processes.length = 0;
        expect(wipeTargetBetweenBuilds(target, 0, undefined, probes(machine))).toEqual({ wiped: true });
        expect(existsSync(target)).toBe(false);
    });

    test("keeps the target while cargo runs in its workspace between test binaries, wipes it once cargo exits", () => {
        const { workspace, target } = workspaceTarget();
        // `cargo test` releases its build lock before it runs the test binaries one after another; between two of
        // them nothing in the target is open, yet cargo is about to start the next one from it.
        const crate = join(workspace, "crates", "store");
        mkdirSync(crate, { recursive: true });
        const machine = quiet();
        machine.processes.push({ pid: "4106", args: "cargo test", files: ["/opt/cargo/bin/cargo"], cwd: crate });
        machine.cargos.push({ pid: "4106", cwd: crate });
        const busy = wipeTargetBetweenBuilds(target, 0, undefined, probes(machine));
        expect(busy).toEqual({ wiped: false, reason: `cargo (pid 4106) runs in ${crate}` });
        expect(existsSync(target)).toBe(true);
        machine.processes.length = 0;
        machine.cargos.length = 0;
        expect(wipeTargetBetweenBuilds(target, 0, undefined, probes(machine))).toEqual({ wiped: true });
        expect(existsSync(target)).toBe(false);
    });

    test("keeps the target while a tool in capacity.diskBuildTools runs above its workspace, and only then", () => {
        const { workspace, target } = workspaceTarget();
        const above = dirname(workspace);
        const machine = quiet();
        machine.processes.push({ pid: "4107", args: "bun /opt/tools/my-queue.ts run", files: [], cwd: above });
        machine.processes.push({ pid: "4108", args: "/usr/local/bin/my-tool queue", files: [], cwd: above });
        machine.buildTools.push("my-queue");
        const queue = wipeTargetBetweenBuilds(target, 0, undefined, probes(machine));
        expect(queue).toEqual({ wiped: false, reason: `my-queue (pid 4107) builds in ${workspace}` });
        machine.buildTools.splice(0, 1, "my-tool queue");
        const words = wipeTargetBetweenBuilds(target, 0, undefined, probes(machine));
        expect(words).toEqual({ wiped: false, reason: `my-tool queue (pid 4108) builds in ${workspace}` });
        expect(existsSync(target)).toBe(true);
        machine.buildTools.length = 0;
        expect(wipeTargetBetweenBuilds(target, 0, undefined, probes(machine))).toEqual({ wiped: true });
        expect(existsSync(target)).toBe(false);
    });
});

describe("sccache stats", () => {
    test("reads the local cache directory, size and cap", () => {
        const stats = parseSccacheStats(
            'Cache location                  Local disk: "/Users/x/Library/Caches/Mozilla.sccache"\nCache size                           41 GiB\nMax cache size                       40 GiB\n',
        );
        expect(stats).toEqual({
            dir: "/Users/x/Library/Caches/Mozilla.sccache",
            bytes: 41 * 1024 ** 3,
            maxBytes: 40 * 1024 ** 3,
        });
    });

    test("other backends are not trimmed", () => {
        expect(parseSccacheStats("Cache location                  S3, bucket: x\n")).toBeNull();
    });
});
