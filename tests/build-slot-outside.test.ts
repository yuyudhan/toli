// Heavy builds that hold no slot still count against the machine's slots (T1477: on a Linux worker with one slot, a
// build that took its slot before `capacity.buildSlots` dropped to 1 went uncounted, so `resources` showed builds 1/1
// and a second build started beside it; a cargo run from a reset environment, the user's terminal or a container never
// reaches the shim or the rustc wrapper at all). src/fleet/build-queue.ts counts every held slot number and each heavy
// build outside the slots (src/fleet/outside-builds.ts) before it lets a waiter take a slot.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { outsideBuilds } from "../src/fleet/outside-builds.ts";
import type { Resources } from "../src/fleet/resources.ts";
import { holdSlot, type Run, runs, slotBox, start, toliArgs, until } from "./build-slot-fixture.ts";
import { tempDir } from "./helpers.ts";

/** A process table in `ps -o pid=,ppid=,stat=,args=` format. */
const table = (rows: [number, number, string, string][]): string =>
    rows.map(([pid, ppid, stat, args]) => `${pid} ${ppid} ${stat} ${args}\n`).join("");

/** A user's terminal build that bypassed every toli hook: bash, the real cargo, and two crates compiling. */
const TERMINAL_BUILD: [number, number, string, string][] = [
    [4000, 1, "Ss", "-bash"],
    [4100, 4000, "Sl+", "/home/u/.cargo/bin/cargo build --release"],
    [4101, 4100, "Rl+", "/home/u/.rustup/toolchains/stable/bin/rustc --crate-name app_store --edition=2021"],
    [4102, 4100, "Rl+", "/home/u/.rustup/toolchains/stable/bin/rustc --crate-name app_engine"],
];

const saved: Record<string, string | undefined> = {};
/** Set environment variables for this test only. */
function setEnv(values: Record<string, string>): void {
    for (const [key, value] of Object.entries(values)) {
        if (!(key in saved)) saved[key] = process.env[key];
        process.env[key] = value;
    }
}
afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
        delete saved[key];
    }
});

/** A table file holding `rows`, with /proc and cgroup roots of their own, set for this test. */
function useTable(rows: [number, number, string, string][]): { proc: string; cgroups: string } {
    const dir = tempDir("outside");
    const proc = join(dir, "proc");
    const cgroups = join(dir, "cgroup");
    mkdirSync(proc);
    mkdirSync(cgroups);
    writeFileSync(join(dir, "table"), table(rows));
    setEnv({ TOLI_PROCESS_TABLE: join(dir, "table"), TOLI_PROC_DIR: proc, TOLI_CGROUP_DIR: cgroups });
    return { proc, cgroups };
}

describe("heavy builds outside the slots", () => {
    test("one build per outermost cargo, with the crates it compiles and its directory", () => {
        const { proc } = useTable([
            ...TERMINAL_BUILD,
            // A build script's nested cargo belongs to the outer build.
            [4103, 4100, "S+", "/bin/sh target/release/build/x/build-script-build"],
            [4104, 4103, "S+", "cargo build -p helper"],
            [4105, 4104, "R+", "rustc --crate-name helper"],
            // Another user's cargo in a docker container, its rustc compiling through sccache.
            [5000, 1, "Sl", "/usr/bin/containerd-shim-runc-v2 -namespace moby"],
            [5001, 5000, "Sl", "cargo-nextest nextest run"],
            [5002, 5001, "Sl", "cargo test --no-run"],
            [5003, 5002, "Rl", "sccache /usr/local/rustup/toolchains/stable/bin/rustc --crate-name api_server"],
        ]);
        mkdirSync(join(proc, "4100"));
        symlinkSync("/work/app", join(proc, "4100", "cwd"));
        expect(outsideBuilds([])).toEqual([
            {
                pid: 4100,
                command: "/home/u/.cargo/bin/cargo build --release",
                cwd: "/work/app",
                crates: ["app_store", "app_engine", "helper"],
            },
            { pid: 5001, command: "cargo-nextest nextest run", cwd: null, crates: ["api_server"] },
        ]);
    });

    test("cargo's probes, builds under a slot holder, stopped and frozen builds and the waiter's own are left out", () => {
        const { proc, cgroups } = useTable([
            // Probes compile nothing: `rustc -vV` and the target-info probe's `___` crate.
            [6000, 1, "S", "cargo build"],
            [6001, 6000, "R", "rustc -vV"],
            [6002, 6000, "R", "rustc - --crate-name ___ --print=file-names"],
            // Under a slot holder (the pid in a slot's lock file, or a cargo a rustc-wrapper holder holds a slot for).
            [7000, 1, "S", "bun bin/toli build-slot -- cargo build"],
            [7001, 7000, "S", "cargo build"],
            [7002, 7001, "R", "rustc --crate-name in_slot"],
            // Stopped (SIGSTOP), and frozen with its paused container's cgroup.
            [8001, 1, "T", "cargo build"],
            [8002, 8001, "T", "rustc --crate-name stopped"],
            [8101, 1, "S", "cargo run --locked --bin app-server -- api"],
            [8102, 8101, "D", "rustc --crate-name frozen_v2"],
            [8201, 1, "S", "cargo build"],
            [8202, 8201, "S", "rustc --crate-name frozen_v1"],
            // The waiter runs inside this one (its build script's cargo waits for a slot).
            [9001, 1, "S", "cargo build"],
            [9002, 9001, "R", "rustc --crate-name waiter_parent"],
            [9003, 9001, "S", "/bin/sh build-script-build"],
            [9004, 9003, "S", "cargo build -p inner"],
        ]);
        mkdirSync(join(proc, "8102"));
        writeFileSync(join(proc, "8102", "cgroup"), "0::/system.slice/docker-abc.scope\n");
        mkdirSync(join(cgroups, "system.slice", "docker-abc.scope"), { recursive: true });
        writeFileSync(join(cgroups, "system.slice", "docker-abc.scope", "cgroup.events"), "populated 1\nfrozen 1\n");
        mkdirSync(join(proc, "8202"));
        writeFileSync(join(proc, "8202", "cgroup"), "4:freezer:/docker/def\n0::/\n");
        mkdirSync(join(cgroups, "freezer", "docker", "def"), { recursive: true });
        writeFileSync(join(cgroups, "freezer", "docker", "def", "freezer.state"), "FROZEN\n");
        expect(outsideBuilds([7000], 9004)).toEqual([]);
        // The same builds counted once nothing leaves them out: a thawed container's build is heavy again.
        writeFileSync(join(cgroups, "system.slice", "docker-abc.scope", "cgroup.events"), "populated 1\nfrozen 0\n");
        expect(outsideBuilds([7000], 9004).map((build) => build.pid)).toEqual([8101]);
        expect(outsideBuilds([], null).map((build) => build.pid)).toEqual([7001, 8101, 9001]);
    });
});

describe("a waiter counts every heavy build against the slots", () => {
    test("a build outside the slots holds up the next one until it ends, and resources lists it", async () => {
        const { box, log } = slotBox(1, 3);
        const tableFile = join(box.root, ".process-table");
        writeFileSync(tableFile, table(TERMINAL_BUILD));
        const busy = JSON.parse(box.ok(["resources", "--json"])) as Resources;
        expect(busy).toMatchObject({ buildSlots: 1, buildSlotsBusy: 1 });
        expect(busy.buildsOutsideSlots?.map((build) => build.pid)).toEqual([4100]);
        expect(box.ok(["resources"])).toContain(
            "builds 1/1, build outside the slots: pid 4100 `/home/u/.cargo/bin/cargo build --release` compiling",
        );
        const waiter = start(box, toliArgs("build-slot", "--", "cargo", "build"), { STUB_LABEL: "b" });
        await until("the outside build named", () =>
            waiter.stderr.join("").includes("outside the slots as busy: pid 4100"),
        );
        expect(runs(log).some((run) => run.label === "b")).toBe(false);
        writeFileSync(tableFile, "");
        const result = await waiter.done;
        expect(result.code).toBe(0);
        expect(runs(log).find((run) => run.label === "b")).toMatchObject({ slot: "1" });
    }, 30_000);

    test("a build that took its slot before buildSlots dropped still counts, so the next one waits for it", async () => {
        const { box, log } = slotBox(2, 3);
        const first = await holdSlot(box, log);
        const second = start(box, toliArgs("build-slot", "--", "cargo", "build"), {
            STUB_LABEL: "b",
            STUB_SLEEP: "150",
        });
        await until("the build in slot 2", () => runs(log).some((run) => run.label === "b"));
        expect(runs(log).find((run) => run.label === "b")).toMatchObject({ slot: "2" });
        writeFileSync(`${log}.done-a`, "");
        expect((await first.done).code).toBe(0);
        const config = join(box.root, "config", "machine.json");
        const parsed = JSON.parse(readFileSync(config, "utf8")) as { capacity: Record<string, number> };
        writeFileSync(config, JSON.stringify({ ...parsed, capacity: { ...parsed.capacity, buildSlots: 1 } }));
        expect(JSON.parse(box.ok(["resources", "--json"]))).toMatchObject({ buildSlots: 1, buildSlotsBusy: 1 });
        const third = start(box, toliArgs("build-slot", "--", "cargo", "build"), { STUB_LABEL: "c" });
        await until("the third build waiting", () => third.stderr.join("").includes("waiting for a heavy-build slot"));
        expect(runs(log).some((run) => run.label === "c")).toBe(false);
        writeFileSync(`${log}.done-b`, "");
        const [two, three] = await Promise.all([second.done, third.done]);
        expect([two.code, three.code]).toEqual([0, 0]);
        const b = runs(log).find((run) => run.label === "b") as Run;
        const c = runs(log).find((run) => run.label === "c") as Run;
        expect(c).toMatchObject({ slot: "1" });
        expect(c.start).toBeGreaterThanOrEqual(b.end);
    }, 30_000);
});
