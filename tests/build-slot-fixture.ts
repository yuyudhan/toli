// Shared fixture of the heavy-build slot tests (tests/build-slots.test.ts, tests/build-slot-queue.test.ts): a sandbox
// with a stub cargo that logs each run, and helpers that start real `bin/toli build-slot` processes.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { paths } from "../src/core/paths.ts";
import { GIT_ENV, type Sandbox, sandbox, TOLI_BIN } from "./helpers.ts";

export const CARGO_SHIM = resolve(import.meta.dir, "..", "bin", "shims", "cargo");

/** A sandbox whose machine has `slots` build slots of `jobs` cargo jobs, and a stub cargo that logs each run. */
export function slotBox(slots: number, jobs: number): { box: Sandbox; log: string } {
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

export type Started = {
    proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    /** stderr so far, filled as it arrives. */
    stderr: string[];
    done: Promise<{ code: number; stderr: string }>;
};

/**
 * Start `argv` (a toli command or the shim) asynchronously, with the sandbox's environment and the shim on PATH. Builds
 * start without a systemd scope unless `env` turns it on (`TOLI_BUILD_SCOPE: ""`), so no test creates a real unit.
 */
export function start(box: Sandbox, argv: string[], env: Record<string, string> = {}): Started {
    const path = [paths.buildShimsDir(), box.stubs, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin"];
    const proc = Bun.spawn(argv, {
        cwd: box.root,
        env: {
            ...process.env,
            ...GIT_ENV,
            PATH: path.join(":"),
            TOLI_ROOT: box.root,
            TOLI_BUILD_SLOT: "",
            TOLI_BUILD_SCOPE: "off",
            ...env,
        },
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
export async function until(what: string, ready: () => boolean): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!ready()) {
        if (Date.now() > deadline) throw new Error(`${what} never happened`);
        await Bun.sleep(50);
    }
}

export const toliArgs = (...args: string[]): string[] => [process.execPath, TOLI_BIN, ...args];

export type Run = { label: string; start: number; end: number; slot: string; jobs: string; args: string };

/** The stub cargo's runs from its log, in the order they started. */
export function runs(log: string): Run[] {
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
export async function holdSlot(box: Sandbox, log: string): Promise<Started> {
    const holder = start(box, toliArgs("build-slot", "--", "cargo", "build"), { STUB_LABEL: "a", STUB_SLEEP: "150" });
    await until("the holding build", () => runs(log).some((run) => run.label === "a"));
    return holder;
}
