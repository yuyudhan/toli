// T2259: native subagents ran test suites in bulk (13 vitest processes on one 12-core builder) beside the heavy-build
// slots, which only cargo went through. A Node test runner (Vitest, Jest) now takes a slot through toli's Node
// preload, and `bun test` through toli's bun shim, both of which a lead session's native subagents inherit.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureNodePreloadStub, nodePreloadOptions } from "../src/jawans/env.ts";
import { holdSlot, runs, slotBox, start, until } from "./build-slot-fixture.ts";
import { tempDir } from "./helpers.ts";

const NODE = Bun.which("node") ?? "node";
// NODE_OPTIONS names the stable stub, which loads this checkout's preload: written into a temp home, never the host's.
process.env.TOLI_PRELOAD_HOME = tempDir("preload-home");
ensureNodePreloadStub();
const BUN_SHIM = resolve(import.meta.dir, "..", "bin", "shims", "bun");

/** A fake test runner at `node_modules/<path>` under `dir`, appending `<label> <TOLI_BUILD_SLOT or none>` to `log`. */
function fakeRunner(dir: string, path: string, label: string, log: string): string {
    const script = join(dir, "node_modules", path);
    mkdirSync(join(script, ".."), { recursive: true });
    writeFileSync(
        script,
        `process.getBuiltinModule("node:fs").appendFileSync(${JSON.stringify(log)}, "${label} " + (process.env.TOLI_BUILD_SLOT || "none") + "\\n");\n`,
    );
    return script;
}

const lines = (log: string): string[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

describe("a Node test runner takes a heavy-build slot through toli's Node preload", () => {
    test("Vitest waits for the busy slot, then runs in it; its watch mode and other Node scripts run at once", async () => {
        const { box, log } = slotBox(1, 3);
        const ran = join(box.root, ".runner-runs");
        const vitest = fakeRunner(box.root, "vitest/vitest.mjs", "vitest", ran);
        const watch = fakeRunner(box.root, ".bin/vitest", "watch", ran);
        const other = fakeRunner(box.root, "tsx/cli.js", "other", ran);
        const env = { NODE_OPTIONS: nodePreloadOptions({}) };
        const holder = await holdSlot(box, log);
        const runner = start(box, [NODE, vitest, "run"], env);
        await until("the runner waiting", () => runner.stderr.join("").includes("waiting for a heavy-build slot"));
        expect(await start(box, [NODE, watch, "watch"], env).done).toMatchObject({ code: 0 });
        expect(await start(box, [NODE, other, "run"], env).done).toMatchObject({ code: 0 });
        expect(lines(ran)).toEqual(["watch none", "other none"]);
        writeFileSync(`${log}.done-a`, "");
        const [held, tested] = await Promise.all([holder.done, runner.done]);
        expect([held.code, tested.code]).toEqual([0, 0]);
        expect(lines(ran)).toEqual(["watch none", "other none", "vitest 1"]);
        // Its holder frees the slot once the runner exits.
        const slots = join(box.root, "state", "build-slots");
        await until("the runner's slot freed", () => !readdirSync(slots).some((name) => name.endsWith(".held")));
    }, 60_000);

    test("Jest takes a slot; Jest's --watch does not", async () => {
        const { box } = slotBox(1, 3);
        const ran = join(box.root, ".runner-runs");
        const env = { NODE_OPTIONS: nodePreloadOptions({}) };
        const jest = fakeRunner(box.root, "jest/bin/jest.js", "jest", ran);
        expect(await start(box, [NODE, jest, "--ci"], env).done).toMatchObject({ code: 0 });
        expect(await start(box, [NODE, jest, "--watch"], env).done).toMatchObject({ code: 0 });
        expect(lines(ran)).toEqual(["jest 1", "jest none"]);
    }, 60_000);

    // T2635: an e2e run against a stack already up sat 2h+ waiting for a heavy-build slot behind other projects'
    // cargo builds. `playwright test` drives browsers at a running stack and compiles nothing, so it never queues as
    // heavy; a stack build its config starts (a cargo through the shim) still takes a slot of its own.
    test("`playwright test` runs at once while every slot is busy", async () => {
        const { box, log } = slotBox(1, 3);
        const ran = join(box.root, ".runner-runs");
        const env = { NODE_OPTIONS: nodePreloadOptions({}) };
        const playwright = fakeRunner(box.root, "@playwright/test/cli.js", "playwright", ran);
        const bin = fakeRunner(box.root, ".bin/playwright", "playwright-bin", ran);
        const holder = await holdSlot(box, log);
        try {
            const e2e = start(box, [NODE, playwright, "test"], env);
            const viaBin = start(box, [NODE, bin, "test", "--project=chromium"], env);
            await until("the e2e runs finishing while the slot is held", () => lines(ran).length === 2);
            const [tested, testedViaBin] = await Promise.all([e2e.done, viaBin.done]);
            expect([tested.code, testedViaBin.code]).toEqual([0, 0]);
            expect(tested.stderr + testedViaBin.stderr).not.toContain("waiting for a heavy-build slot");
            expect(lines(ran).sort()).toEqual(["playwright none", "playwright-bin none"]);
        } finally {
            writeFileSync(`${log}.done-a`, "");
        }
        expect((await holder.done).code).toBe(0);
    }, 60_000);
});

describe("bun test takes a heavy-build slot through toli's bun shim", () => {
    test("bun test waits for the busy slot and runs in it; every other bun command runs at once", async () => {
        const { box, log } = slotBox(1, 3);
        const ran = join(box.root, ".bun-runs");
        // The first bun on PATH after the shim: it logs `bun test` and runs everything else (bin/toli itself) with
        // this test's bun.
        box.stub(
            "bun",
            `if [ "$1" = test ]; then echo "test \${TOLI_BUILD_SLOT:-none}" >> "${ran}"; exit 0; fi\nexec "${process.execPath}" "$@"`,
        );
        const holder = await holdSlot(box, log);
        const suite = start(box, [BUN_SHIM, "test", "a.test.ts"]);
        await until("bun test waiting", () => suite.stderr.join("").includes("waiting for a heavy-build slot"));
        expect(await start(box, [BUN_SHIM, "--cwd", box.root, "--version"]).done).toMatchObject({ code: 0 });
        expect(lines(ran)).toEqual([]);
        writeFileSync(`${log}.done-a`, "");
        const [held, tested] = await Promise.all([holder.done, suite.done]);
        expect([held.code, tested.code]).toEqual([0, 0]);
        expect(lines(ran)).toEqual(["test 1"]);
        expect(runs(log).map((run) => run.label)).toEqual(["a"]);
    }, 60_000);
});
