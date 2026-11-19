// The disk keeper and live builds (src/fleet/live-builds.ts): a target a running cargo or rustc, a held heavy-build
// slot or a running gate compiles into is never deleted, not even under the emergency level; a keeper still under the
// floor names each one it left.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { slotHolder } from "../src/fleet/build-queue.ts";
import type { KeepReport } from "../src/fleet/disk.ts";
import { type LiveBuild, liveBuildUse } from "../src/fleet/live-builds.ts";
import { slotBox, start, toliArgs, until } from "./build-slot-fixture.ts";
import { age, buildOutput, holdLock } from "./disk-fixture.ts";
import { type Sandbox, tempDir, withProject } from "./helpers.ts";

/** How long a keeper test may take on a loaded machine (tests/disk-fixture.ts keeperTest). */
const KEEPER_MS = 120_000;

/** Registered projects, each clone holding cargo-like build output aged `minutes` ago; returns the resolved clones. */
function clones(box: Sandbox, ages: Record<string, number>): string[] {
    box.stub("ps", "exit 0");
    box.stub("lsof", "exit 0");
    box.stub("docker", "exit 1");
    box.stub("sccache", "exit 2");
    return Object.entries(ages).map(([name, minutes]) => {
        const clone = realpathSync(withProject(box, name));
        buildOutput(box, clone);
        for (const dir of ["target/debug", "target", "web/dist", "web/node_modules"]) age(join(clone, dir), minutes);
        return clone;
    });
}

/** A fake /proc whose one process, a cargo (pid 4301), works in `cwd` and was told CARGO_TARGET_DIR=`targetDir`. */
function cargoProc(cwd: string, targetDir: string): string {
    const proc = tempDir("proc");
    mkdirSync(join(proc, "4301"));
    writeFileSync(join(proc, "4301", "comm"), "cargo\n");
    writeFileSync(join(proc, "4301", "environ"), `HOME=/home/x\0CARGO_TARGET_DIR=${targetDir}\0PATH=/usr/bin\0`);
    writeFileSync(join(proc, "4301", "maps"), "");
    symlinkSync(cwd, join(proc, "4301", "cwd"));
    return proc;
}

/** A `df` stub: 1 GB free on a 200 GB disk (floor 50, emergency level 6) until every one of `gone` is gone. */
function freeOnceGone(box: Sandbox, gone: string[], afterGB: number): void {
    const present = gone.map((path) => `[ -e "${path}" ]`).join(" || ");
    box.stub(
        "df",
        `if ${present}; then kb=1048576; else kb=${afterGB * 1048576}; fi
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/x 209715200 1 %s 50%% /\\n' "$kb"`,
    );
}

function keep(box: Sandbox, proc: string): { report: KeepReport; lines: string } {
    const env = { TOLI_DRY_RUN: "0", TOLI_PLATFORM: "linux", TOLI_PROC_DIR: proc };
    const report = JSON.parse(box.ok(["disk", "keep", "--floor", "50", "--json"], { env })) as KeepReport;
    return { report, lines: report.lines.join("\n") };
}

const rlib = (clone: string): string => join(clone, "target", "debug", "deps", "libx.rlib");

describe("a live build's target", () => {
    test("is the one it was told by CARGO_TARGET_DIR, else its workspace's, never one beside it", () => {
        const root = realpathSync(tempDir("builds"));
        const backend = join(root, "apps", "backend");
        const target = join(backend, "target");
        mkdirSync(target, { recursive: true });
        const cargo = (cwd: string | null, targetDir: string | null = null): LiveBuild[] => [
            { label: "cargo (pid 7)", cwd, targetDir, args: [] },
        ];
        expect(liveBuildUse(target, cargo(join(backend, "src")))).toBe(
            `cargo (pid 7) builds in ${join(backend, "src")}`,
        );
        expect(liveBuildUse(target, cargo(root))).toBe(`cargo (pid 7) builds in ${root}`);
        expect(liveBuildUse(target, cargo(join(root, "apps", "frontend")))).toBeNull();
        expect(liveBuildUse(target, cargo(homedir()))).toBeNull();
        expect(liveBuildUse(target, cargo(null))).toBeNull();
        expect(liveBuildUse(target, cargo("/elsewhere", target))).toBe(
            `cargo (pid 7) builds into it (CARGO_TARGET_DIR ${target})`,
        );
        expect(liveBuildUse(target, cargo(backend, join(root, "other-target")))).toBeNull();
        expect(slotHolder(backend, { CARGO_TARGET_DIR: "../shared" })).toEqual({
            cwd: backend,
            targetDir: join(root, "apps", "shared"),
        });
        expect(slotHolder(backend, {})).toEqual({ cwd: backend, targetDir: null });
    });
});

describe("the disk keeper beside live builds", () => {
    test(
        "over the emergency level it keeps a target a cargo elsewhere or a held build slot builds into, and deletes an idle one",
        async () => {
            const { box, log } = slotBox(1, 2);
            const [alpha = "", beta = "", gamma = ""] = clones(box, { alpha: 600, beta: 500, gamma: 400 });
            // 1 GB free until gamma's target is gone, then 20 GB: under the floor (50), over the emergency level (6).
            freeOnceGone(box, [join(gamma, "target")], 20);
            const proc = cargoProc(realpathSync(tempDir("elsewhere")), join(alpha, "target"));
            const holder = start(box, toliArgs("build-slot", "--", "cargo", "build"), { STUB_SLEEP: "300" }, beta);
            try {
                await until("the slot's build running", () => existsSync(log), KEEPER_MS);
                const { report, lines } = keep(box, proc);
                expect(report.lastResort).toBe(false);
                expect(lines).toContain(
                    `kept ${join(alpha, "target")}: cargo (pid 4301) builds into it (CARGO_TARGET_DIR ${join(alpha, "target")})`,
                );
                expect(lines).toContain(
                    `kept ${join(beta, "target")}: heavy-build slot 1 (pid ${holder.proc.pid}) builds in ${beta}`,
                );
                expect(lines).toContain(`deleted ${join(gamma, "target")}, freed `);
                expect(lines).not.toContain("deleting it anyway");
                expect(existsSync(rlib(alpha))).toBe(true);
                expect(existsSync(rlib(beta))).toBe(true);
                expect(existsSync(join(gamma, "target"))).toBe(false);
            } finally {
                writeFileSync(`${log}.done-x`, "");
                await holder.done;
            }
        },
        KEEPER_MS,
    );

    /**
     * Under the emergency level: alpha's target, the oldest, has a live cargo; gamma's is held by cargo's lock only;
     * beta's is idle. Free disk stays at 1 GB until beta's and gamma's targets are gone, and alpha's too when
     * `alphaToo`.
     */
    function emergency(alphaToo: boolean): {
        alpha: string;
        beta: string;
        gamma: string;
        result: { report: KeepReport; lines: string };
    } {
        const { box } = slotBox(1, 2);
        const [alpha = "", beta = "", gamma = ""] = clones(box, { alpha: 600, beta: 100, gamma: 300 });
        const gone = [beta, gamma, ...(alphaToo ? [alpha] : [])].map((clone) => join(clone, "target"));
        freeOnceGone(box, gone, 100);
        const proc = cargoProc(realpathSync(tempDir("elsewhere")), join(alpha, "target"));
        const release = holdLock(join(gamma, "target", "debug", ".cargo-lock"));
        try {
            return { alpha, beta, gamma, result: keep(box, proc) };
        } finally {
            release();
        }
    }

    test(
        "under the emergency level it deletes an idle target, never one a live build compiles into or cargo's lock holds",
        () => {
            const { alpha, beta, gamma, result } = emergency(false);
            expect(result.report.lastResort).toBe(true);
            expect(result.lines).toContain(`deleted ${join(beta, "target")}, freed `);
            expect(result.lines).not.toContain(`deleted ${join(gamma, "target")}`);
            expect(result.lines).not.toContain("that build fails");
            expect(existsSync(rlib(alpha))).toBe(true);
            expect(existsSync(rlib(gamma))).toBe(true);
        },
        KEEPER_MS,
    );

    test(
        "under the emergency level it never deletes a target in use, names each when still under the floor and pauses new jobs",
        () => {
            const { alpha, gamma, result } = emergency(true);
            const target = join(alpha, "target");
            const why = `cargo (pid 4301) builds into it (CARGO_TARGET_DIR ${target})`;
            const lock = join(gamma, "target", "debug", ".cargo-lock");
            expect(result.report.lastResort).toBe(true);
            expect(result.lines).toContain(`kept ${target}: ${why}`);
            expect(result.lines).not.toContain(`deleted ${join(gamma, "target")}`);
            expect(result.lines).not.toContain("deleting it anyway");
            expect(result.lines).toContain(`left in use: ${target} (${why})`);
            expect(result.report.inUseLeft).toEqual([
                { path: target, reason: why },
                { path: join(gamma, "target"), reason: `a build holds ${lock}` },
            ]);
            expect(result.report.jobsPaused).toBe(true);
            expect(existsSync(rlib(alpha))).toBe(true);
        },
        KEEPER_MS,
    );

    test(
        "under the emergency level a held build slot, a running gate or a rustc naming the target keeps that clone's target (T1811)",
        async () => {
            const { box, log } = slotBox(1, 2);
            const [alpha = "", beta = "", gamma = "", delta = ""] = clones(box, {
                alpha: 600,
                beta: 500,
                gamma: 400,
                delta: 300,
            });
            const targets = [alpha, beta, gamma, delta].map((clone) => join(clone, "target"));
            // 1 GB free whatever goes: under the emergency level (6) to the end.
            freeOnceGone(box, targets, 100);
            // A push gate running in beta: its runner (this test) is alive.
            const gates = join(box.root, "state", "gates", "beta");
            mkdirSync(gates, { recursive: true });
            const record = { project: "beta", sha: "a".repeat(40), tree: "b".repeat(40), recipe: "just test" };
            const running = { ...record, dir: beta, status: "running", pid: process.pid, startedAt: "", endedAt: null };
            writeFileSync(join(gates, `${"b".repeat(40)}-0123456789abcdef.json`), JSON.stringify(running));
            // A rustc working elsewhere whose arguments write into delta's target.
            const proc = tempDir("proc");
            const deps = join(delta, "target", "debug", "deps");
            mkdirSync(join(proc, "4302"));
            writeFileSync(join(proc, "4302", "comm"), "rustc\n");
            writeFileSync(join(proc, "4302", "environ"), "HOME=/home/x\0");
            writeFileSync(join(proc, "4302", "cmdline"), `rustc\0--crate-name\0x\0--out-dir=${deps}\0`);
            writeFileSync(join(proc, "4302", "maps"), "");
            symlinkSync(realpathSync(tempDir("elsewhere")), join(proc, "4302", "cwd"));
            const holder = start(box, toliArgs("build-slot", "--", "cargo", "build"), { STUB_SLEEP: "300" }, alpha);
            try {
                await until("the slot's build running", () => existsSync(log), KEEPER_MS);
                const { report, lines } = keep(box, proc);
                expect(report.lastResort).toBe(true);
                expect(lines).toContain(`deleted ${join(gamma, "target")}, freed `);
                expect(lines).not.toContain("deleting it anyway");
                for (const clone of [alpha, beta, delta]) expect(existsSync(rlib(clone))).toBe(true);
                expect(report.inUseLeft).toEqual([
                    {
                        path: join(alpha, "target"),
                        reason: `heavy-build slot 1 (pid ${holder.proc.pid}) builds in ${alpha}`,
                    },
                    { path: join(beta, "target"), reason: `gate of beta (pid ${process.pid}) builds in ${beta}` },
                    { path: join(delta, "target"), reason: `rustc (pid 4302) builds with ${deps}` },
                    // The gate holds its whole checkout: beta's dist stays too (T2030).
                    { path: join(beta, "web", "dist"), reason: `a gate of beta (pid ${process.pid}) runs in it` },
                ]);
                expect(lines).toContain("done, still under the floor");
                expect(lines).toContain(`left in use: ${join(alpha, "target")} (heavy-build slot 1`);
            } finally {
                writeFileSync(`${log}.done-x`, "");
                await holder.done;
            }
        },
        KEEPER_MS,
    );
});
