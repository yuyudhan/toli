import { describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { wipeTargetBetweenBuilds } from "../src/fleet/cargo-lock.ts";
import type { HeldFile } from "../src/fleet/disk-scan.ts";
import type { ProcessUse, UseProbes } from "../src/fleet/target-use.ts";
import { libc } from "./disk-fixture.ts";
import { tempDir } from "./helpers.ts";

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
            builds: () => [],
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

    test("wipes an idle target though an unrelated process of the user cannot be inspected", () => {
        const { target } = workspaceTarget();
        const machine = quiet();
        // A non-dumpable service manager: neither lsof nor /proc shows its files or working directory.
        machine.processes.push({
            pid: "945",
            args: "/usr/lib/systemd/systemd --user",
            files: [],
            cwd: null,
            uninspected: true,
        });
        expect(wipeTargetBetweenBuilds(target, 0, undefined, probes(machine))).toEqual({ wiped: true });
        expect(existsSync(target)).toBe(false);
    });

    test("keeps the target while a process that cannot be inspected runs a program from it", () => {
        const { workspace, target } = workspaceTarget();
        const binary = join(target, "debug", "deps", "store-0123abcd");
        writeFileSync(binary, "");
        const machine = quiet();
        machine.processes.push({ pid: "4109", args: `${binary} --nocapture`, files: [], cwd: null, uninspected: true });
        const named = wipeTargetBetweenBuilds(target, 0, undefined, probes(machine));
        expect(named).toEqual({ wiped: false, reason: "process 4109 could not be inspected and may run from it" });
        // A relative program path runs from a working directory nobody could see.
        machine.processes.splice(0, 1, {
            pid: "4110",
            args: "./target/debug/store",
            files: [],
            cwd: null,
            uninspected: true,
        });
        const relative = wipeTargetBetweenBuilds(target, 0, undefined, probes(machine));
        expect(relative).toEqual({ wiped: false, reason: "process 4110 could not be inspected and may run from it" });
        expect(existsSync(binary)).toBe(true);
        expect(existsSync(workspace)).toBe(true);
    });
});
