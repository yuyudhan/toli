// Shared fixture of the heavy-build slot tests (tests/build-slots.test.ts, tests/build-slot-queue.test.ts,
// tests/build-slot-push.test.ts): a sandbox with a stub cargo that logs each run, helpers that start real
// `bin/toli build-slot` processes, and a fake Linux user manager whose systemd-run logs each scope it makes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
 * Start `argv` (a toli command or the shim) asynchronously in `cwd`, with the sandbox's environment and the shim on
 * PATH. Builds start without a systemd scope unless `env` turns it on (`TOLI_BUILD_SCOPE: ""`), so no test creates a
 * real unit.
 */
export function start(box: Sandbox, argv: string[], env: Record<string, string> = {}, cwd = box.root): Started {
    const path = [paths.buildShimsDir(), box.stubs, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin"];
    const proc = Bun.spawn(argv, {
        cwd,
        env: {
            ...process.env,
            ...GIT_ENV,
            PATH: path.join(":"),
            TOLI_ROOT: box.root,
            TOLI_BUILD_SLOT: "",
            TOLI_BUILD_SCOPE: "off",
            TOLI_PROCESS_TABLE: join(box.root, ".process-table"),
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
export async function until(what: string, ready: () => boolean, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
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

/** A systemd-run that logs its arguments and execs the command after `--`, as one that makes the scope does. */
export const workingSystemdRun = (scopeLog: string): string =>
    [
        `printf '%s\\n' "$*" >> "${scopeLog}"`,
        'while [ "$#" -gt 0 ]; do arg=$1; shift; [ "$arg" = "--" ] && break; done',
        'exec "$@"',
    ].join("\n");

/** A systemd-run that fails as it does over ssh without a user session bus: before running the command, exit 1. */
export const noBusSystemdRun = (scopeLog: string): string =>
    [`printf '%s\\n' "$*" >> "${scopeLog}"`, "echo 'Failed to connect to bus: No medium found' >&2", "exit 1"].join(
        "\n",
    );

/** The cgroup of a process in a terminal's scope, outside any toli build scope. */
export const TERMINAL_CGROUP = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/vte-spawn-1.scope\n";

/**
 * Linux with a user manager (a fake runtime dir with its private socket), a systemd-run stub (by default
 * `workingSystemdRun`), a `cgroup` for this process (/proc/self/cgroup) and a memory cap of 512 MB, on one build slot
 * of three cargo jobs.
 */
export function scopeBox(
    cgroup: string,
    systemdRun = workingSystemdRun,
): { box: Sandbox; log: string; scopeLog: string; env: Record<string, string> } {
    const { box, log } = slotBox(1, 3);
    const config = join(box.root, "config", "machine.json");
    const parsed = JSON.parse(readFileSync(config, "utf8")) as { capacity: Record<string, number> };
    writeFileSync(config, JSON.stringify({ ...parsed, capacity: { ...parsed.capacity, buildMemoryMax: 512 } }));
    const runtime = join(box.root, ".run-user");
    mkdirSync(join(runtime, "systemd"), { recursive: true });
    writeFileSync(join(runtime, "systemd", "private"), "");
    const proc = join(box.root, ".proc");
    mkdirSync(join(proc, "self"), { recursive: true });
    writeFileSync(join(proc, "self", "cgroup"), cgroup);
    const scopeLog = join(box.root, ".systemd-run.log");
    box.stub("systemd-run", systemdRun(scopeLog));
    const env = { TOLI_PLATFORM: "linux", TOLI_BUILD_SCOPE: "", XDG_RUNTIME_DIR: runtime, TOLI_PROC_DIR: proc };
    return { box, log, scopeLog, env };
}

/** The systemd-run stub's logged argument lines, one per scope it was asked to make. */
export const scopeLines = (scopeLog: string): string[] =>
    existsSync(scopeLog) ? readFileSync(scopeLog, "utf8").trim().split("\n") : [];
