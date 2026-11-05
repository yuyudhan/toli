import { dlopen, FFIType } from "bun:ffi";
import { describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

    test("under the floor it plans idle build output first, skips a running jawan's clone, never tracked files", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const idle = realpathSync(withProject(box, "alpha"));
        const busy = realpathSync(withProject(box, "beta"));
        buildOutput(box, idle);
        buildOutput(box, busy);
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
        expect(lines).toContain(`would delete ${join(idle, "web", "node_modules")} (`);
        expect(lines).toContain(`would delete ${join(idle, "web", "dist")} (`);
        expect(lines).toContain(`skipped ${join(busy, "target")}: jawan j-20261105-000000-test works in it`);
        expect(lines).toContain(`skipped ${join(busy, "web", "node_modules")}: jawan`);
        expect(lines).not.toContain(`would delete ${join(busy, "web", "node_modules")}`);
        expect(lines).not.toContain("docs/dist");
        expect(lines).toContain("docker: skipped (daemon not reachable)");
        // The busy clone's target is still freed, but only between build steps, under cargo's locks.
        expect(lines).toContain(`${join(busy, "target")} is in use (jawan j-20261105-000000-test works in it)`);
        const order = ["alpha/target", "alpha/web/node_modules", "docker:", "beta/target is in use"].map((text) =>
            lines.indexOf(text),
        );
        expect(order).toEqual([...order].sort((a, b) => a - b));
        expect(existsSync(join(idle, "target"))).toBe(true);
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
