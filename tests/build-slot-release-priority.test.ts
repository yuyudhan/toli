// Release priority (docs/fleet.md "Release priority"): while a `--work release` run of a project set
// `--release-priority yes` runs, heavy builds for other projects wait for it before taking a slot, however they reach
// the slots (the cargo shim, toli's rustc wrapper); the run's own builds and its project's builds never wait, and a run
// whose supervisor is gone holds nobody back.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JawanRun } from "../src/jawans/runs.ts";
import { CARGO_SHIM, runs, type Started, slotBox, start, toliArgs, until } from "./build-slot-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";

const WAITING = "waiting for rel's release run r-rel to end (release priority)";

/** A sandbox with two build slots, release-priority project `rel` and project `other`, and their clones. */
function priorityBox(): { box: Sandbox; log: string; rel: string; other: string } {
    const { box, log } = slotBox(2, 3);
    const rel = withProject(box, "rel");
    const other = withProject(box, "other");
    box.ok(["project", "set", "rel", "--release-priority", "yes"]);
    return { box, log, rel, other };
}

/** Record `rel`'s running release run `r-rel`, supervised by process `supervisorPid`. */
function releaseRun(box: Sandbox, cwd: string, supervisorPid: number): void {
    const run: JawanRun = {
        id: "r-rel",
        harness: "omp",
        task: "T1",
        project: "rel",
        work: "release",
        model: null,
        cwd,
        runDir: "",
        briefPath: "",
        logPath: "",
        command: "omp",
        maxMinutes: null,
        status: "running",
        supervisorPid,
        pid: supervisorPid,
        exitCode: null,
        signal: null,
        startedAt: new Date().toISOString(),
        endedAt: null,
        inbox: null,
        error: null,
    };
    const dir = join(box.root, "state", "jawans");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "r-rel.json"), JSON.stringify(run));
}

/** A live process standing for a release run's supervisor, until killed. */
const supervisor = (): Bun.Subprocess => Bun.spawn(["sleep", "120"], { stdin: "ignore", stdout: "ignore" });

const ran = (log: string, label: string): boolean => runs(log).some((run) => run.label === label);

describe("release priority", () => {
    test("another project's plain cargo waits for the release run; the run's and its project's builds go", async () => {
        const { box, log, rel, other } = priorityBox();
        const live = supervisor();
        releaseRun(box, rel, live.pid);
        const waiter = start(box, [CARGO_SHIM, "build"], { STUB_LABEL: "b" }, other);
        try {
            await until("the other project's build waiting", () => waiter.stderr.join("").includes(WAITING));
            const own = await start(box, [CARGO_SHIM, "build"], { STUB_LABEL: "a" }, rel).done;
            expect(own.code).toBe(0);
            expect(own.stderr).not.toContain("release run");
            const runsOwn = await start(box, [CARGO_SHIM, "test"], { STUB_LABEL: "r", TOLI_RUN_ID: "r-rel" }, other)
                .done;
            expect(runsOwn.code).toBe(0);
            expect(runsOwn.stderr).not.toContain("release run");
            expect(ran(log, "a") && ran(log, "r")).toBe(true);
            expect(ran(log, "b")).toBe(false);
            live.kill();
            const result = await waiter.done;
            expect(result.code).toBe(0);
            expect(result.stderr.split(WAITING).length).toBe(2);
            expect(runs(log).find((run) => run.label === "b")).toMatchObject({ args: "build", jobs: "3" });
        } finally {
            live.kill();
            waiter.proc.kill();
        }
    }, 60_000);

    test("a cargo reaching the slots through the rustc wrapper waits too", async () => {
        const { box, log, rel, other } = priorityBox();
        const live = supervisor();
        releaseRun(box, rel, live.pid);
        // A cargo that bypassed the shim, its `rustc -vV` probe calling `bin/toli build-slot --cargo <its pid>`.
        const cargo = start(box, [join(box.stubs, "cargo"), "build"], { STUB_LABEL: "c", STUB_SLEEP: "300" }, other);
        try {
            await until("the bypassing cargo runs", () => ran(log, "c"));
            const probe = start(box, toliArgs("build-slot", "--cargo", String(cargo.proc.pid)), {}, other);
            await until("the probe waiting", () => probe.stderr.join("").includes(WAITING));
            // The slot holder it started takes no slot while the run lasts: no held file for the cargo.
            expect(existsSync(join(box.root, "state", "build-slots", `cargo-${cargo.proc.pid}.held`))).toBe(false);
            expect(probe.proc.exitCode).toBeNull();
            live.kill();
            expect((await probe.done).code).toBe(0);
        } finally {
            live.kill();
            writeFileSync(`${log}.done-c`, "");
            await cargo.done;
        }
    }, 60_000);

    test("a release run whose supervisor is gone holds nobody back", async () => {
        const { box, log, rel, other } = priorityBox();
        const gone = supervisor();
        gone.kill();
        await gone.exited;
        releaseRun(box, rel, gone.pid);
        const result = await start(box, [CARGO_SHIM, "build"], { STUB_LABEL: "b" }, other).done;
        expect(result.code).toBe(0);
        expect(result.stderr).not.toContain("release run");
        expect(ran(log, "b")).toBe(true);
    }, 60_000);

    test("builds that gave way keep their arrival order once the release run ends (T2276)", async () => {
        const { box, log, rel, other } = priorityBox();
        const live = supervisor();
        releaseRun(box, rel, live.pid);
        // The release project's own builds hold both slots, so the waiters queue once the run ends.
        const holders = ["h1", "h2"].map((label) =>
            start(box, [CARGO_SHIM, "build"], { STUB_LABEL: label, STUB_SLEEP: "300" }, rel),
        );
        const waiters: Started[] = [];
        try {
            await until("both slots held", () => ran(log, "h1") && ran(log, "h2"));
            for (const label of ["w1", "w2", "w3"]) {
                const waiter = start(box, [CARGO_SHIM, "build"], { STUB_LABEL: label }, other);
                waiters.push(waiter);
                await until(`${label} giving way`, () => waiter.stderr.join("").includes(WAITING));
            }
            live.kill();
            await until("every waiter in line", () =>
                waiters.every((waiter) => waiter.stderr.join("").includes("waiting for a heavy-build slot")),
            );
            writeFileSync(`${log}.done-h1`, "");
            const results = await Promise.all(waiters.map((waiter) => waiter.done));
            expect(results.map((result) => result.code)).toEqual([0, 0, 0]);
            const order = runs(log)
                .map((run) => run.label)
                .filter((label) => label.startsWith("w"));
            expect(order).toEqual(["w1", "w2", "w3"]);
        } finally {
            live.kill();
            writeFileSync(`${log}.done-h1`, "");
            writeFileSync(`${log}.done-h2`, "");
            for (const waiter of waiters) waiter.proc.kill();
            await Promise.all(holders.map((holder) => holder.done));
        }
    }, 60_000);
});
