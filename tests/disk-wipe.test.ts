import { describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { wipeNow, wipeTargetBetweenBuilds } from "../src/fleet/cargo-lock.ts";
import { containerMounts } from "../src/fleet/disk-proc.ts";
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

    test("wipes a target though omp's idle worker daemon works in its workspace, keeps it while cargo or rustc does", () => {
        const { workspace, target } = workspaceTarget();
        const crate = join(workspace, "crates", "store");
        mkdirSync(crate, { recursive: true });
        const machine = quiet();
        // omp's long-lived helper keeps the working directory it started in; it never builds there (T2547).
        const daemon = { pid: "4110", args: "/usr/local/bin/omp __omp_worker_daemon", files: ["/usr/local/bin/omp"] };
        machine.processes.push({ ...daemon, cwd: workspace });
        for (const [pid, args] of [
            ["4111", "cargo build -p store"],
            ["4112", "/opt/rust/bin/rustc --crate-name store src/lib.rs"],
        ] as const) {
            machine.processes.push({ pid, args, files: [], cwd: crate });
            const busy = wipeTargetBetweenBuilds(target, 0, undefined, probes(machine));
            expect(busy).toEqual({ wiped: false, reason: `process ${pid} runs in ${crate}` });
            expect(existsSync(target)).toBe(true);
            machine.processes.pop();
        }
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

    test("an uninspectable process working in / keeps no target, in the dry run's check as in the wipe", () => {
        const { target } = workspaceTarget();
        const machine = quiet();
        // systemd's PAM helper: /proc shows its working directory but not its executable.
        machine.processes.push({ pid: "965", args: "(sd-pam)", files: [], cwd: "/", uninspected: true });
        expect(wipeNow(target, true, undefined, probes(machine))).toBeNull();
        expect(existsSync(target)).toBe(true);
        expect(wipeNow(target, false, undefined, probes(machine))).toBeNull();
        expect(existsSync(target)).toBe(false);
    });

    test("the dry run's check keeps a target for the same reason the wipe does, deleting nothing", () => {
        const { workspace, target } = workspaceTarget();
        const machine = quiet();
        machine.processes.push(sleeping("4111", workspace));
        const reason = `process 4111 runs in ${workspace}`;
        expect(wipeNow(target, true, undefined, probes(machine))).toBe(reason);
        expect(wipeNow(target, false, undefined, probes(machine))).toBe(reason);
        expect(wipeNow(target, true, () => "paused", probes(machine))).toBe("paused");
        expect(wipeNow(target, false, () => "paused", probes(machine))).toBe("paused");
        expect(existsSync(target)).toBe(true);
    });

    test("keeps the target while a process that cannot be inspected runs a program from it", () => {
        const { workspace, target } = workspaceTarget();
        const binary = join(target, "debug", "deps", "store-0123abcd");
        writeFileSync(binary, "");
        const machine = quiet();
        machine.processes.push({ pid: "4109", args: `${binary} --nocapture`, files: [], cwd: null, uninspected: true });
        const named = wipeTargetBetweenBuilds(target, 0, undefined, probes(machine));
        expect(named).toEqual({ wiped: false, reason: "process 4109 could not be inspected and may run from it" });
        // A relative program path runs from a working directory nobody could see: it counts where the file is.
        writeFileSync(join(target, "debug", "store"), "");
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

    /** A project checkout whose `apps/backend/target/debug` holds the named binaries. */
    function backend(binaries: string[]): { root: string; target: string } {
        const root = realpathSync(tempDir("project"));
        const target = join(root, "apps", "backend", "target");
        mkdirSync(join(target, "debug", "deps"), { recursive: true });
        writeFileSync(join(target, "debug", ".cargo-lock"), "");
        for (const binary of binaries) writeFileSync(join(target, "debug", binary), "");
        return { root, target };
    }

    /** A dev server in a container: lsof and /proc cannot see its working directory or executable. */
    function devServer(args: string, mounts?: { at: string; host: string }[]): ProcessUse {
        const entry: ProcessUse = { pid: "3184633", args, files: [], cwd: null, uninspected: true };
        if (mounts !== undefined) entry.mounts = mounts;
        return entry;
    }

    const KEPT = { wiped: false, reason: "process 3184633 could not be inspected and may run from it" };

    test("a relative program an uninspected process runs keeps only the target that holds it", () => {
        const own = backend(["shop-backend"]);
        const other = backend(["ledger-backend"]);
        const machine = quiet();
        machine.processes.push(devServer("./target/debug/shop-backend"));
        expect(wipeTargetBetweenBuilds(other.target, 0, undefined, probes(machine))).toEqual({ wiped: true });
        expect(existsSync(other.target)).toBe(false);
        expect(wipeTargetBetweenBuilds(own.target, 0, undefined, probes(machine))).toEqual(KEPT);
        expect(existsSync(join(own.target, "debug", "shop-backend"))).toBe(true);
    });

    test("a program in a container keeps only the target its mounts show, by relative or container path", () => {
        // Both checkouts hold the binary; only one is mounted into the container.
        const own = backend(["shop-backend"]);
        const other = backend(["shop-backend"]);
        const mounts = [{ at: "/app", host: own.root }];
        for (const args of ["./target/debug/shop-backend", "/app/apps/backend/target/debug/shop-backend serve"]) {
            const machine = quiet();
            machine.processes.push(devServer(args, mounts));
            expect(wipeTargetBetweenBuilds(own.target, 0, undefined, probes(machine))).toEqual(KEPT);
            expect(existsSync(own.target)).toBe(true);
        }
        const machine = quiet();
        machine.processes.push(devServer("./target/debug/shop-backend", mounts));
        expect(wipeTargetBetweenBuilds(other.target, 0, undefined, probes(machine))).toEqual({ wiped: true });
        expect(existsSync(other.target)).toBe(false);
    });
});

describe("the mounts of a process in a container", () => {
    const ID = "3f".repeat(32);

    /** A /proc with pid 3184633 in cgroup `cgroup`, seeing `inside`, and this host's own mounts `host`. */
    function proc(cgroup: string, inside: string[], host: string[]): string {
        const dir = tempDir("proc");
        mkdirSync(join(dir, "3184633"));
        mkdirSync(join(dir, "self"));
        writeFileSync(join(dir, "3184633", "cgroup"), `${cgroup}\n`);
        writeFileSync(join(dir, "3184633", "mountinfo"), `${inside.join("\n")}\n`);
        writeFileSync(join(dir, "self", "mountinfo"), `${host.join("\n")}\n`);
        return dir;
    }

    function withProc<T>(dir: string, body: () => T): T {
        const saved = process.env.TOLI_PROC_DIR;
        process.env.TOLI_PROC_DIR = dir;
        try {
            return body();
        } finally {
            if (saved === undefined) delete process.env.TOLI_PROC_DIR;
            else process.env.TOLI_PROC_DIR = saved;
        }
    }

    const HOST = [
        "22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
        "40 22 8:2 / /home rw,relatime shared:2 - ext4 /dev/sda2 rw",
        "90 22 0:50 / /var/lib/docker/overlay2/abc/merged rw - overlay overlay rw",
    ];

    test("maps each bind mount to the host path of the same folder", () => {
        const dir = proc(
            `0::/system.slice/docker-${ID}.scope`,
            [
                "500 400 0:50 / / rw - overlay overlay rw",
                "501 500 8:2 /user/code/shop /app rw - ext4 /dev/sda2 rw",
                "502 500 8:1 /srv/my\\040data /data rw - ext4 /dev/sda1 rw",
                "503 500 0:77 / /proc rw - proc proc rw",
            ],
            HOST,
        );
        expect(withProc(dir, () => containerMounts("3184633"))).toEqual([
            { at: "/", host: "/var/lib/docker/overlay2/abc/merged" },
            { at: "/app", host: "/home/user/code/shop" },
            { at: "/data", host: "/srv/my data" },
        ]);
    });

    test("is null for a process outside a container or whose mounts cannot be read", () => {
        const host = proc("0::/user.slice/user-1000.slice/user@1000.service/init.scope", HOST, HOST);
        expect(withProc(host, () => containerMounts("3184633"))).toBeNull();
        expect(withProc(host, () => containerMounts("999"))).toBeNull();
    });
});
