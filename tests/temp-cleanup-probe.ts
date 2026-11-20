// Run only by tests/temp-cleanup.test.ts, as its own `bun test` process (the name keeps the suite from collecting it):
// TOLI_TEMP_PROBE picks how its tests end, TOLI_TEMP_PROBE_MARK is the file a test writes once its temp dirs exist.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, tempDir } from "./helpers.ts";

const mode = process.env.TOLI_TEMP_PROBE ?? "";
const mark = process.env.TOLI_TEMP_PROBE_MARK ?? "";
/** Made at module level: it belongs to the whole run, so it outlives every test. */
const shared = tempDir("probe-shared");

if (mode === "scope") {
    test("a test's own temp dirs", () => {
        writeFileSync(mark, sandbox().root);
    });

    test("are gone once it ends; the run's stay", () => {
        const first = readFileSync(mark, "utf8");
        expect(existsSync(first)).toBe(false);
        expect(existsSync(shared)).toBe(true);
        // A process the first test started writes into its dir after it ended, as a tick's background fleet check does.
        mkdirSync(join(first, "data", "inbox"), { recursive: true });
    });
}

if (mode === "exit") {
    test("a test that exits the process", () => {
        sandbox();
        process.exit(3);
    });
}

if (mode === "hang") {
    test("a test still running when the run is stopped", async () => {
        sandbox();
        writeFileSync(mark, "ready");
        // Never settles: the parent stops this run with a signal; the test's own timeout keeps the process alive.
        await new Promise<never>(() => undefined);
    }, 90_000);
}
