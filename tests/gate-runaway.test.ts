import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { extendStreak, failureLine } from "../src/forge/gate-supervise.ts";
import { commitFile, gatesLog, recipe, records, setup } from "./gate-fixture.ts";

// Gates run real detached runners and wait on them; on a loaded machine one test can take tens of seconds.
setDefaultTimeout(60_000);

describe("runaway gates", () => {
    test("a gate running over 3 times the median of its passes is stopped and recorded runaway", () => {
        const { box, dir } = setup();
        // A three-second minute: the limit is at least one minute, so a quick pass gives a three-second limit.
        const minutes = { TOLI_RUN_MINUTE_MS: "3000" };
        const verify = recipe(box, "verify", "echo ok");
        box.ok(["gate", "run", "app", "--recipe", verify, "--stall", "30"], { env: minutes });
        const passed = records(box)[0] as { recipeMs?: number; estimateMs?: number };
        expect(passed.recipeMs).toBeGreaterThan(0);
        expect(passed.estimateMs).toBeUndefined();
        commitFile(box, dir, "a.txt");
        // The same recipe now prints steadily for a minute, so neither the stall check nor a failure stops it.
        writeFileSync(
            join(box.root, "verify.sh"),
            "i=1; while [ $i -le 300 ]; do echo tick $i; i=$((i + 1)); sleep 0.2; done && echo finished\n",
        );
        const started = Date.now();
        const result = box.toli(["gate", "run", "app", "--recipe", verify, "--stall", "30"], { env: minutes });
        const record = records(box).find((entry) => entry.status !== "passed") as
            | { status: string; reason?: string; log: string; estimateMs?: number }
            | undefined;
        expect({ record, ms: Date.now() - started }).toMatchObject({ record: { status: "runaway" } });
        expect(Date.now() - started).toBeLessThan(30_000);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("runaway");
        expect(record?.estimateMs).toBeGreaterThan(0);
        expect(record?.reason).toContain("over 3 times its estimate");
        expect(gatesLog(box)).toMatch(/ app [0-9a-f]{12} runaway: /);
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
    test("common runners' failure marks count; passing summaries and error-path output do not", () => {
        for (const line of [
            " FAIL  src/a.test.ts > case",
            "\u001b[31m FAIL \u001b[39m src/a.test.ts",
            "   × renders the list 52ms",
            "test parser::tests::bad ... FAILED",
            "(fail) gate > stops it [12.00ms]",
            "      Tests  3 failed | 120 passed (123)",
            "        FAIL [   0.004s] crate::tests::case",
            "error[E0308]: mismatched types",
            "src/a.ts(3,1): error TS2339: Property 'x' does not exist",
        ])
            expect({ line, failure: failureLine(line) }).toEqual({ line, failure: true });
        for (const line of [
            "test result: ok. 10 passed; 0 failed; 0 ignored",
            "      Tests  120 passed (120)",
            "error: expected failure in an error-path test",
            "thread 'case' panicked at src/lib.rs:3:5",
            " ✓ src/a.test.ts (3 tests) 12ms",
            "10 passed, 0 failed",
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
