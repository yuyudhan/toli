import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeepReport } from "../src/fleet/disk.ts";
import { parseSccacheStats } from "../src/fleet/disk-caches.ts";
import { buildOutput, dfLine, holdLock, keeperBox, keeperTest } from "./disk-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";

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

    keeperTest("a keeper stuck past its time limit logs it and exits instead of hanging (T1907)", () => {
        const box = keeperBox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        // A df that never answers in time stands for any call that blocks: a privacy prompt nobody clicks.
        box.stub("df", "exec sleep 30");
        const started = Date.now();
        const result = box.toli(["disk", "keep"], { env: { TOLI_DISK_KEEP_LIMIT_MS: "1000" } });
        expect(Date.now() - started).toBeLessThan(20_000);
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain("disk keeper: stopped after its time limit of 1 s");
        expect(readFileSync(join(box.root, "logs", "disk.log"), "utf8")).toContain(
            "stopped after its time limit of 1 s",
        );
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
            const order = ["alpha/target", "T1/web/node_modules", "docker:"];
            const at = order.map((text) => lines.indexOf(text));
            expect(at).toEqual([...at].sort((a, b) => a - b));
            expect(existsSync(join(idle, "target"))).toBe(true);
            expect(existsSync(join(idle, "web", "node_modules"))).toBe(true);
        },
    );

    // T1905: an open task's worktree lost its node_modules to step 2 while its in-session subagent worked there between
    // two commands. T2107: a done task's worktree stayed held by its old jawan tag for as long as the lead session
    // lived (one subagent id, reused task after task, held a dozen worktrees at 96% full); a follow-up reopens it.
    keeperTest(
        "keeps the build output of an open task's worktree whose native jawan is live, never a done one's",
        () => {
            const box = keeperBox();
            box.ok(["init", "--name", "m1", "--role", "coordinator"]);
            const clone = realpathSync(withProject(box, "alpha"));
            buildOutput(box, clone);
            box.ok(["task", "add", "alpha", "Home approvals"]);
            const copy = join(box.root, "projects", ".worktrees", "alpha", "T1");
            box.git(clone, ["worktree", "add", "--detach", copy]);
            const tree = realpathSync(copy);
            mkdirSync(join(tree, "web", "node_modules", "pkg"), { recursive: true });
            writeFileSync(join(tree, "web", "node_modules", "pkg", "index.js"), "1\n");
            const backlogFile = join(box.root, "data", "backlog.json");
            const backlog = JSON.parse(readFileSync(backlogFile, "utf8")) as { tasks: Record<string, unknown>[] };
            const record = (fields: Record<string, unknown>): void => {
                Object.assign(backlog.tasks[0] ?? {}, fields);
                writeFileSync(backlogFile, JSON.stringify(backlog));
            };
            record({
                status: "active",
                agent: "T1Follow",
                agentSession: { agent: "T1Follow", pid: process.pid },
                dispatchedAt: new Date().toISOString(),
                workspace: { strategy: "worktree-per-task", path: copy, branch: null, base: "main" },
            });
            box.stub("docker", "exit 1");
            box.stub("sccache", "exit 2");
            const keep = (): string =>
                (
                    JSON.parse(box.ok(["disk", "keep", "--dry-run", "--floor", "1000000000", "--json"])) as KeepReport
                ).lines.join("\n");
            const lines = keep();
            expect(lines).toContain(`skipped ${join(tree, "web", "node_modules")}: T1's jawan T1Follow works in it`);
            expect(lines).not.toContain(`would delete ${join(tree, "web", "node_modules")}`);
            // Done, its subagent's session still alive: the old tag holds nothing.
            record({ status: "done", doneAt: new Date().toISOString() });
            expect(keep()).toContain(`would delete ${join(tree, "web", "node_modules")} (`);
            // Open again, but its subagent's session is gone: idle output too.
            record({ status: "active", agentSession: { agent: "T1Follow", pid: Bun.spawnSync(["true"]).pid } });
            expect(keep()).toContain(`would delete ${join(tree, "web", "node_modules")} (`);
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

    // T2030: a builder's keeper deleted a worktree's node_modules mid-gate at 6.6 GB free.
    keeperTest(
        "still under the emergency level after the normal tiers, it never deletes a build folder in use: it pauses new jobs and alerts once",
        () => {
            const box = keeperBox();
            const { idle, busy, release } = heldTree(box, 1);
            // A worktree of alpha a push gate is checking right now (its runner, this test, is alive).
            const copy = join(box.root, "projects", ".worktrees", "alpha", "T1");
            box.git(idle, ["worktree", "add", "--detach", copy]);
            const tree = realpathSync(copy);
            const deps = join(tree, "web", "node_modules");
            mkdirSync(join(deps, "pkg"), { recursive: true });
            writeFileSync(join(deps, "pkg", "index.js"), "1\n");
            const gates = join(box.root, "state", "gates", "alpha");
            mkdirSync(gates, { recursive: true });
            const gate = { project: "alpha", sha: "a".repeat(40), tree: "b".repeat(40), recipe: "just verify" };
            writeFileSync(
                join(gates, `${"b".repeat(40)}-0123456789abcdef.json`),
                JSON.stringify({
                    ...gate,
                    dir: tree,
                    status: "running",
                    pid: process.pid,
                    startedAt: "",
                    endedAt: null,
                }),
            );
            const browsers = join(box.root, ".playwright");
            mkdirSync(join(browsers, "chromium-1140"), { recursive: true });
            writeFileSync(join(browsers, "chromium-1140", "chrome"), "x");
            writeFileSync(join(browsers, "notes.txt"), "not a browser\n");
            const env = { TOLI_DRY_RUN: "0" };
            const alerts = (): string[] =>
                (JSON.parse(box.ok(["inbox", "list", "--json"])) as { title: string }[])
                    .map((item) => item.title)
                    .filter((title) => title.startsWith("disk full on m1"));
            try {
                const keep = ["disk", "keep", "--floor", "50", "--json"];
                const report = JSON.parse(box.ok(keep, { env })) as KeepReport;
                const lines = report.lines.join("\n");
                expect(report.emergencyGB).toBe(6);
                expect(report.lastResort).toBe(true);
                expect(lines).toContain(`deleted ${join(idle, "target")}, freed `);
                expect(lines).toContain(`skipped ${join(busy, "target")}: jawan j-20261105-000000-test works in it`);
                expect(lines).toContain(`skipped ${deps}: a gate of alpha (pid ${process.pid}) runs in it`);
                expect(lines).toContain(`deleted ${join(browsers, "chromium-1140")}, freed `);
                expect(lines).not.toContain("deleting it anyway");
                for (const kept of ["target/debug/deps/libx.rlib", "web/dist/app.js", "web/node_modules/pkg/index.js"])
                    expect(existsSync(join(busy, kept))).toBe(true);
                expect(existsSync(join(deps, "pkg", "index.js"))).toBe(true);
                expect(readFileSync(join(browsers, "notes.txt"), "utf8")).toBe("not a browser\n");
                expect(readFileSync(join(busy, "main.rs"), "utf8")).toBe("fn main() {}\n");
                expect(report.inUseLeft).toContainEqual({
                    path: join(busy, "target"),
                    reason: "jawan j-20261105-000000-test works in it",
                });
                expect(report.inUseLeft).toContainEqual({
                    path: deps,
                    reason: `a gate of alpha (pid ${process.pid}) runs in it`,
                });
                expect(report.jobsPaused).toBe(true);
                expect(lines).toContain("new jobs paused until free disk is over the emergency level");
                expect(alerts()).toEqual(["disk full on m1: new jobs paused, only build folders in use left"]);

                // While paused a new jawan run queues, saying why; the keeper it runs first renews the pause, no new
                // alert; the tick starts no queued run.
                box.stub("omp", "true");
                const brief = join(box.root, "brief.md");
                writeFileSync(brief, "TOLI_BRIEF v1\nsay hi\n");
                const spawned = box.ok(["spawn", "--harness", "omp", "--brief", brief, "--cwd", box.root], { env });
                expect(spawned).toMatch(
                    /^queued j-\S+: new jobs paused \(since \S+\): free 1\.0 GB is under the emergency level/m,
                );
                expect(alerts()).toHaveLength(1);
                box.ok(["job", "tick"], { env });
                const id = /^queued (j-\S+):/m.exec(spawned)?.[1];
                const runs = JSON.parse(box.ok(["runs", "--json"])) as { id: string; status: string }[];
                expect(runs.find((run) => run.id === id)?.status).toBe("queued");
            } finally {
                release();
            }
        },
    );

    keeperTest("a disk hold lifts once free disk is back over the floor", () => {
        const box = keeperBox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        mkdirSync(join(box.root, "state"), { recursive: true });
        const until = new Date(Date.now() + 10 * 60_000).toISOString();
        const hold = { reason: "free 1.0 GB is under the emergency level", since: new Date().toISOString(), until };
        writeFileSync(join(box.root, "state", "disk-hold.json"), JSON.stringify(hold));
        box.stub("docker", "exit 1");
        box.stub("sccache", "exit 2");
        box.stub("df", `kb=${100 * 1048576}\n${dfLine(200)}`);
        const report = JSON.parse(
            box.ok(["disk", "keep", "--floor", "50", "--json"], { env: { TOLI_DRY_RUN: "0" } }),
        ) as KeepReport;
        expect(report.jobsPaused).toBe(false);
        expect(report.lines).toEqual(["new jobs resume: free 100.0 GB is back over the floor"]);
        expect(existsSync(join(box.root, "state", "disk-hold.json"))).toBe(false);
        expect(readFileSync(join(box.root, "logs", "disk.log"), "utf8")).toContain("new jobs resume");
    });

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
