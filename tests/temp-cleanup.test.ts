// T2150: test runs left thousands of toli-* folders in the OS temp dir. Each check here runs `bun test` as its own
// process with a private TMPDIR and counts the toli-* folders in it before and after.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { until } from "./build-slot-fixture.ts";
import { tempDir } from "./helpers.ts";

const REPO = resolve(import.meta.dir, "..");
const PROBE = "./tests/temp-cleanup-probe.ts";

/** Test files that make temp dirs every way the suite does: per test, in beforeEach, read-only, at module level. */
const SAMPLE = [
    "./tests/setup.test.ts",
    "./tests/lock.test.ts",
    "./tests/pid-lock.test.ts",
    "./tests/repo-guard.test.ts",
    "./tests/disk-wipe-aside.test.ts",
];

type Run = { tmp: string; mark: string; proc: Bun.Subprocess<"ignore", "pipe", "pipe"> };

/** The toli-* folders in `tmp`. */
function leftovers(tmp: string): string[] {
    return readdirSync(tmp)
        .filter((name) => name.startsWith("toli-"))
        .sort();
}

/** `bun test files` from the repo root with `tmp` as its TMPDIR; `probe` sets the probe's mode. */
function bunTest(tmp: string, files: string[], probe = ""): Run {
    const mark = join(tmp, "probe-mark");
    const proc = Bun.spawn([process.execPath, "test", "--timeout", "60000", ...files], {
        cwd: REPO,
        env: { ...process.env, TMPDIR: tmp, TOLI_TEMP_PROBE: probe, TOLI_TEMP_PROBE_MARK: mark },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    return { tmp, mark, proc };
}

async function finished(run: Run): Promise<{ code: number; output: string }> {
    const [stdout, stderr, code] = await Promise.all([
        new Response(run.proc.stdout).text(),
        new Response(run.proc.stderr).text(),
        run.proc.exited,
    ]);
    return { code, output: stdout + stderr };
}

/** Starts the probe's hanging test and resolves once it has made its temp dirs (a real process: poll its mark file). */
async function hanging(tmp: string): Promise<Run> {
    const run = bunTest(tmp, [PROBE], "hang");
    await until("the probe's hanging test", () => existsSync(run.mark), 60_000);
    return run;
}

describe("test runs leave no toli-* temp folder behind (T2150)", () => {
    test("a sample of the suite's test files", async () => {
        const tmp = tempDir("tmpdir");
        const before = leftovers(tmp);
        const result = await finished(bunTest(tmp, SAMPLE));
        expect(result.output).toContain(" 0 fail");
        expect(result.code).toBe(0);
        expect(leftovers(tmp)).toEqual(before);
    }, 300_000);

    test("a test's temp dirs go when it ends, not when the run ends", async () => {
        const tmp = tempDir("tmpdir");
        const result = await finished(bunTest(tmp, [PROBE], "scope"));
        expect(result.output).toContain(" 2 pass");
        expect(result.code).toBe(0);
        expect(leftovers(tmp)).toEqual([]);
    }, 120_000);

    test("a test that exits the process", async () => {
        const tmp = tempDir("tmpdir");
        const result = await finished(bunTest(tmp, [PROBE], "exit"));
        expect(result.code).toBe(3);
        expect(leftovers(tmp)).toEqual([]);
    }, 120_000);

    test("a run stopped with SIGTERM or SIGINT", async () => {
        for (const signal of ["SIGTERM", "SIGINT"] as const) {
            const tmp = tempDir("tmpdir");
            const run = await hanging(tmp);
            expect(leftovers(tmp)).not.toEqual([]);
            run.proc.kill(signal);
            await finished(run);
            expect(leftovers(tmp)).toEqual([]);
        }
    }, 120_000);

    test("a run killed outright: the next run removes what it left", async () => {
        const tmp = tempDir("tmpdir");
        const run = await hanging(tmp);
        run.proc.kill("SIGKILL");
        await finished(run);
        expect(leftovers(tmp)).not.toEqual([]);
        const next = await finished(bunTest(tmp, [PROBE], "scope"));
        expect(next.code).toBe(0);
        expect(leftovers(tmp)).toEqual([]);
    }, 120_000);
});
