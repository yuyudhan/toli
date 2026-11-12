// A project's push check (a `bin/toli gate`, or the pre-push hook a `bin/toli push` runs) takes one heavy-build slot
// for its whole run, at one slot's share of the cores, even when its recipe reaches cargo through `just` with no
// cargo shim on PATH (T1148).
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    CARGO_SHIM,
    holdSlot,
    noBusSystemdRun,
    runs,
    scopeBox,
    scopeLines,
    slotBox,
    TERMINAL_CGROUP,
    toliArgs,
    until,
} from "./build-slot-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";

// Each test runs a real detached gate runner or git push behind a real slot holder.
setDefaultTimeout(60_000);

/**
 * The environment a jawan's push check could see: no shim on PATH (the sandbox's PATH has none), a compile-jobs value
 * above the slot's share, no test-thread caps and no slot of its own.
 */
const UNCAPPED = { CARGO_BUILD_JOBS: "99", RUST_TEST_THREADS: "", NEXTEST_TEST_THREADS: "", TOLI_BUILD_SLOT: "" };

/** One build slot of three cargo jobs, project "app", and a `just` stub that logs the test-thread caps and runs `cargo test`. */
function slotProject(): { box: Sandbox; dir: string; log: string; threads: string } {
    const { box, log } = slotBox(1, 3);
    const threads = join(box.root, ".test-threads");
    box.stub("just", `echo "$RUST_TEST_THREADS $NEXTEST_TEST_THREADS" >> ${threads}\nexec cargo test "$@"`);
    return { box, dir: withProject(box, "app"), log, threads };
}

function gateLogs(box: Sandbox): string {
    const dir = join(box.root, "state", "gates", "app");
    if (!existsSync(dir)) return "";
    return readdirSync(dir)
        .filter((name) => name.endsWith(".log"))
        .map((name) => readFileSync(join(dir, name), "utf8"))
        .join("");
}

describe("a push check in one heavy-build slot", () => {
    test("a gate waits for a free slot, then runs its `just` recipe's cargo at one slot's share", async () => {
        const { box, log, threads } = slotProject();
        const holder = await holdSlot(box, log);
        const gate = box.toliAsync(["gate", "run", "app", "--recipe", "just verify"], {
            env: { ...UNCAPPED, STUB_LABEL: "g" },
        });
        await until("the gate waiting for the busy slot", () =>
            gateLogs(box).includes("waiting for a heavy-build slot (1 busy)"),
        );
        expect(runs(log).map((run) => run.label)).toEqual(["a"]);
        writeFileSync(`${log}.done-a`, "");
        expect((await holder.done).code).toBe(0);
        const result = await gate;
        expect(result.code).toBe(0);
        expect(runs(log).find((run) => run.label === "g")).toMatchObject({ slot: "1", jobs: "3", args: "test verify" });
        expect(readFileSync(threads, "utf8").trim()).toBe("3 3");
    });

    test("a push runs its pre-push hook's check in one slot, and a test-thread count already set stands", async () => {
        const { box, dir, log, threads } = slotProject();
        box.ok(["project", "set", "app", "--standing-push", "yes"]);
        writeFileSync(join(dir, ".git", "hooks", "pre-push"), "#!/bin/sh\nexec just verify push\n", { mode: 0o755 });
        const holder = await holdSlot(box, log);
        const push = box.toliAsync(["push", "app"], { env: { ...UNCAPPED, RUST_TEST_THREADS: "2", STUB_LABEL: "p" } });
        const queue = join(box.root, "state", "build-slots", "queue");
        await until(
            "the push waiting in line for the busy slot",
            () => existsSync(queue) && readdirSync(queue).some((name) => name.endsWith(".wait")),
        );
        expect(runs(log).map((run) => run.label)).toEqual(["a"]);
        writeFileSync(`${log}.done-a`, "");
        expect((await holder.done).code).toBe(0);
        const result = await push;
        expect(result.code).toBe(0);
        expect(result.stderr).toContain("waiting for a heavy-build slot (1 busy)");
        expect(runs(log).find((run) => run.label === "p")).toMatchObject({
            slot: "1",
            jobs: "3",
            args: "test verify push",
        });
        expect(readFileSync(threads, "utf8").trim()).toBe("2 3");
    });

    /** systemd-run's logged line for one scope: unit toli-build-1-<pid> capped at scopeBox's 512 MB. */
    const SCOPE_LINE =
        /^--user --scope --collect --quiet --unit=toli-build-1-\d+\.scope -p MemoryMax=512M -- \/bin\/sh /;

    test("on Linux a gate's recipe runs in its slot's memory-capped scope; a cargo or build-slot in it rides on the slot", async () => {
        const { box, log, scopeLog, env } = scopeBox(TERMINAL_CGROUP);
        withProject(box, "app");
        const quoted = (argv: string[]): string => argv.map((arg) => `'${arg}'`).join(" ");
        // One slot only: the shim's cargo and `bin/toli build-slot` inside the gate must not wait for a second one.
        const recipe = `STUB_LABEL=b ${quoted([CARGO_SHIM, "build"])} && STUB_LABEL=c ${quoted(toliArgs("build-slot", "--", "cargo", "test"))}`;
        const gate = await box.toliAsync(["gate", "run", "app", "--recipe", recipe], { env: { ...env, ...UNCAPPED } });
        expect(gate.code).toBe(0);
        const [line, ...more] = scopeLines(scopeLog);
        expect(more).toEqual([]);
        expect(line).toMatch(SCOPE_LINE);
        expect(line).toEndWith(` sh -c ${recipe}`);
        expect(runs(log).map((run) => [run.label, run.slot, run.jobs, run.args])).toEqual([
            ["b", "1", "3", "build"],
            ["c", "1", "3", "test"],
        ]);
    });

    test("a gate whose scope systemd-run cannot make runs its recipe once without it, after one warning", async () => {
        const { box, log, scopeLog, env } = scopeBox(TERMINAL_CGROUP, noBusSystemdRun);
        withProject(box, "app");
        const gate = await box.toliAsync(["gate", "run", "app", "--recipe", "cargo build"], {
            env: { ...env, ...UNCAPPED, STUB_LABEL: "g" },
        });
        expect(gate.code).toBe(0);
        expect(scopeLines(scopeLog)).toHaveLength(1);
        expect(runs(log).map((run) => [run.label, run.slot, run.jobs, run.args])).toEqual([["g", "1", "3", "build"]]);
        const warnings = gateLogs(box)
            .split("\n")
            .filter((text) => text.includes("could not start the build's scope"));
        expect(warnings).toEqual([
            "toli: systemd-run could not start the build's scope (exit 1), running it without a memory cap",
        ]);
    });

    test("on Linux a push with a pre-push hook runs in its slot's memory-capped scope", async () => {
        const { box, log, scopeLog, env } = scopeBox(TERMINAL_CGROUP);
        const dir = withProject(box, "app");
        box.ok(["project", "set", "app", "--standing-push", "yes"]);
        writeFileSync(join(dir, ".git", "hooks", "pre-push"), "#!/bin/sh\nexec cargo build\n", { mode: 0o755 });
        const push = await box.toliAsync(["push", "app"], { env: { ...env, ...UNCAPPED, STUB_LABEL: "p" } });
        expect(push.code).toBe(0);
        const [line, ...more] = scopeLines(scopeLog);
        expect(more).toEqual([]);
        expect(line).toMatch(SCOPE_LINE);
        expect(line).toContain(` -C ${dir} push -u origin `);
        expect(runs(log).find((run) => run.label === "p")).toMatchObject({ slot: "1", jobs: "3", args: "build" });
    });
});
