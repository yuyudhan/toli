import { dlopen, FFIType } from "bun:ffi";
import { describe, expect, test } from "bun:test";
import {
    closeSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    realpathSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { wipeTargetBetweenBuilds } from "../src/fleet/cargo-lock.ts";
import type { KeepReport } from "../src/fleet/disk.ts";
import { parseSccacheStats } from "../src/fleet/disk-caches.ts";
import { type Sandbox, sandbox, tempDir, withProject } from "./helpers.ts";

/** A clone with a cargo-style target, node_modules and dist, all git-ignored, plus a tracked dist in `docs/`. */
function buildOutput(box: Sandbox, clone: string): void {
    writeFileSync(join(clone, ".gitignore"), "target/\nnode_modules/\ndist/\n");
    mkdirSync(join(clone, "docs", "dist"), { recursive: true });
    writeFileSync(join(clone, "docs", "dist", "page.html"), "tracked\n");
    box.git(clone, ["add", "-f", ".gitignore", "docs/dist/page.html"]);
    box.git(clone, ["commit", "-m", "tracked dist"]);
    mkdirSync(join(clone, "target", "debug", "deps"), { recursive: true });
    writeFileSync(join(clone, "target", "debug", ".cargo-lock"), "");
    writeFileSync(join(clone, "target", "debug", "deps", "libx.rlib"), "x".repeat(4096));
    mkdirSync(join(clone, "web", "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(clone, "web", "node_modules", "pkg", "index.js"), "1\n");
    mkdirSync(join(clone, "web", "dist"), { recursive: true });
    writeFileSync(join(clone, "web", "dist", "app.js"), "1\n");
}

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
    test("above the floor it does nothing", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        expect(box.ok(["disk", "keep", "--floor", "0"])).toContain("nothing to do");
    });

    test("under the floor it plans idle build output first, skips a running jawan's clone, never tracked files or a main clone's node_modules", () => {
        const box = sandbox();
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
        // The busy clone's target is still freed, but only between build steps, under cargo's locks.
        expect(lines).toContain(`${join(busy, "target")} is in use (jawan j-20261105-000000-test works in it)`);
        const order = ["alpha/target", "T1/web/node_modules", "docker:", "beta/target is in use"].map((text) =>
            lines.indexOf(text),
        );
        expect(order).toEqual([...order].sort((a, b) => a - b));
        expect(existsSync(join(idle, "target"))).toBe(true);
        expect(existsSync(join(idle, "web", "node_modules"))).toBe(true);
    });

    test("a live pid in state/disk-keep.pause holds it off, logged once; a dead pid's pause is stale", () => {
        const box = sandbox();
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

    test("beside another live keeper it logs that once, not on every run", () => {
        const box = sandbox();
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
    const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });

    test("keeps the target while a build holds cargo's lock, wipes it once the lock is free", () => {
        const target = join(tempDir("disk"), "target");
        mkdirSync(join(target, "debug", "deps"), { recursive: true });
        const lock = join(target, "debug", ".cargo-lock");
        writeFileSync(lock, "");
        const fd = openSync(lock, "r");
        expect(libc.symbols.flock(fd, 2 | 4)).toBe(0);
        const held = wipeTargetBetweenBuilds(target, 0);
        expect(held).toEqual({ wiped: false, reason: `a build holds ${lock}` });
        expect(existsSync(target)).toBe(true);
        libc.symbols.flock(fd, 8);
        closeSync(fd);
        expect(wipeTargetBetweenBuilds(target, 0)).toEqual({ wiped: true });
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

    /**
     * Run a process that idles for `seconds` in `cwd`: `/bin/sleep` itself, or a copy of bun at `exe`. Not a copy of
     * `/bin/sleep`: macOS launch constraints kill a platform binary started from another path, so that stand-in often
     * died before the keeper looked, and the keeper rightly wiped a target nothing used any more.
     */
    function idler(cwd: string, exe: string, seconds: number): Subprocess {
        if (exe === "/bin/sleep")
            return Bun.spawn([exe, String(seconds)], { cwd, stdio: ["ignore", "ignore", "ignore"] });
        copyFileSync(process.execPath, exe);
        return Bun.spawn([exe, "-e", `setTimeout(() => {}, ${seconds * 1000})`], {
            cwd,
            stdio: ["ignore", "ignore", "ignore"],
        });
    }

    /** Run `sleep` (or an idling copy of bun at `exe`) in `cwd` until the test ends. */
    function sleeper(cwd: string, exe = "/bin/sleep"): Subprocess {
        return idler(cwd, exe, 30);
    }

    test("keeps the target while a test binary built into it runs, though no build holds the lock", () => {
        const { target } = workspaceTarget();
        const binary = join(target, "debug", "deps", "robo_agent_kit_store-0123");
        const child = sleeper(realpathSync(tempDir("elsewhere")), binary);
        try {
            const outcome = wipeTargetBetweenBuilds(target, 0);
            expect(outcome).toEqual({ wiped: false, reason: `process ${child.pid} runs ${binary}` });
            expect(existsSync(binary)).toBe(true);
        } finally {
            child.kill("SIGKILL");
        }
    });

    test("keeps the target while a process works inside its workspace", () => {
        const { workspace, target } = workspaceTarget();
        const crate = join(workspace, "crates", "store");
        mkdirSync(crate, { recursive: true });
        const child = sleeper(crate);
        try {
            const outcome = wipeTargetBetweenBuilds(target, 0);
            expect(outcome).toEqual({ wiped: false, reason: `process ${child.pid} runs in ${crate}` });
            expect(existsSync(target)).toBe(true);
        } finally {
            child.kill("SIGKILL");
        }
    });

    test("wipes an idle target that no build locks and no process uses", () => {
        const { workspace, target } = workspaceTarget();
        const child = sleeper(realpathSync(tempDir("elsewhere")));
        try {
            expect(wipeTargetBetweenBuilds(target, 0)).toEqual({ wiped: true });
            expect(existsSync(target)).toBe(false);
            expect(existsSync(workspace)).toBe(true);
        } finally {
            child.kill("SIGKILL");
        }
    });

    /** A copy of `sleep` named `name` in `dir`, running with working directory `cwd` (Bun.spawn returns after exec). */
    function standIn(dir: string, name: string, cwd: string): Bun.Subprocess {
        mkdirSync(dir, { recursive: true });
        mkdirSync(cwd, { recursive: true });
        const binary = join(dir, name);
        return idler(cwd, binary, 60);
    }

    test("keeps the target while a test binary runs from it, wipes it once the binary exits", async () => {
        const workspace = realpathSync(tempDir("disk"));
        const target = join(workspace, "target");
        mkdirSync(join(target, "debug"), { recursive: true });
        writeFileSync(join(target, "debug", ".cargo-lock"), "");
        const binary = standIn(join(target, "debug", "deps"), "robo_store-0123abcd", workspace);
        const busy = wipeTargetBetweenBuilds(target, 0);
        expect(busy.wiped).toBe(false);
        expect(existsSync(target)).toBe(true);
        binary.kill();
        await binary.exited;
        expect(wipeTargetBetweenBuilds(target, 0)).toEqual({ wiped: true });
        expect(existsSync(target)).toBe(false);
    });

    test("keeps the target while cargo runs in its workspace between test binaries, wipes it once cargo exits", async () => {
        const workspace = realpathSync(tempDir("disk"));
        const target = join(workspace, "target");
        mkdirSync(join(target, "debug", "deps"), { recursive: true });
        writeFileSync(join(target, "debug", ".cargo-lock"), "");
        // `cargo test` releases its build lock before it runs the test binaries one after another; between two of
        // them nothing in the target is open, yet cargo is about to start the next one from it.
        const crate = join(workspace, "crates", "store");
        const cargo = standIn(tempDir("bin"), "cargo", crate);
        const busy = wipeTargetBetweenBuilds(target, 0);
        expect(busy).toEqual({ wiped: false, reason: `cargo (pid ${cargo.pid}) runs in ${crate}` });
        expect(existsSync(target)).toBe(true);
        cargo.kill();
        await cargo.exited;
        expect(wipeTargetBetweenBuilds(target, 0)).toEqual({ wiped: true });
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
