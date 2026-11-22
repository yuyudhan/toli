// A project whose checks take the heavy-build slot themselves at their first heavy step (`project set
// --slot-at-heavy-step yes`, T2257): its gate or pre-push hook runs its cheap steps (guards, spelling, formatting,
// type checks, lint) beside a busy slot, and holds one slot only from its first `bin/toli build-slot` step to its end.
// A cheap step's failure fails the check without ever queueing. Projects without the setting keep one slot for the
// whole run (tests/build-slot-push.test.ts).
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { holdSlot, runs, slotBox, start, toliArgs, until } from "./build-slot-fixture.ts";
import { type Sandbox, TOLI_BIN, withProject } from "./helpers.ts";

/** toli's rustc wrapper, cargo's RUSTC_WRAPPER for a cargo that bypasses the shim. */
const RUSTC_WRAPPER = resolve(import.meta.dir, "..", "bin", "shims", "toli-rustc-wrapper");

// Each test runs a real detached gate runner or git push beside a real slot holder.
setDefaultTimeout(60_000);

/** No slot of its own and an uncapped compile-jobs value, as a jawan's push check could see. */
const UNCAPPED = { CARGO_BUILD_JOBS: "99", TOLI_BUILD_SLOT: "" };
/** The recipe's way to this checkout's CLI. */
const TOLI = `"${process.execPath}" "${TOLI_BIN}"`;

/** One build slot of three cargo jobs, project "app" declaring its heavy steps, and the file its cheap steps write. */
function heavyStepProject(): { box: Sandbox; dir: string; log: string; cheap: string } {
    const { box, log } = slotBox(1, 3);
    const dir = withProject(box, "app");
    box.ok(["project", "set", "app", "--slot-at-heavy-step", "yes", "--standing-push", "yes"]);
    return { box, dir, log, cheap: join(box.root, ".cheap-steps") };
}

function gateLogs(box: Sandbox): string {
    const dir = join(box.root, "state", "gates", "app");
    if (!existsSync(dir)) return "";
    return readdirSync(dir)
        .filter((name) => name.endsWith(".log"))
        .map((name) => readFileSync(join(dir, name), "utf8"))
        .join("");
}

const lines = (file: string): string[] => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : []);
const waits = (text: string): number => text.split("waiting for a heavy-build slot (1 busy)").length - 1;

describe("a check that takes its heavy-build slot at its first heavy step", () => {
    test("a gate runs its cheap steps beside a busy slot, then holds one slot from its first heavy step to its end", async () => {
        const { box, log, cheap } = heavyStepProject();
        const recipe = [
            `echo guard >> ${cheap}`,
            `STUB_LABEL=h1 ${TOLI} build-slot -- cargo clippy`,
            `echo lint >> ${cheap}`,
            `STUB_LABEL=h2 STUB_SLEEP=150 ${TOLI} build-slot -- cargo test`,
        ].join(" && ");
        const holder = await holdSlot(box, log);
        const gate = box.toliAsync(["gate", "run", "app", "--recipe", recipe], { env: UNCAPPED });
        await until("the cheap step running beside the busy slot", () => lines(cheap).includes("guard"));
        await until("the first heavy step waiting for the busy slot", () => waits(gateLogs(box)) === 1);
        expect(runs(log).map((run) => run.label)).toEqual(["a"]);
        writeFileSync(`${log}.done-a`, "");
        expect((await holder.done).code).toBe(0);
        await until("the second heavy step", () => runs(log).some((run) => run.label === "h2"));
        // The slot stays the gate's between its heavy steps: a build arriving now waits for the gate's end.
        const other = start(box, toliArgs("build-slot", "--", "cargo", "build"), { STUB_LABEL: "b" });
        await until("the other build waiting for the gate's slot", () =>
            other.stderr.join("").includes("waiting for a heavy-build slot (1 busy)"),
        );
        writeFileSync(`${log}.done-h2`, "");
        const result = await gate;
        expect(result.code).toBe(0);
        expect((await other.done).code).toBe(0);
        const [a, h1, h2, b] = ["a", "h1", "h2", "b"].map((label) => runs(log).find((run) => run.label === label));
        expect(h1).toMatchObject({ slot: "1", jobs: "3", args: "clippy" });
        expect(h2).toMatchObject({ slot: "1", jobs: "3", args: "test" });
        expect(h1?.start).toBeGreaterThanOrEqual(a?.end ?? Number.NaN);
        expect(b?.start).toBeGreaterThanOrEqual(h2?.end ?? Number.NaN);
        expect(lines(cheap)).toEqual(["guard", "lint"]);
        expect(waits(gateLogs(box))).toBe(1);
    });

    test("a cheap step's failure fails the gate at once, without ever queueing for the busy slot", async () => {
        const { box, log, cheap } = heavyStepProject();
        const recipe = `echo guard >> ${cheap} && sh -c 'exit 3' && STUB_LABEL=h1 ${TOLI} build-slot -- cargo test`;
        const holder = await holdSlot(box, log);
        const result = await box.toliAsync(["gate", "run", "app", "--recipe", recipe], { env: UNCAPPED });
        expect(result.code).not.toBe(0);
        expect(gateLogs(box)).not.toContain("waiting for a heavy-build slot");
        // The holder never let go: the gate ended while the slot was still busy.
        expect(runs(log).map((run) => ({ label: run.label, ended: !Number.isNaN(run.end) }))).toEqual([
            { label: "a", ended: false },
        ]);
        expect(lines(cheap)).toEqual(["guard"]);
        writeFileSync(`${log}.done-a`, "");
        expect((await holder.done).code).toBe(0);
    });

    test("a gate waiting at its heavy step for longer than its stall minutes says so and is not stopped", async () => {
        const { box, log } = heavyStepProject();
        const minuteMs = 600;
        const recipe = `STUB_LABEL=h1 ${TOLI} build-slot -- cargo test`;
        const holder = await holdSlot(box, log);
        const gate = box.toliAsync(["gate", "run", "app", "--recipe", recipe, "--stall", "1"], {
            env: { ...UNCAPPED, TOLI_RUN_MINUTE_MS: String(minuteMs) },
        });
        await until("the heavy step waiting for the busy slot", () => waits(gateLogs(box)) === 1);
        // A line every third of the stall minutes keeps the gate alive: four of them span longer than its stall window.
        await until(
            "the wait outlasting the stall window",
            () => gateLogs(box).split("toli: still waiting for a heavy-build slot").length - 1 >= 4,
        );
        writeFileSync(`${log}.done-a`, "");
        expect((await holder.done).code).toBe(0);
        const result = await gate;
        expect(result.code).toBe(0);
        expect(runs(log).find((run) => run.label === "h1")).toMatchObject({ slot: "1", args: "test" });
    });

    test("a test runner's slot request in such a gate takes the gate's slot instead of a holder of its own", async () => {
        const { box, log, cheap } = heavyStepProject();
        // `build-slot --runner` is what toli's Node preload runs as a test runner starts (src/fleet/cargo-slot.ts).
        const recipe = `echo guard >> ${cheap} && echo "runner-slot=$(${TOLI} build-slot --runner $$)" >> ${cheap}`;
        const holder = await holdSlot(box, log);
        const gate = box.toliAsync(["gate", "run", "app", "--recipe", recipe, "--stall", "1"], {
            env: { ...UNCAPPED, TOLI_RUN_MINUTE_MS: "600" },
        });
        await until("the cheap step running beside the busy slot", () => lines(cheap).includes("guard"));
        // Only the gate's runner says it still waits: the runner step asked the gate, not a holder of its own.
        await until("the gate's runner waiting for the runner step", () =>
            gateLogs(box).includes("toli: still waiting for a heavy-build slot"),
        );
        writeFileSync(`${log}.done-a`, "");
        expect((await holder.done).code).toBe(0);
        expect((await gate).code).toBe(0);
        expect(lines(cheap)).toEqual(["guard", "runner-slot=1"]);
    });

    test("a push runs its hook's cheap steps beside a busy slot and takes one at its first heavy step", async () => {
        const { box, dir, log, cheap } = heavyStepProject();
        writeFileSync(
            join(dir, ".git", "hooks", "pre-push"),
            `#!/bin/sh\necho guard >> ${cheap}\nSTUB_LABEL=p ${TOLI} build-slot -- cargo test\n`,
            { mode: 0o755 },
        );
        const holder = await holdSlot(box, log);
        const push = box.toliAsync(["push", "app"], { env: UNCAPPED });
        await until("the hook's cheap step running beside the busy slot", () => lines(cheap).includes("guard"));
        const queue = join(box.root, "state", "build-slots", "queue");
        await until(
            "the hook's heavy step waiting in line",
            () => existsSync(queue) && readdirSync(queue).some((name) => name.endsWith(".wait")),
        );
        expect(runs(log).map((run) => run.label)).toEqual(["a"]);
        writeFileSync(`${log}.done-a`, "");
        expect((await holder.done).code).toBe(0);
        const result = await push;
        expect(result.code).toBe(0);
        expect(waits(result.stderr)).toBe(1);
        expect(runs(log).find((run) => run.label === "p")).toMatchObject({ slot: "1", jobs: "3", args: "test" });
    });

    // T2257 round 2: a cargo that bypassed the shim reached the run's slot through the rustc wrapper's probe, but its
    // crate compilations found no slot (no TOLI_BUILD_SLOT, no cargo-<pid>.held) and ran outside the slot's job pool.
    test("a cargo that bypasses the shim in such a gate compiles in the run's slot's job pool", async () => {
        const { box, log } = heavyStepProject();
        const bin = join(box.root, ".cargo", "bin");
        mkdirSync(bin, { recursive: true });
        const compiled = join(box.root, ".compiled");
        const rustc = join(bin, "rustc");
        writeFileSync(
            rustc,
            `#!/bin/sh\n[ "$1" = -vV ] && { echo "rustc 1.90.0 (fake)"; exit 0; }\necho "job=\${TOLI_BUILD_JOB:-none}" >> ${compiled}\n`,
        );
        chmodSync(rustc, 0o755);
        // As cargo does: the `rustc -vV` probe through RUSTC_WRAPPER first, then each crate through it.
        const cargo = join(bin, "cargo");
        writeFileSync(
            cargo,
            `#!/bin/sh\n"$RUSTC_WRAPPER" ${rustc} -vV >/dev/null || exit 1\n"$RUSTC_WRAPPER" ${rustc} --crate-name demo src/lib.rs\n`,
        );
        chmodSync(cargo, 0o755);
        const holder = await holdSlot(box, log);
        const gate = box.toliAsync(["gate", "run", "app", "--recipe", `${cargo} build`], {
            env: { ...UNCAPPED, RUSTC_WRAPPER, TOLI_RUSTC_WRAPPER_NEXT: "" },
        });
        await until("the cargo's probe waiting for the busy slot", () => waits(gateLogs(box)) >= 1);
        writeFileSync(`${log}.done-a`, "");
        expect((await holder.done).code).toBe(0);
        expect((await gate).code).toBe(0);
        expect(lines(compiled)).toEqual([`job=${join(box.root, "state", "build-slots", "jobs-1", "1")}`]);
    });
});
