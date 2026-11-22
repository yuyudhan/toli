import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extendStreak, failureLine } from "../src/forge/gate-supervise.ts";
import { holdSlot, slotBox, until } from "./build-slot-fixture.ts";
import { commitFile, gatesLog, recipe, records, setup } from "./gate-fixture.ts";
import { TOLI_BIN, withProject } from "./helpers.ts";

// Gates run real detached runners and wait on them; on a loaded machine one test can take tens of seconds.
setDefaultTimeout(60_000);

describe("runaway gates", () => {
    test("a gate waiting for its heavy-build slot is not a runaway: its clock and its estimate leave the wait out", async () => {
        // One slot, and a project whose recipes take it at their first heavy step (`--slot-at-heavy-step`).
        const { box, log } = slotBox(1, 3);
        const dir = withProject(box, "app");
        box.ok(["project", "set", "app", "--slot-at-heavy-step", "yes"]);
        // A two-second minute: a quick pass gives the gate a two-second runaway limit.
        const minuteMs = 2000;
        const env = { CARGO_BUILD_JOBS: "99", TOLI_BUILD_SLOT: "", TOLI_RUN_MINUTE_MS: String(minuteMs) };
        const verify = recipe(box, "verify", "echo ok");
        box.ok(["gate", "run", "app", "--recipe", verify, "--stall", "30"], { env });
        commitFile(box, dir, "a.txt");
        // The same recipe now has a heavy step, which waits in line while another build holds the only slot.
        writeFileSync(
            join(box.root, "verify.sh"),
            `STUB_LABEL=h1 "${process.execPath}" "${TOLI_BIN}" build-slot -- cargo test\n`,
        );
        const holder = await holdSlot(box, log);
        const gate = box.toliAsync(["gate", "run", "app", "--recipe", verify, "--stall", "30"], { env });
        const waiting = () => records(box).find((entry) => entry.status !== "passed");
        await until("the heavy step waiting for the busy slot", () =>
            readFileSync(waiting()?.log ?? "/dev/null", "utf8").includes("waiting for a heavy-build slot"),
        );
        // A real wait of three runaway limits: the slot wait is what is under test, so no fake clock can stand in.
        await Bun.sleep(3 * minuteMs + 1000);
        expect(waiting()?.status).toBe("running");
        writeFileSync(`${log}.done-a`, "");
        expect((await holder.done).code).toBe(0);
        const result = await gate;
        expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
        const passes = records(box) as { status: string; recipeMs?: number; slotWaitMs?: number }[];
        expect(passes.map((entry) => entry.status)).toEqual(["passed", "passed"]);
        // The pass's recipeMs, the next estimate's source, leaves the wait out; slotWaitMs says how long it was.
        const slow = passes.find((entry) => (entry.slotWaitMs ?? 0) > 0);
        expect(slow?.slotWaitMs).toBeGreaterThanOrEqual(3 * minuteMs);
        expect(slow?.recipeMs).toBeLessThan(3 * minuteMs);
    });

    test("a gate over 3 times the median of its passes that has gone quiet is stopped and recorded runaway", () => {
        const { box, dir } = setup();
        // A one-second minute: a quick pass gives a one-second limit, and five quiet minutes are five seconds.
        const minutes = { TOLI_RUN_MINUTE_MS: "1000" };
        const verify = recipe(box, "verify", "echo ok");
        box.ok(["gate", "run", "app", "--recipe", verify, "--stall", "30"], { env: minutes });
        const passed = records(box)[0] as { recipeMs?: number; estimateMs?: number };
        expect(passed.recipeMs).toBeGreaterThan(0);
        expect(passed.estimateMs).toBeUndefined();
        commitFile(box, dir, "a.txt");
        // The same recipe now prints once and then sits silent, well inside its 30-minute stall limit.
        writeFileSync(join(box.root, "verify.sh"), "echo started; sleep 60 && echo never\n");
        const started = Date.now();
        const result = box.toli(["gate", "run", "app", "--recipe", verify, "--stall", "30"], { env: minutes });
        const record = records(box).find((entry) => entry.status !== "passed") as
            | { status: string; reason?: string; log: string; estimateMs?: number }
            | undefined;
        expect({ record, ms: Date.now() - started }).toMatchObject({ record: { status: "runaway" } });
        expect(Date.now() - started).toBeLessThan(25_000);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("runaway");
        expect(record?.estimateMs).toBeGreaterThan(0);
        expect(record?.reason).toContain("over 3 times its estimate");
        expect(record?.reason).toContain("no new output for 5 minutes");
        expect(gatesLog(box)).toMatch(/ app [0-9a-f]{12} runaway: /);
    });

    test("a recipe that grew past 3 times its estimate but keeps printing passes, and its estimate follows", () => {
        const { box, dir } = setup();
        const minutes = { TOLI_RUN_MINUTE_MS: "1000" };
        const verify = recipe(box, "verify", "echo ok");
        box.ok(["gate", "run", "app", "--recipe", verify, "--stall", "30"], { env: minutes });
        commitFile(box, dir, "a.txt");
        // Four seconds of steady output: four times the one-second limit, never quiet.
        writeFileSync(
            join(box.root, "verify.sh"),
            "i=1; while [ $i -le 20 ]; do echo tick $i; i=$((i + 1)); sleep 0.2; done\n",
        );
        box.ok(["gate", "run", "app", "--recipe", verify, "--stall", "30"], { env: minutes });
        const grown = records(box) as { status: string; recipeMs?: number; estimateMs?: number }[];
        expect(grown.map((entry) => entry.status)).toEqual(["passed", "passed"]);
        const slow = grown.find((entry) => entry.estimateMs !== undefined);
        expect(slow?.recipeMs).toBeGreaterThan(3 * (slow?.estimateMs ?? 0));
        // The next run's estimate is the median of both passes, so it has moved toward the grown recipe.
        commitFile(box, dir, "b.txt");
        box.ok(["gate", "run", "app", "--recipe", verify, "--stall", "30"], { env: minutes });
        const next = (records(box) as { estimateMs?: number }[]).map((entry) => entry.estimateMs ?? 0);
        expect(Math.max(...next)).toBeGreaterThan(1000);
    });

    test("a gate printing failures for 30 minutes is stopped and recorded runaway, not left to finish", () => {
        const { box } = setup();
        // A 100 ms minute: failures for three seconds, none more than a second apart.
        const minutes = { TOLI_RUN_MINUTE_MS: "100" };
        const red = recipe(
            box,
            "red",
            'i=1; while [ $i -le 300 ]; do echo " FAIL  src/case$i.test.ts > times out"; i=$((i + 1)); sleep 0.2; done && echo finished',
        );
        const started = Date.now();
        const result = box.toli(["gate", "run", "app", "--recipe", red, "--stall", "30"], { env: minutes });
        const record = records(box)[0];
        expect({ record, ms: Date.now() - started }).toMatchObject({ record: { status: "runaway" } });
        expect(Date.now() - started).toBeLessThan(30_000);
        expect(result.code).toBe(1);
        expect(record?.reason).toContain("printed failures for");
    });
});

describe("failure lines (in process)", () => {
    test("runners' per-test and summary failure lines count; retries, expected failures and free text do not", () => {
        for (const line of [
            " FAIL  src/a.test.ts > case",
            "\u001b[31m FAIL \u001b[39m src/a.test.ts",
            "   × renders the list 52ms",
            "test parser::tests::bad ... FAILED",
            "test result: FAILED. 3 passed; 1 failed; 0 ignored",
            "(fail) gate > stops it [12.00ms]",
            "      Tests  3 failed | 120 passed (123)",
            "Tests:       2 failed, 40 passed, 42 total",
            "        FAIL [   0.004s] crate::tests::case",
            "FAILED tests/test_api.py::test_login - AssertionError",
            "==== 1 failed, 20 passed in 3.21s ====",
            "  2 failed",
            "error[E0308]: mismatched types",
            "src/a.ts(3,1): error TS2339: Property 'x' does not exist",
        ])
            expect({ line, failure: failureLine(line) }).toEqual({ line, failure: true });
        for (const line of [
            "test result: ok. 10 passed; 0 failed; 0 ignored",
            "      Tests  120 passed (120)",
            "error: expected failure in an error-path test",
            "thread 'case' panicked at src/lib.rs:3:5",
            "test parser::tests::boom - should panic ... ok",
            " ✓ src/a.test.ts (3 tests) 12ms",
            " ✓ src/flaky.test.ts > retries (retry x2) 40ms",
            "   × src/flaky.test.ts > retries (retry x1)",
            "10 passed, 0 failed",
            "XFAIL tests/test_api.py::test_known - reason",
            "==== 20 passed, 2 xfailed in 3.21s ====",
            "        TRY 1 FAIL [   0.004s] crate::tests::case",
            "        FLAKY 2/3 [   0.010s] crate::tests::case",
            "(pass) gate > stops it [12.00ms]",
            "  ✘  3 [chromium] › login.spec.ts:5:1 › logs in (retry #1)",
            "INFO login: 1 failed attempt, retrying",
            "3 failed requests to mock server",
            "  FAIL-FAST disabled",
            "step (fail) noted mid-line",
            "status FAILED_PRECONDITION from server",
        ])
            expect({ line, failure: failureLine(line) }).toEqual({ line, failure: false });
    });

    test("a streak runs while failures keep coming within the gap, and restarts after a longer quiet", () => {
        let streak = extendStreak(null, 1000, 500);
        streak = extendStreak(streak, 1400, 500);
        streak = extendStreak(streak, 1800, 500);
        expect(streak).toEqual({ since: 1000, last: 1800 });
        expect(extendStreak(streak, 2400, 500)).toEqual({ since: 2400, last: 2400 });
    });
});
