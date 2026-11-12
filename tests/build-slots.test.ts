import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Machine } from "../src/core/config.ts";
import { paths } from "../src/core/paths.ts";
import { buildMemoryMaxMB } from "../src/fleet/build-slots.ts";
import { capacityFor, type Resources } from "../src/fleet/resources.ts";
import { jawanEnv } from "../src/jawans/env.ts";
import { buildScopeArgv, buildScopeUnit, inToliBuildCgroup } from "../src/jawans/scope.ts";
import {
    CARGO_SHIM,
    holdSlot,
    noBusSystemdRun,
    type Run,
    runs,
    scopeBox,
    scopeLines,
    slotBox,
    start,
    TERMINAL_CGROUP,
    toliArgs,
    until,
} from "./build-slot-fixture.ts";

const machine = { name: "m1", role: "coordinator" as const };

describe("build slot capacity", () => {
    test("slots default to one per six cores, each with an even share of the cores as cargo jobs", () => {
        expect(capacityFor(machine, 18)).toMatchObject({ buildSlots: 3, cargoJobs: 6 });
        expect(capacityFor(machine, 4)).toMatchObject({ buildSlots: 1, cargoJobs: 4 });
        expect(capacityFor(machine, 1)).toMatchObject({ buildSlots: 1, cargoJobs: 1 });
    });

    test("explicit buildSlots and cargoJobs override the defaults", () => {
        expect(capacityFor({ ...machine, capacity: { buildSlots: 2 } }, 18)).toMatchObject({
            buildSlots: 2,
            cargoJobs: 9,
        });
        expect(capacityFor({ ...machine, capacity: { cargoJobs: 4 } }, 18)).toMatchObject({
            buildSlots: 3,
            cargoJobs: 4,
        });
        expect(() => capacityFor({ ...machine, capacity: { buildSlots: 0 } }, 8)).toThrow("positive integer");
        expect(() => capacityFor({ ...machine, capacity: { buildSlots: 1.5 } }, 8)).toThrow("positive integer");
    });

    test("a jawan's PATH starts with the cargo shim and its cargo jobs are one slot's share", () => {
        const shims = paths.buildShimsDir();
        const jobs = capacityFor(machine, 18).cargoJobs;
        const env = jawanEnv({ PATH: "/usr/bin:/bin", TOLI_BUILD_SLOT: "2" }, "r1", jobs);
        expect(env.PATH).toBe(`${shims}:/usr/bin:/bin`);
        expect(env.CARGO_BUILD_JOBS).toBe("6");
        expect(env.TOLI_BUILD_SLOT).toBeUndefined();
        expect(jawanEnv({ PATH: `/bin:${shims}` }, "r2", 6).PATH).toBe(`${shims}:/bin`);
        expect(existsSync(join(shims, "cargo"))).toBe(true);
    });

    test("a live-stack project's jawan runs without the shim, its cargo jobs still capped", () => {
        const shims = paths.buildShimsDir();
        const env = jawanEnv({ PATH: `${shims}:/usr/bin`, TOLI_BUILD_SLOT: "1" }, "r1", 6, true);
        expect(env.PATH).toBe("/usr/bin");
        expect(env.CARGO_BUILD_JOBS).toBe("6");
        expect(env.TOLI_BUILD_SLOT).toBeUndefined();
    });
});

describe("jawan environment", () => {
    test("builds into the checkout's own build folder, capped at the machine's cargo jobs, through toli's rustc wrapper", () => {
        const env = jawanEnv(
            {
                PATH: "/bin",
                CARGO_HOME: "/nonexistent-cargo-home",
                CARGO_TARGET_DIR: "/tmp/jawan-target",
                CLAUDECODE: "1",
                CLAUDE_CODE_ENTRYPOINT: "cli",
            },
            "r1",
            12,
        );
        expect(env).toEqual({
            PATH: `${paths.buildShimsDir()}:/bin`,
            CARGO_HOME: "/nonexistent-cargo-home",
            TOLI_ROLE: "jawan",
            TOLI_RUN_ID: "r1",
            CARGO_BUILD_JOBS: "12",
            RUSTC_WRAPPER: join(paths.buildShimsDir(), "toli-rustc-wrapper"),
            TOLI_RUSTC_WRAPPER_NEXT: "",
        });
    });

    test("the machine's cargo jobs replace an inherited build-jobs value", () => {
        expect(jawanEnv({ CARGO_BUILD_JOBS: "18" }, "r1", 12).CARGO_BUILD_JOBS).toBe("12");
    });
});

describe("build slots", () => {
    test("with one slot, two heavy builds take turns instead of overlapping", async () => {
        const { box, log } = slotBox(1, 3);
        const first = await holdSlot(box, log);
        const second = start(box, [CARGO_SHIM, "test", "--workspace"], { STUB_LABEL: "b" });
        await until("the waiting message", () => second.stderr.join("").includes("waiting for a heavy-build slot"));
        expect(runs(log).some((run) => run.label === "b")).toBe(false);
        writeFileSync(`${log}.done-a`, "");
        const [one, two] = await Promise.all([first.done, second.done]);
        expect([one.code, two.code]).toEqual([0, 0]);
        const [a, b] = runs(log);
        expect(a).toMatchObject({ label: "a", slot: "1", jobs: "3", args: "build" });
        expect(b).toMatchObject({ label: "b", slot: "1", jobs: "3", args: "test --workspace" });
        expect((b as Run).start).toBeGreaterThanOrEqual((a as Run).end);
        expect(two.stderr.match(/waiting for a heavy-build slot \(1 busy\)/g)).toHaveLength(1);
        expect(one.stderr).not.toContain("waiting");
    }, 30_000);

    test("a nested heavy build inside a slot never waits on it", async () => {
        const { box, log } = slotBox(1, 3);
        const holder = await holdSlot(box, log);
        const nested = start(box, [CARGO_SHIM, "build"], { STUB_LABEL: "b", TOLI_BUILD_SLOT: "1" });
        const viaToli = start(box, toliArgs("build-slot", "--", "cargo", "check"), {
            STUB_LABEL: "c",
            TOLI_BUILD_SLOT: "1",
        });
        const [shimmed, direct] = await Promise.all([nested.done, viaToli.done]);
        holder.proc.kill("SIGKILL");
        expect([shimmed.code, direct.code]).toEqual([0, 0]);
        expect(shimmed.stderr + direct.stderr).not.toContain("waiting");
        expect(runs(log).find((run) => run.label === "b")).toMatchObject({ slot: "1", args: "build" });
        expect(runs(log).find((run) => run.label === "c")).toMatchObject({ slot: "1", args: "check" });
    }, 30_000);

    test("light cargo commands pass straight through while every slot is busy", async () => {
        const { box, log } = slotBox(1, 3);
        const holder = await holdSlot(box, log);
        const version = start(box, [CARGO_SHIM, "--version"], { STUB_LABEL: "v" });
        const metadata = start(box, [CARGO_SHIM, "metadata", "--format-version", "1"], { STUB_LABEL: "m" });
        const [v, m] = await Promise.all([version.done, metadata.done]);
        holder.proc.kill("SIGKILL");
        expect([v.code, m.code]).toEqual([0, 0]);
        expect(v.stderr + m.stderr).not.toContain("waiting");
        expect(runs(log).find((run) => run.label === "v")).toMatchObject({ slot: "none", args: "--version" });
        expect(runs(log).find((run) => run.label === "m")).toMatchObject({ slot: "none" });
    }, 30_000);

    test("two copies of the shim on PATH find the real cargo instead of each other", async () => {
        const { box, log } = slotBox(1, 3);
        const copy = join(box.root, ".other-shims");
        mkdirSync(copy);
        copyFileSync(CARGO_SHIM, join(copy, "cargo"));
        chmodSync(join(copy, "cargo"), 0o755);
        const path = [copy, paths.buildShimsDir(), box.stubs, dirname(process.execPath), "/usr/bin", "/bin"];
        const version = start(box, [join(copy, "cargo"), "--version"], { STUB_LABEL: "v", PATH: path.join(":") });
        const result = await version.done;
        expect(result.code).toBe(0);
        expect(runs(log).find((run) => run.label === "v")).toMatchObject({ slot: "none", args: "--version" });
    }, 30_000);

    test("a killed holder frees its slot, and resources shows slots busy of total", async () => {
        const { box, log } = slotBox(1, 3);
        const holder = await holdSlot(box, log);
        const busy = JSON.parse(box.ok(["resources", "--json"])) as Resources;
        expect(busy).toMatchObject({ buildSlots: 1, buildSlotsBusy: 1 });
        expect(box.ok(["resources"])).toContain("builds 1/1");
        const waiter = start(box, [CARGO_SHIM, "build"], { STUB_LABEL: "b" });
        await until("the waiting message", () => waiter.stderr.join("").includes("waiting for a heavy-build slot"));
        expect(runs(log).some((run) => run.label === "b")).toBe(false);
        holder.proc.kill("SIGKILL");
        const result = await waiter.done;
        expect(result.code).toBe(0);
        expect(runs(log).find((run) => run.label === "b")).toMatchObject({ slot: "1" });
        expect(JSON.parse(box.ok(["resources", "--json"]))).toMatchObject({ buildSlotsBusy: 0 });
    }, 30_000);
});

describe("each heavy build in its own systemd scope", () => {
    test("the scope argv: its unit, the memory cap (MemoryHigh below MemoryMax, no swap; none at 0), then the command", () => {
        expect(buildScopeUnit(2, 4242)).toBe("toli-build-2-4242.scope");
        expect(buildScopeArgv("/usr/bin/systemd-run", "toli-build-2-4242.scope", 4096, ["/bin/cargo", "-v"])).toEqual([
            "/usr/bin/systemd-run",
            "--user",
            "--scope",
            "--collect",
            "--quiet",
            "--unit=toli-build-2-4242.scope",
            "-p",
            "MemoryHigh=3686M",
            "-p",
            "MemoryMax=4096M",
            "-p",
            "MemorySwapMax=0",
            "--",
            "/bin/cargo",
            "-v",
        ]);
        expect(buildScopeArgv("systemd-run", "toli-build-0-7.scope", 0, ["make"])).toEqual([
            "systemd-run",
            "--user",
            "--scope",
            "--collect",
            "--quiet",
            "--unit=toli-build-0-7.scope",
            "--",
            "make",
        ]);
    });

    test("the memory cap defaults to three quarters of the RAM split over the slots; 0 means no cap", () => {
        expect(buildMemoryMaxMB(machine, 3, 65_536)).toBe(16_384);
        expect(buildMemoryMaxMB(machine, 1, 16_000)).toBe(12_000);
        expect(buildMemoryMaxMB({ ...machine, capacity: { buildMemoryMax: 8192 } }, 3, 65_536)).toBe(8192);
        expect(buildMemoryMaxMB({ ...machine, capacity: { buildMemoryMax: 0 } }, 3, 65_536)).toBe(0);
        // config/machine.json as read from disk: any JSON value may sit where a number belongs.
        for (const bad of ["-1", "1.5", '"8G"']) {
            const read = JSON.parse(
                `{ "name": "m1", "role": "coordinator", "capacity": { "buildMemoryMax": ${bad} } }`,
            );
            expect(() => buildMemoryMaxMB(read as Machine, 3, 65_536)).toThrow("non-negative integer");
        }
    });

    test("a process already inside a toli build scope is recognised from its cgroup", () => {
        const slice = "0::/user.slice/user-1000.slice/user@1000.service/app.slice";
        expect(inToliBuildCgroup(`${slice}/toli-build-1-4242.scope\n`)).toBe(true);
        expect(inToliBuildCgroup(`${slice}/toli-build-0-7.scope/child\n`)).toBe(true);
        expect(inToliBuildCgroup(`${slice}/toli-jawan-r1.scope\n`)).toBe(false);
        expect(inToliBuildCgroup(`${slice}/vte-spawn-1234.scope\n`)).toBe(false);
        expect(inToliBuildCgroup("")).toBe(false);
    });

    test("build-slot and the cargo shim run the build in toli-build-<slot>-<pid> capped at buildMemoryMax", async () => {
        const { box, log, scopeLog, env } = scopeBox(TERMINAL_CGROUP);
        const direct = await start(box, toliArgs("build-slot", "--", "cargo", "build"), { ...env, STUB_LABEL: "a" })
            .done;
        const shimmed = await start(box, [CARGO_SHIM, "test", "-q"], { ...env, STUB_LABEL: "b" }).done;
        expect([direct.code, shimmed.code]).toEqual([0, 0]);
        const [first, second] = scopeLines(scopeLog);
        // Inside the scope /bin/sh marks that the scope was made (state/build-slots/scope-<pid>.started), then execs
        // the build.
        const marker = `/bin/sh -c : > "$0" && exec "$@" ${join(box.root, "state", "build-slots")}/scope-`;
        const prefix =
            /^--user --scope --collect --quiet --unit=toli-build-1-(\d+)\.scope -p MemoryHigh=460M -p MemoryMax=512M -p MemorySwapMax=0 -- /;
        // build-slot resolves `cargo` on PATH (the shim, first there); the shim passes the real cargo.
        for (const [line, build] of [
            [first, `${join(paths.buildShimsDir(), "cargo")} build`],
            [second, `${join(box.stubs, "cargo")} test -q`],
        ]) {
            const pid = prefix.exec(line ?? "")?.[1];
            expect(pid).toBeDefined();
            expect(line).toEndWith(`-- ${marker}${pid}.started ${build}`);
        }
        expect(
            existsSync(join(box.root, "state", "build-slots", `scope-${prefix.exec(first ?? "")?.[1]}.started`)),
        ).toBe(false);
        expect(runs(log).find((run) => run.label === "a")).toMatchObject({ slot: "1", jobs: "3", args: "build" });
        expect(runs(log).find((run) => run.label === "b")).toMatchObject({ slot: "1", args: "test -q" });
    }, 30_000);

    test("a failing or killed build in its scope reports as it would outside one", async () => {
        const { box, scopeLog, env } = scopeBox(TERMINAL_CGROUP);
        const failed = await start(box, toliArgs("build-slot", "--", "sh", "-c", "exit 3"), env).done;
        const killed = await start(box, toliArgs("build-slot", "--", "sh", "-c", "kill -TERM $$"), env).done;
        expect([failed.code, killed.code]).toEqual([3, 143]);
        expect(scopeLines(scopeLog)).toHaveLength(2);
    }, 30_000);

    test("a build whose scope systemd-run cannot make runs once without it, after one warning", async () => {
        const { box, log, scopeLog, env } = scopeBox(TERMINAL_CGROUP, noBusSystemdRun);
        const built = await start(box, toliArgs("build-slot", "--", "cargo", "build"), { ...env, STUB_LABEL: "a" })
            .done;
        expect(built.code).toBe(0);
        expect(scopeLines(scopeLog)).toHaveLength(1);
        expect(runs(log).map((run) => [run.label, run.slot, run.jobs, run.args])).toEqual([["a", "1", "3", "build"]]);
        const warnings = built.stderr.split("\n").filter((line) => line.includes("could not start the build's scope"));
        expect(warnings).toEqual([
            "toli: systemd-run could not start the build's scope (exit 1), running it without a memory cap",
        ]);

        // A build that fails runs once, unscoped after the failed scope as in a working one, with its own exit code.
        const counter = join(box.root, ".attempts");
        const failing = toliArgs("build-slot", "--", "sh", "-c", `echo x >> '${counter}'; exit 3`);
        const failed = await start(box, failing, env).done;
        expect(failed.code).toBe(3);
        expect(readFileSync(counter, "utf8")).toBe("x\n");
        const working = scopeBox(TERMINAL_CGROUP);
        const workingCounter = join(working.box.root, ".attempts");
        const inScope = toliArgs("build-slot", "--", "sh", "-c", `echo x >> '${workingCounter}'; exit 3`);
        const scopedFail = await start(working.box, inScope, working.env).done;
        expect(scopedFail.code).toBe(3);
        expect(readFileSync(workingCounter, "utf8")).toBe("x\n");
        expect(scopedFail.stderr).not.toContain("could not start");
        expect(scopeLines(working.scopeLog)).toHaveLength(1);
    }, 30_000);

    test("no scope inside a toli build scope, without a user manager, off Linux or with TOLI_BUILD_SCOPE=off", async () => {
        const nested = scopeBox("0::/user.slice/user-1000.slice/user@1000.service/app.slice/toli-build-1-9.scope\n");
        const inside = await start(nested.box, toliArgs("build-slot", "--", "sh", "-c", "exit 3"), nested.env).done;
        expect(inside.code).toBe(3);
        expect(scopeLines(nested.scopeLog)).toEqual([]);

        const { box, scopeLog, env } = scopeBox(TERMINAL_CGROUP);
        const noManager = { ...env, XDG_RUNTIME_DIR: join(box.root, ".no-manager") };
        for (const variant of [noManager, { ...env, TOLI_PLATFORM: "darwin" }, { ...env, TOLI_BUILD_SCOPE: "off" }]) {
            const result = await start(box, toliArgs("build-slot", "--", "sh", "-c", "exit 4"), variant).done;
            expect(result.code).toBe(4);
        }
        expect(scopeLines(scopeLog)).toEqual([]);
    }, 30_000);
});
