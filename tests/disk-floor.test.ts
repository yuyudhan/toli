// The disk keeper's floor, its use probes on Linux, its deletion order, its pause marker's expiry, and its skips.
import { describe, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { floorText, type KeepReport, keepDisk } from "../src/fleet/disk.ts";
import { age, buildOutput, dfLine, holdLock, keeperBox, keeperTest, setCapacity } from "./disk-fixture.ts";
import { inProcess, type Sandbox, tempDir, withProject } from "./helpers.ts";

/** A sandbox with registered projects, each clone holding cargo-like build output; returns the resolved clones. */
function clones(box: Sandbox, names: string[]): string[] {
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    box.stub("docker", "exit 1");
    box.stub("sccache", "exit 2");
    return names.map((name) => {
        const clone = realpathSync(withProject(box, name));
        buildOutput(box, clone);
        return clone;
    });
}

/** Age a clone's build output folders and their direct children, which is what the keeper's "last used" reads. */
function ageOutput(clone: string, minutes: number): void {
    for (const dir of ["target", "web/node_modules", "web/dist"]) {
        for (const path of [join(clone, dir, "debug"), join(clone, dir, "pkg"), join(clone, dir, "app.js")])
            if (existsSync(path)) age(path, minutes);
        age(join(clone, dir), minutes);
    }
}

function keep(box: Sandbox, args: string[], env: Record<string, string> = {}): KeepReport {
    const options = { env: { TOLI_DRY_RUN: "0", ...env } };
    return JSON.parse(box.ok(["disk", "keep", ...args, "--json"], options)) as KeepReport;
}

describe("the disk keeper's floor", () => {
    keeperTest("capacity.diskKeepGB above 15% of the disk is capped there, so a small disk is not emptied", () => {
        const box = keeperBox();
        const [alpha = ""] = clones(box, ["alpha"]);
        setCapacity(box, { diskKeepGB: 100 });
        box.stub("df", `kb=${30 * 1024 * 1024}\n${dfLine(117)}`);
        const report = keep(box, []);
        expect(report.floorGB).toBe(17.5);
        expect(report.floorNote).toBe("15% of 117.0 GB disk; capacity.diskKeepGB 100 is above it");
        expect(report.ran).toBe(false);
        expect(existsSync(join(alpha, "target", "debug", "deps", "libx.rlib"))).toBe(true);
        const text = box.ok(["disk", "keep"], { env: { TOLI_DRY_RUN: "0" } });
        expect(text).toContain("floor 17.5 GB (15% of 117.0 GB disk; capacity.diskKeepGB 100 is above it)");
    });

    keeperTest("under the floor it deletes idle folders oldest first and stops once free space is at the floor", () => {
        const box = keeperBox();
        const [alpha = "", beta = "", gamma = ""] = clones(box, ["alpha", "beta", "gamma"]);
        ageOutput(beta, 300);
        ageOutput(gamma, 200);
        ageOutput(alpha, 100);
        setCapacity(box, { diskKeepGB: 25 });
        // 10 GB free, plus 10 GB for each target deleted; a 1000 GB disk, so the floor stays 25.
        const targets = [alpha, beta, gamma].map((clone) => `"${join(clone, "target")}"`).join(" ");
        const gone = `n=0; for t in ${targets}; do [ -e "$t" ] || n=$((n + 1)); done`;
        box.stub("df", `${gone}; kb=$(( (10 + n * 10) * 1048576 ))\n${dfLine(1000)}`);
        const report = keep(box, []);
        const lines = report.lines.join("\n");
        expect(report.floorGB).toBe(25);
        expect(lines).toContain(`deleted ${join(beta, "target")}, freed `);
        expect(lines).toContain(`deleted ${join(gamma, "target")}, freed `);
        const deleted = (clone: string): number => lines.indexOf(`deleted ${join(clone, "target")}`);
        expect(deleted(beta)).toBeLessThan(deleted(gamma));
        expect(existsSync(join(alpha, "target", "debug", "deps", "libx.rlib"))).toBe(true);
        expect(existsSync(join(alpha, "web", "dist", "app.js"))).toBe(true);
        expect(report.freeAfterGB).toBe(30);
    });
});

describe("the disk keeper on Linux, without lsof", () => {
    keeperTest("never deletes a folder a process works in, holds a file of, or a build holds the lock of", () => {
        const box = keeperBox();
        const [alpha = "", beta = "", gamma = ""] = clones(box, ["alpha", "beta", "gamma"]);
        for (const clone of [alpha, beta]) ageOutput(clone, 600);
        ageOutput(gamma, 10);
        // /proc as lsof would read it: pid 4201 works in alpha, pid 4202 holds a file of beta's dist open.
        const proc = tempDir("proc");
        mkdirSync(join(proc, "4201"));
        symlinkSync(join(alpha, "web"), join(proc, "4201", "cwd"));
        mkdirSync(join(proc, "4202", "fd"), { recursive: true });
        symlinkSync(join(beta, "web", "dist", "app.js"), join(proc, "4202", "fd", "5"));
        symlinkSync("socket:[81234]", join(proc, "4202", "fd", "6"));
        writeFileSync(join(proc, "4202", "maps"), "");
        // 1 GB free until gamma's dist goes (the last idle folder), 100 GB after: floor 50.
        const dist = join(gamma, "web", "dist");
        box.stub("df", `if [ -e "${dist}" ]; then kb=1048576; else kb=104857600; fi\n${dfLine(200)}`);
        const lock = join(beta, "target", "debug", ".cargo-lock");
        const release = holdLock(lock);
        try {
            const report = keep(box, ["--floor", "50"], { TOLI_PLATFORM: "linux", TOLI_PROC_DIR: proc });
            const lines = report.lines.join("\n");
            expect(report.lastResort).toBe(false);
            expect(lines).toContain(`skipped ${join(alpha, "target")}: process 4201 runs in ${join(alpha, "web")}`);
            expect(lines).toContain(`kept ${join(beta, "target")}: a build holds ${lock}`);
            expect(lines).toContain(
                `kept ${join(beta, "web", "dist")}: open files, e.g. ${join(beta, "web", "dist", "app.js")} (pid 4202)`,
            );
            expect(lines).toContain(`deleted ${join(gamma, "web", "dist")}, freed `);
            for (const kept of ["target/debug/deps/libx.rlib", "web/dist/app.js"]) {
                expect(existsSync(join(alpha, kept))).toBe(true);
                expect(existsSync(join(beta, kept))).toBe(true);
            }
        } finally {
            release();
        }
    });
});

describe("the disk keeper's pause marker", () => {
    keeperTest("a marker older than 2 h is ignored though its pid lives, logged once; a fresh one still pauses", () => {
        const box = keeperBox();
        const [alpha = ""] = clones(box, ["alpha"]);
        const pause = join(box.root, "state", "disk-keep.pause");
        const diskLog = join(box.root, "logs", "disk.log");
        const plan = (): KeepReport => keep(box, ["--dry-run", "--floor", "1000000000"], { TOLI_DRY_RUN: "1" });
        writeFileSync(pause, `${process.pid}\nrelease gate\n`);
        age(pause, 121);
        const expired = `pause by pid ${process.pid} expired after 2 h; cleaning resumed`;
        for (const _ of [1, 2]) {
            const report = plan();
            expect(report.ran).toBe(true);
            expect(report.pausedBy).toBeUndefined();
            expect(report.lines.join("\n")).toContain(`would delete ${join(alpha, "target")} (`);
        }
        const logged = readFileSync(diskLog, "utf8").split("\n");
        expect(logged.filter((line) => line.includes(expired))).toHaveLength(1);

        writeFileSync(pause, `${process.pid}\nrelease gate\n`);
        const report = plan();
        expect(report.ran).toBe(false);
        expect(report.pausedBy).toBe(process.pid);
    });
});

describe("the disk keeper in the minute tick", () => {
    keeperTest("the tick leaves the keeping to a detached keeper, so a slow keeper step never holds it up", () => {
        const box = keeperBox();
        const [alpha = ""] = clones(box, ["alpha"]);
        setCapacity(box, { diskKeepGB: 20 });
        // 1 GB free on a 1000 GB disk, under the floor (20) and the emergency level, and a keeper step that takes
        // 15 s, as every step does on an I/O-starved disk.
        box.stub("df", `kb=1048576\n${dfLine(1000)}`);
        box.stub("docker", "sleep 15; exit 1");
        const env = { TOLI_DRY_RUN: "0" };
        const started = Date.now();
        box.ok(["job", "tick"], { env });
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(readFileSync(join(box.root, "logs", "tick.log"), "utf8")).toContain(
            "disk keeper: free 1.0 GB < floor 20.0 GB: started in the background",
        );
        // The detached keeper does the work the tick did not wait for, with the same rules.
        const log = join(box.root, "logs", "disk.log");
        const deadline = Date.now() + 90_000;
        const finished = (): boolean => existsSync(log) && readFileSync(log, "utf8").includes("done, still under");
        while (!finished() && Date.now() < deadline) Bun.sleepSync(200);
        expect(finished()).toBe(true);
        expect(existsSync(join(alpha, "target"))).toBe(false);
        expect(existsSync(join(alpha, "web", "node_modules", "pkg", "index.js"))).toBe(true);
    });
});

describe("the disk keeper switched off (capacity.diskKeep false)", () => {
    keeperTest("a jawan start and a tick under the floor delete nothing and alert the inbox once per 6 h", () => {
        const box = keeperBox();
        const [alpha = ""] = clones(box, ["alpha"]);
        setCapacity(box, { diskKeepGB: 20, diskKeep: false });
        // 1 GB free on a 1000 GB disk: under the floor (20), the emergency level and the alert level.
        box.stub("df", `kb=1048576\n${dfLine(1000)}`);
        box.stub("omp", "true");
        const env = { TOLI_DRY_RUN: "0" };
        const alerts = (): string[] =>
            (JSON.parse(box.ok(["inbox", "list", "--json"])) as { title: string }[])
                .map((item) => item.title)
                .filter((title) => title.startsWith("disk low on m1"));
        const kept = (): void => {
            expect(existsSync(join(alpha, "target", "debug", "deps", "libx.rlib"))).toBe(true);
            expect(existsSync(join(alpha, "web", "dist", "app.js"))).toBe(true);
        };
        const briefPath = join(box.root, "brief.md");
        writeFileSync(briefPath, "TOLI_BRIEF v1\nsay hi\n");
        box.ok(["spawn", "--brief", briefPath, "--cwd", box.root, "--json"], { env });
        kept();
        expect(alerts()).toEqual(["disk low on m1: 1.0 GB free"]);
        const alert = box.ok(["inbox", "list"]);
        const item = alert.split("\n").find((line) => line.includes("disk low on m1")) ?? "";
        const body = readFileSync(item.split("\t").at(-1) ?? "", "utf8");
        expect(body).toContain(join(alpha, "target"));
        expect(body).toContain("capacity.diskKeep is false, so toli deletes nothing on its own");

        // Within 6 h of that alert the tick posts no other, and starts no keeper.
        box.ok(["job", "tick"], { env });
        expect(alerts()).toHaveLength(1);
        // Past the 6 h, the tick alerts again (from a detached `disk alert`), still deleting nothing.
        const later = new Date(Date.now() + 7 * 60 * 60_000).toISOString();
        box.ok(["job", "tick"], { env, now: later });
        expect(readFileSync(join(box.root, "logs", "tick.log"), "utf8")).toContain(
            "disk keeper off (capacity.diskKeep false): free 1.0 GB < 20.0 GB: alerting the inbox in the background",
        );
        const deadline = Date.now() + 60_000;
        while (alerts().length < 2 && Date.now() < deadline) Bun.sleepSync(200);
        expect(alerts()).toHaveLength(2);
        kept();
        const diskLog = join(box.root, "logs", "disk.log");
        expect(existsSync(diskLog) ? readFileSync(diskLog, "utf8") : "").not.toContain("deleted");

        // By hand the keeper still runs, and says automatic deletion is off.
        expect(box.ok(["disk", "keep", "--dry-run"], { env })).toContain(
            "automatic deletion: off (capacity.diskKeep false)",
        );
    });
});

describe("the disk keeper in process", () => {
    keeperTest("a pause, then a live keeper, holds it off; each reason is logged once", () => {
        const box = keeperBox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        mkdirSync(join(box.root, "state"), { recursive: true });
        const keep = (floorGB: number): KeepReport => {
            let report: KeepReport | undefined;
            inProcess(box.root, () => {
                report = keepDisk({ floorGB });
            });
            if (report === undefined) throw new Error("keepDisk returned nothing");
            return report;
        };
        expect(keep(0)).toMatchObject({ ran: false, floorGB: 0, lines: [] });
        writeFileSync(join(box.root, "state", "disk-keep.pause"), `${process.pid} rebuilding the docs\n`);
        for (const _ of [1, 2]) {
            const report = keep(1_000_000_000);
            expect(report).toMatchObject({ ran: false, pausedBy: process.pid, dryRun: false, lastResort: false });
            expect(floorText(report)).toBe("floor 1000000000.0 GB");
            expect(report.lines).toEqual([
                `free ${report.freeBeforeGB.toFixed(1)} GB < floor 1000000000.0 GB: paused by pid ${process.pid} (rebuilding the docs) (state/disk-keep.pause)`,
            ]);
        }
        rmSync(join(box.root, "state", "disk-keep.pause"));
        writeFileSync(join(box.root, "state", "disk-keep.lock"), String(process.pid));
        for (const _ of [1, 2]) {
            const report = keep(1_000_000_000);
            expect(report.pausedBy).toBeUndefined();
            expect(report.lines.join("\n")).toContain(`another disk keeper (pid ${process.pid}) is already running`);
        }
        const log = readFileSync(join(box.root, "logs", "disk.log"), "utf8").split("\n");
        expect(log.filter((line) => line.includes("paused by pid"))).toHaveLength(1);
        expect(log.filter((line) => line.includes("already running"))).toHaveLength(1);
        expect(readFileSync(join(box.root, "state", "disk-keep.skip"), "utf8")).toBe(`keeper ${process.pid}`);
    });
});
