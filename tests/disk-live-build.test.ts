// The disk keeper and live builds (src/fleet/live-builds.ts): over the emergency level a target a running cargo or a
// held heavy-build slot compiles into is never deleted; under it, such a target goes only after every other one, and
// the build it cuts off is named.
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
            { label: "cargo (pid 7)", cwd, targetDir },
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
        "under the emergency level it deletes every other target before one a live build compiles into",
        () => {
            const { alpha, beta, gamma, result } = emergency(false);
            expect(result.report.lastResort).toBe(true);
            expect(result.lines).toContain(`deleted ${join(beta, "target")}, freed `);
            expect(result.lines).toContain(`deleted ${join(gamma, "target")}, freed `);
            expect(result.lines).not.toContain("that build fails");
            expect(existsSync(rlib(alpha))).toBe(true);
        },
        KEEPER_MS,
    );

    test(
        "under the emergency level it still deletes a target a live build compiles into when nothing else frees enough, naming the build",
        () => {
            const { alpha, gamma, result } = emergency(true);
            const target = join(alpha, "target");
            const cut = `${target} is in use (cargo (pid 4301) builds into it (CARGO_TARGET_DIR ${target})): deleting it anyway; that build fails and must run again`;
            expect(result.report.lastResort).toBe(true);
            expect(result.lines).toContain(cut);
            const deleted = (clone: string): number => result.lines.indexOf(`deleted ${join(clone, "target")}, freed `);
            expect(deleted(gamma)).toBeGreaterThan(-1);
            expect(deleted(alpha)).toBeGreaterThan(deleted(gamma));
            expect(existsSync(target)).toBe(false);
        },
        KEEPER_MS,
    );
});
