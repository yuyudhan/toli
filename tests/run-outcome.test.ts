import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { killedExit } from "../src/jawans/supervise.ts";
import { brief, coordinator, spawnJson, waitFor } from "./jawan-fixture.ts";

// Each test waits on a detached run (up to 10 s per waitFor); on a loaded machine that passes Bun's 5 s default.
setDefaultTimeout(30_000);

describe("run outcome", () => {
    test("a failing harness is recorded as failed with its exit code", async () => {
        const box = coordinator();
        box.stub("omp", 'echo "boom"; exit 3');
        const started = spawnJson(box, ["--harness", "omp", "--brief", brief(box), "--cwd", box.root]);
        const done = await waitFor(box, started.id, (run) => run.inbox !== null);
        expect(done.status).toBe("failed");
        expect(done.exitCode).toBe(3);
        expect(readFileSync(done.inbox ?? "", "utf8")).toContain("- status: failed (exit 3)");
    });

    test("a harness that prints only an API error fails even when it exits 0: the error is no report", async () => {
        const box = coordinator();
        box.stub("omp", `echo 'API Error: 500 {"type":"error","error":{"type":"api_error"}}'`);
        const started = spawnJson(box, ["--harness", "omp", "--brief", brief(box), "--cwd", box.root]);
        const done = await waitFor(box, started.id, (run) => run.inbox !== null);
        expect(done.status).toBe("failed");
        expect(readFileSync(done.inbox ?? "", "utf8")).toContain(
            "- status: failed (exit 0): the harness printed only errors, no report",
        );
    });

    test("a killed shell harness that exits 128 + n is recorded as killed by signal n", () => {
        const exit = (code: number | null, signal: string | null) => ({ code, signal, error: null });
        expect(killedExit(exit(143, null))).toEqual(exit(null, "SIGTERM"));
        expect(killedExit(exit(137, null))).toEqual(exit(null, "SIGKILL"));
        expect(killedExit(exit(null, "SIGTERM"))).toEqual(exit(null, "SIGTERM"));
        expect(killedExit(exit(1, null))).toEqual(exit(1, null));
    });
});
