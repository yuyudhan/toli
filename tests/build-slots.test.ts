import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { paths } from "../src/core/paths.ts";
import { capacityFor, type Resources } from "../src/fleet/resources.ts";
import { jawanEnv } from "../src/jawans/env.ts";
import { GIT_ENV, type Sandbox, sandbox, TOLI_BIN } from "./helpers.ts";

const machine = { name: "m1", role: "coordinator" as const };
const CARGO_SHIM = resolve(import.meta.dir, "..", "bin", "shims", "cargo");

describe("build slot capacity", () => {
    test("slots default to one per six cores, each with an even share of the cores as cargo jobs", () => {
        expect(capacityFor(machine, 18)).toMatchObject({ buildSlots: 3, cargoJobs: 6 });
        expect(capacityFor(machine, 4)).toMatchObject({ buildSlots: 1, cargoJobs: 4 });
        expect(capacityFor(machine, 1)).toMatchObject({ buildSlots: 1, cargoJobs: 1 });
    });

    test("explicit buildSlots and cargoJobs override the defaults", () => {
        expect(capacityFor({ ...machine, capacity: { buildSlots: 2 } }, 18)).toMatchObject({
            buildSlots: 2,
            cargoJobs: 9,
        });
        expect(capacityFor({ ...machine, capacity: { cargoJobs: 4 } }, 18)).toMatchObject({
            buildSlots: 3,
            cargoJobs: 4,
        });
        expect(() => capacityFor({ ...machine, capacity: { buildSlots: 0 } }, 8)).toThrow("positive integer");
        expect(() => capacityFor({ ...machine, capacity: { buildSlots: 1.5 } }, 8)).toThrow("positive integer");
    });

    test("a jawan's PATH starts with the cargo shim and its cargo jobs are one slot's share", () => {
        const shims = paths.buildShimsDir();
        const jobs = capacityFor(machine, 18).cargoJobs;
        const env = jawanEnv({ PATH: "/usr/bin:/bin", TOLI_BUILD_SLOT: "2" }, "r1", jobs);
        expect(env.PATH).toBe(`${shims}:/usr/bin:/bin`);
        expect(env.CARGO_BUILD_JOBS).toBe("6");
        expect(env.TOLI_BUILD_SLOT).toBeUndefined();
        expect(jawanEnv({ PATH: `/bin:${shims}` }, "r2", 6).PATH).toBe(`${shims}:/bin`);
        expect(existsSync(join(shims, "cargo"))).toBe(true);
    });

    test("a live-stack project's jawan runs without the shim, its cargo jobs still capped", () => {
        const shims = paths.buildShimsDir();
        const env = jawanEnv({ PATH: `${shims}:/usr/bin`, TOLI_BUILD_SLOT: "1" }, "r1", 6, true);
        expect(env.PATH).toBe("/usr/bin");
        expect(env.CARGO_BUILD_JOBS).toBe("6");
        expect(env.TOLI_BUILD_SLOT).toBeUndefined();
    });
});

describe("jawan environment", () => {
    test("builds into the checkout's own build folder, capped at the machine's cargo jobs", () => {
        const env = jawanEnv(
            { PATH: "/bin", CARGO_TARGET_DIR: "/tmp/jawan-target", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" },
            "r1",
            12,
        );
        expect(env).toEqual({
            PATH: `${paths.buildShimsDir()}:/bin`,
            TOLI_ROLE: "jawan",
            TOLI_RUN_ID: "r1",
            CARGO_BUILD_JOBS: "12",
        });
    });

    test("the machine's cargo jobs replace an inherited build-jobs value", () => {
        expect(jawanEnv({ CARGO_BUILD_JOBS: "18" }, "r1", 12).CARGO_BUILD_JOBS).toBe("12");
    });
});

/** A sandbox whose machine has `slots` build slots of `jobs` cargo jobs, and a stub cargo that logs each run. */
function slotBox(slots: number, jobs: number): { box: Sandbox; log: string } {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    const config = join(box.root, "config", "machine.json");
    const parsed = JSON.parse(readFileSync(config, "utf8")) as Record<string, unknown>;
    writeFileSync(config, JSON.stringify({ ...parsed, capacity: { buildSlots: slots, cargoJobs: jobs } }));
    const log = join(box.root, ".cargo-runs");
    // Each run logs `start|end <label> <ms> <slot> <jobs> <args>`. STUB_SLEEP keeps it busy for up to that many fifths
    // of a second, until `<log>.done-<label>` exists or the process that started it is gone.
    box.stub(
        "cargo",
        [
            "ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
            `echo "start \${STUB_LABEL:-x} $(ms) \${TOLI_BUILD_SLOT:-none} \${CARGO_BUILD_JOBS:-none} $*" >> ${log}`,
            `n="\${STUB_SLEEP:-0}"; while [ "$n" -gt 0 ] && [ ! -e "${log}.done-\${STUB_LABEL:-x}" ] &&`,
            '    kill -0 "$PPID" 2>/dev/null; do sleep 0.2; n=$((n - 1)); done',
            `echo "end \${STUB_LABEL:-x} $(ms)" >> ${log}`,
        ].join("\n"),
    );
    return { box, log };
}

type Started = {
    proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    /** stderr so far, filled as it arrives. */
    stderr: string[];
    done: Promise<{ code: number; stderr: string }>;
};

/** Start `argv` (a toli command or the shim) asynchronously, with the sandbox's environment and the shim on PATH. */
function start(box: Sandbox, argv: string[], env: Record<string, string> = {}): Started {
    const path = [paths.buildShimsDir(), box.stubs, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin"];
    const proc = Bun.spawn(argv, {
        cwd: box.root,
        env: { ...process.env, ...GIT_ENV, PATH: path.join(":"), TOLI_ROOT: box.root, TOLI_BUILD_SLOT: "", ...env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    const stderr: string[] = [];
    const done = (async () => {
        const decoder = new TextDecoder();
        const drain = (async () => {
            for await (const chunk of proc.stderr) stderr.push(decoder.decode(chunk, { stream: true }));
        })();
        const [, , code] = await Promise.all([drain, new Response(proc.stdout).text(), proc.exited]);
        return { code, stderr: stderr.join("") };
    })();
    return { proc, stderr, done };
}

// These tests run real processes that hold real file locks, so they poll for what those processes report (a log
// line, a stderr message) rather than driving a fake clock.
async function until(what: string, ready: () => boolean): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!ready()) {
        if (Date.now() > deadline) throw new Error(`${what} never happened`);
        await Bun.sleep(50);
    }
}

const toliArgs = (...args: string[]): string[] => [process.execPath, TOLI_BIN, ...args];

type Run = { label: string; start: number; end: number; slot: string; jobs: string; args: string };

function runs(log: string): Run[] {
    const lines = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    const started = new Map<string, Run>();
    for (const line of lines) {
        const [kind, label = "", ms = "0", slot = "", jobs = "", ...args] = line.split(" ");
        if (kind === "start")
            started.set(label, { label, start: Number(ms), end: Number.NaN, slot, jobs, args: args.join(" ") });
        else {
            const run = started.get(label);
            if (run) run.end = Number(ms);
        }
    }
    return [...started.values()];
}

/** Start a heavy build labelled `a` that holds its slot for up to 30 s, and wait until it runs. */
async function holdSlot(box: Sandbox, log: string): Promise<Started> {
    const holder = start(box, toliArgs("build-slot", "--", "cargo", "build"), { STUB_LABEL: "a", STUB_SLEEP: "150" });
    await until("the holding build", () => runs(log).some((run) => run.label === "a"));
    return holder;
}

describe("build slots", () => {
    test("with one slot, two heavy builds take turns instead of overlapping", async () => {
        const { box, log } = slotBox(1, 3);
        const first = await holdSlot(box, log);
        const second = start(box, [CARGO_SHIM, "test", "--workspace"], { STUB_LABEL: "b" });
        await until("the waiting message", () => second.stderr.join("").includes("waiting for a heavy-build slot"));
        expect(runs(log).some((run) => run.label === "b")).toBe(false);
        writeFileSync(`${log}.done-a`, "");
        const [one, two] = await Promise.all([first.done, second.done]);
        expect([one.code, two.code]).toEqual([0, 0]);
        const [a, b] = runs(log);
        expect(a).toMatchObject({ label: "a", slot: "1", jobs: "3", args: "build" });
        expect(b).toMatchObject({ label: "b", slot: "1", jobs: "3", args: "test --workspace" });
        expect((b as Run).start).toBeGreaterThanOrEqual((a as Run).end);
        expect(two.stderr.match(/waiting for a heavy-build slot \(1 busy\)/g)).toHaveLength(1);
        expect(one.stderr).not.toContain("waiting");
    }, 30_000);

    test("a nested heavy build inside a slot never waits on it", async () => {
        const { box, log } = slotBox(1, 3);
        const holder = await holdSlot(box, log);
        const nested = start(box, [CARGO_SHIM, "build"], { STUB_LABEL: "b", TOLI_BUILD_SLOT: "1" });
        const viaToli = start(box, toliArgs("build-slot", "--", "cargo", "check"), {
            STUB_LABEL: "c",
            TOLI_BUILD_SLOT: "1",
        });
        const [shimmed, direct] = await Promise.all([nested.done, viaToli.done]);
        holder.proc.kill("SIGKILL");
        expect([shimmed.code, direct.code]).toEqual([0, 0]);
        expect(shimmed.stderr + direct.stderr).not.toContain("waiting");
        expect(runs(log).find((run) => run.label === "b")).toMatchObject({ slot: "1", args: "build" });
        expect(runs(log).find((run) => run.label === "c")).toMatchObject({ slot: "1", args: "check" });
    }, 30_000);

    test("light cargo commands pass straight through while every slot is busy", async () => {
        const { box, log } = slotBox(1, 3);
        const holder = await holdSlot(box, log);
        const version = start(box, [CARGO_SHIM, "--version"], { STUB_LABEL: "v" });
        const metadata = start(box, [CARGO_SHIM, "metadata", "--format-version", "1"], { STUB_LABEL: "m" });
        const [v, m] = await Promise.all([version.done, metadata.done]);
        holder.proc.kill("SIGKILL");
        expect([v.code, m.code]).toEqual([0, 0]);
        expect(v.stderr + m.stderr).not.toContain("waiting");
        expect(runs(log).find((run) => run.label === "v")).toMatchObject({ slot: "none", args: "--version" });
        expect(runs(log).find((run) => run.label === "m")).toMatchObject({ slot: "none" });
    }, 30_000);

    test("two copies of the shim on PATH find the real cargo instead of each other", async () => {
        const { box, log } = slotBox(1, 3);
        const copy = join(box.root, ".other-shims");
        mkdirSync(copy);
        copyFileSync(CARGO_SHIM, join(copy, "cargo"));
        chmodSync(join(copy, "cargo"), 0o755);
        const path = [copy, paths.buildShimsDir(), box.stubs, dirname(process.execPath), "/usr/bin", "/bin"];
        const version = start(box, [join(copy, "cargo"), "--version"], { STUB_LABEL: "v", PATH: path.join(":") });
        const result = await version.done;
        expect(result.code).toBe(0);
        expect(runs(log).find((run) => run.label === "v")).toMatchObject({ slot: "none", args: "--version" });
    }, 30_000);

    test("a killed holder frees its slot, and resources shows slots busy of total", async () => {
        const { box, log } = slotBox(1, 3);
        const holder = await holdSlot(box, log);
        const busy = JSON.parse(box.ok(["resources", "--json"])) as Resources;
        expect(busy).toMatchObject({ buildSlots: 1, buildSlotsBusy: 1 });
        expect(box.ok(["resources"])).toContain("builds 1/1");
        const waiter = start(box, [CARGO_SHIM, "build"], { STUB_LABEL: "b" });
        await until("the waiting message", () => waiter.stderr.join("").includes("waiting for a heavy-build slot"));
        expect(runs(log).some((run) => run.label === "b")).toBe(false);
        holder.proc.kill("SIGKILL");
        const result = await waiter.done;
        expect(result.code).toBe(0);
        expect(runs(log).find((run) => run.label === "b")).toMatchObject({ slot: "1" });
        expect(JSON.parse(box.ok(["resources", "--json"]))).toMatchObject({ buildSlotsBusy: 0 });
    }, 30_000);
});
