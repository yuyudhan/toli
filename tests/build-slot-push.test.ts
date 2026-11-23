// A project's push check (a `bin/toli gate`, or the pre-push hook a `bin/toli push` runs) takes one heavy-build slot
// for its whole run, at one slot's share of the cores, even when its recipe reaches cargo through `just` with no
// cargo shim on PATH (T1148).
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
    CARGO_SHIM,
    holdSlot,
    noBusSystemdRun,
    runs,
    scopeBox,
    scopeLines,
    slotBox,
    start,
    TERMINAL_CGROUP,
    toliArgs,
    until,
} from "./build-slot-fixture.ts";
import { type Sandbox, TOLI_BIN, withProject } from "./helpers.ts";

// Each test runs a real detached gate runner or git push behind a real slot holder.
setDefaultTimeout(60_000);

/**
 * The environment a jawan's push check could see: no shim on PATH (the sandbox's PATH has none), a compile-jobs value
 * above the slot's share, no test-thread caps and no slot of its own.
 */
const UNCAPPED = { CARGO_BUILD_JOBS: "99", RUST_TEST_THREADS: "", NEXTEST_TEST_THREADS: "", TOLI_BUILD_SLOT: "" };
/** A hook's way to this checkout's CLI. */
const TOLI = `"${process.execPath}" "${TOLI_BIN}"`;

const lines = (file: string): string[] => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : []);

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

    // T1905: a push whose hook skips its heavy steps (the project's own escape hatch) queued ~20 min for a slot.
    test("a push the pre-push hook declares light, by the env it reads, takes no slot; a heavy one still does", async () => {
        const { box, dir, log } = slotProject();
        box.ok(["project", "set", "app", "--standing-push", "yes"]);
        writeFileSync(
            join(dir, ".git", "hooks", "pre-push"),
            '#!/bin/sh\n# toli-light-push: APP_VERIFY_SKIP=1\n[ "${APP_VERIFY_SKIP:-}" = 1 ] && exit 0\nexec just verify push\n',
            { mode: 0o755 },
        );
        const holder = await holdSlot(box, log);
        const light = await box.toliAsync(["push", "app"], { env: { ...UNCAPPED, APP_VERIFY_SKIP: "1" } });
        expect(light.code).toBe(0);
        expect(light.stderr).toContain(
            "toli: the pre-push hook declares no heavy step with APP_VERIFY_SKIP=1: pushing without a heavy-build slot",
        );
        expect(light.stderr).not.toContain("waiting for a heavy-build slot");
        writeFileSync(join(dir, "heavy.txt"), "heavy\n");
        box.git(dir, ["add", "heavy.txt"]);
        box.git(dir, ["commit", "-m", "heavy"]);
        const heavy = box.toliAsync(["push", "app"], { env: { ...UNCAPPED, APP_VERIFY_SKIP: "0", STUB_LABEL: "p" } });
        const queue = join(box.root, "state", "build-slots", "queue");
        await until(
            "the heavy push waiting in line for the busy slot",
            () => existsSync(queue) && readdirSync(queue).some((name) => name.endsWith(".wait")),
        );
        writeFileSync(`${log}.done-a`, "");
        expect((await holder.done).code).toBe(0);
        expect((await heavy).code).toBe(0);
        expect(runs(log).find((run) => run.label === "p")).toMatchObject({ slot: "1", args: "test verify push" });
    });

    // T2211: a push whose hook skips its gate step on a sealed pass waited ~50 min for a slot only to run cheap steps.
    test("a push whose hook's declared gate passed on the pushed tree takes no slot; a stale pass still takes one", async () => {
        const { box, dir, log } = slotProject();
        box.ok(["project", "set", "app", "--standing-push", "yes"]);
        const ran = join(box.root, ".hook-ran");
        writeFileSync(
            join(dir, ".git", "hooks", "pre-push"),
            `#!/bin/sh\n# toli-light-push-after-gate: just verify\necho "$(git rev-parse HEAD)" >> ${ran}\n`,
            { mode: 0o755 },
        );
        writeFileSync(join(dir, "gated.txt"), "gated\n");
        box.git(dir, ["add", "gated.txt"]);
        box.git(dir, ["commit", "-m", "gated"]);
        box.ok(["gate", "run", "app", "--recipe", "just verify"], { env: { ...UNCAPPED, STUB_LABEL: "g" } });
        const holder = await holdSlot(box, log);
        const passed = await box.toliAsync(["push", "app"], { env: UNCAPPED });
        expect(passed.code).toBe(0);
        expect(passed.stderr).toContain("pushing exactly that commit without a heavy-build slot");
        expect(passed.stderr).not.toContain("waiting for a heavy-build slot");
        const gated = box.git(dir, ["rev-parse", "HEAD"]).trim();
        expect(readFileSync(ran, "utf8").trim()).toBe(gated);
        expect(box.git(dir, ["ls-remote", "origin", "refs/heads/main"]).split(/\s+/)[0]).toBe(gated);
        writeFileSync(join(dir, "stale.txt"), "stale\n");
        box.git(dir, ["add", "stale.txt"]);
        box.git(dir, ["commit", "-m", "stale"]);
        const stale = box.toliAsync(["push", "app"], { env: UNCAPPED });
        const queue = join(box.root, "state", "build-slots", "queue");
        await until(
            "the stale-pass push waiting in line for the busy slot",
            () => existsSync(queue) && readdirSync(queue).some((name) => name.endsWith(".wait")),
        );
        writeFileSync(`${log}.done-a`, "");
        expect((await holder.done).code).toBe(0);
        const result = await stale;
        expect(result.code).toBe(0);
        expect(result.stderr).toContain(
            "toli: the pre-push hook takes a heavy-build slot: no sealed pass of just verify",
        );
        expect(result.stderr).toContain("waiting for a heavy-build slot (1 busy)");
        expect(readFileSync(ran, "utf8").trim().split("\n")).toHaveLength(2);
    });

    // T28: a `push --gate` whose gate passed queued for the slot again for its pre-push hook, which only asks `gate
    // check` and skips its gate step; the push waited hours behind builds that took the slot the gate had just freed.
    describe("a push --gate whose hook asks `gate check`", () => {
        /** Project "app" (one slot) whose hook skips `just verify` on its sealed pass, else runs it. */
        function gateCheckProject(): { box: Sandbox; dir: string; log: string; steps: string } {
            const { box, dir, log } = slotProject();
            box.ok(["project", "set", "app", "--standing-push", "yes"]);
            const steps = join(box.root, ".hook-steps");
            writeFileSync(
                join(dir, ".git", "hooks", "pre-push"),
                [
                    "#!/bin/sh",
                    `echo guard >> ${steps}`,
                    `if ${TOLI} gate check app --sha "$(git rev-parse HEAD)" --recipe 'just verify' >/dev/null 2>&1; then`,
                    `    echo sealed >> ${steps}`,
                    "    exit 0",
                    "fi",
                    "STUB_LABEL=p STUB_SLEEP=0 exec just verify",
                    "",
                ].join("\n"),
                { mode: 0o755 },
            );
            writeFileSync(join(dir, "gated.txt"), "gated\n");
            box.git(dir, ["add", "gated.txt"]);
            box.git(dir, ["commit", "-m", "gated"]);
            return { box, dir, log, steps };
        }

        test("pushes once its gate passed, never queueing behind a build that took the slot the gate freed", async () => {
            const { box, dir, log, steps } = gateCheckProject();
            let ended = false;
            const push = box
                .toliAsync(["push", "app", "--gate", "just verify"], {
                    env: { ...UNCAPPED, STUB_LABEL: "g", STUB_SLEEP: "150" },
                })
                .finally(() => {
                    ended = true;
                });
            await until("the gate's recipe running in the only slot", () => runs(log).some((run) => run.label === "g"));
            const other = start(box, toliArgs("build-slot", "--", "cargo", "build"), {
                STUB_LABEL: "a",
                STUB_SLEEP: "150",
            });
            await until("another build waiting in line for the gate's slot", () =>
                other.stderr.join("").includes("waiting for a heavy-build slot (1 busy)"),
            );
            writeFileSync(`${log}.done-g`, "");
            await until("the other build taking the slot the gate freed", () =>
                runs(log).some((run) => run.label === "a"),
            );
            try {
                await until("the gated push ending while the other build still holds the slot", () => ended);
            } finally {
                writeFileSync(`${log}.done-a`, "");
            }
            const result = await push;
            expect(result.code).toBe(0);
            expect(result.stderr).not.toContain("waiting for a heavy-build slot");
            expect(lines(steps)).toEqual(["guard", "sealed"]);
            const gated = box.git(dir, ["rev-parse", "HEAD"]).trim();
            expect(box.git(dir, ["ls-remote", "origin", "refs/heads/main"]).split(/\s+/)[0]).toBe(gated);
            expect(runs(log).map((run) => run.label)).toEqual(["g", "a"]);
            expect((await other.done).code).toBe(0);
        });

        test("a hook step its gate does not cover still runs its cargo in a slot, through `just` with no shim on PATH", async () => {
            const { box, log, steps } = gateCheckProject();
            // toli's shims under the sandbox's root, where an install keeps them (paths.buildShimsDir()).
            mkdirSync(join(box.root, "bin"), { recursive: true });
            symlinkSync(dirname(CARGO_SHIM), join(box.root, "bin", "shims"));
            box.ok(["gate", "run", "app", "--recipe", "just verify --quick"], {
                env: { ...UNCAPPED, STUB_LABEL: "g" },
            });
            const holder = await holdSlot(box, log);
            const push = box.toliAsync(["push", "app", "--gate", "just verify --quick"], { env: UNCAPPED });
            const queue = join(box.root, "state", "build-slots", "queue");
            await until(
                "the hook's uncovered step waiting in line for the busy slot",
                () => existsSync(queue) && readdirSync(queue).some((name) => name.endsWith(".wait")),
            );
            expect(lines(steps)).toEqual(["guard"]);
            writeFileSync(`${log}.done-a`, "");
            expect((await holder.done).code).toBe(0);
            const result = await push;
            expect(result.code).toBe(0);
            expect(result.stderr).toContain("waiting for a heavy-build slot (1 busy)");
            expect(lines(steps)).toEqual(["guard"]);
            expect(runs(log).find((run) => run.label === "p")).toMatchObject({
                slot: "1",
                jobs: "3",
                args: "test verify",
            });
        });
    });

    /** systemd-run's logged line for one scope: unit toli-build-1-<pid> capped at scopeBox's 512 MB. */
    const SCOPE_LINE =
        /^--user --scope --collect --quiet --unit=toli-build-1-\d+\.scope -p MemoryMax=512M -p MemorySwapMax=0 -- \/bin\/sh /;

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
