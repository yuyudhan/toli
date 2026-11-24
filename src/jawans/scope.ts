// Each jawan in its own systemd scope (docs/sardars.md "Jawans report to their own lead"). On Linux the lead service
// is a systemd user service: anything it starts lives in its cgroup, so systemd-oomd (or a service restart) killing
// that cgroup took the lead and every jawan it had spawned with it. A jawan's supervisor therefore starts through
// `systemd-run --user --scope --unit toli-supervisor-<run id>`, and the supervisor starts the harness through
// `systemd-run --user --scope --unit toli-jawan-<run id>` (`toli-jawan-<run id>-<n>` for the n-th attempt): two
// cgroups under the user manager. An OOM kill takes the jawan's scope (the harness, its tools and builds) and leaves
// the small supervisor, which records the signal and what the journal says sent it (src/jawans/death.ts); with both
// in one scope (before T1255) oomd took the supervisor too and the run ended without an outcome. `spawn` returns only
// once systemd-run has moved the supervisor into its scope: a caller that is itself a systemd unit (a helper's oneshot,
// a scheduled job) may exit right after, and systemd then kills whatever is left in that unit's cgroup, a supervisor
// still waiting on systemd-run's D-Bus round trip included. Where systemd-run or the user manager is missing
// (crontab-only boxes, containers), both start as before; a supervisor scope systemd-run cannot make fails the start,
// and a harness scope it cannot make (no user session bus over ssh) starts the harness unscoped. On macOS the
// supervisor and the harness are each detached into their own session and process group (setsid), which launchd
// leaves alone when it stops or restarts the lead's job, and a signal to the harness's group never reaches the
// supervisor.
//
// Heavy builds (`bin/toli build-slot`, src/fleet/build-slots.ts) start the same way, each in its own
// `toli-build-<slot>-<pid>.scope` with a `MemoryMax`, no swap and no `MemoryHigh` (`buildScopeArgv`), so an OOM kill
// takes the build and not the session that ran it. Without `MemorySwapMax=0` a build at its cap pushes the rest of
// its memory into swap instead; once the machine's swap fills, systemd-oomd kills the biggest swap user (the whole
// build) and the cap never held anything (2026-11-13: MemoryMax set, the scope's 140 processes killed by oomd).
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { platform, run, ToliError } from "../core/util.ts";
import { procFile } from "../fleet/resources.ts";

/** The unit name of a run's harness scope: `attempt` 1 is the run's first harness, a limit retry is attempt 2. */
export function scopeUnit(runId: string, attempt = 1): string {
    return attempt <= 1 ? `toli-jawan-${runId}.scope` : `toli-jawan-${runId}-${attempt}.scope`;
}

/** The unit name of a run's supervisor scope. */
export function supervisorScopeUnit(runId: string): string {
    return `toli-supervisor-${runId}.scope`;
}

/** The user manager's runtime dir (its private socket lives there), or null when there is none to talk to. */
function userRuntimeDir(): string | null {
    const uid = process.getuid?.();
    const dir = process.env.XDG_RUNTIME_DIR ?? (uid === undefined ? undefined : `/run/user/${uid}`);
    if (dir === undefined || !existsSync(join(dir, "systemd", "private"))) return null;
    return dir;
}

/** A command line: the program, then its arguments. */
export type Argv = [string, ...string[]];

/** A command line to start and the extra environment it needs. */
export type Scoped = { argv: Argv; env: Record<string, string> };

/** systemd-run and the user manager's runtime dir: what starting a command in its own user scope needs. */
type UserScope = { systemdRun: string; runtimeDir: string };

/** systemd-run and a user manager on Linux, unless `optOut` is set to `off`; null when no scope can be made. */
function userScope(optOut: string): UserScope | null {
    if (platform() !== "linux" || process.env[optOut] === "off") return null;
    const systemdRun = Bun.which("systemd-run");
    const runtimeDir = userRuntimeDir();
    if (systemdRun === null || runtimeDir === null) return null;
    return { systemdRun, runtimeDir };
}

/** A scoped command line, its unit, and the file its command creates once systemd-run has made the scope. */
export type MarkedScoped = Scoped & { unit: string; startedFile: string };

/**
 * `systemd-run` starting `argv` in user scope `unit`: inside the scope `/bin/sh` creates `startedFile` and execs `argv`,
 * so the pid spawned is the command's, and `startedFile` exists only once systemd-run has made the scope and moved the
 * process into it.
 */
function markedScopeArgv(scope: UserScope, unit: string, description: string, argv: Argv, startedFile: string): Argv {
    return [
        scope.systemdRun,
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        `--unit=${unit}`,
        `--description=${description}`,
        "--",
        "/bin/sh",
        "-c",
        ': > "$0" && exec "$@"',
        startedFile,
        ...argv,
    ];
}

/**
 * The argv and extra environment that start `argv` as run `runId`'s supervisor in its own systemd scope,
 * `supervisorScopeUnit(runId)`: on Linux when systemd-run and a user manager are there; else null (start `argv`
 * unchanged). `TOLI_JAWAN_SCOPE=off` turns it off (tests). Inside the scope `/bin/sh` creates `startedFile` and execs
 * the supervisor, so the pid spawned is the supervisor's; `awaitScope` waits for `startedFile`.
 */
export function inSupervisorScope(runId: string, argv: Argv, startedFile: string): MarkedScoped | null {
    const scope = userScope("TOLI_JAWAN_SCOPE");
    if (scope === null) return null;
    const unit = supervisorScopeUnit(runId);
    return {
        argv: markedScopeArgv(scope, unit, "toli jawan supervisor", argv, startedFile),
        env: { XDG_RUNTIME_DIR: scope.runtimeDir },
        unit,
        startedFile,
    };
}

/** How long systemd-run may take to make a scope (its own D-Bus calls time out after 25 s). */
const SCOPE_START_TIMEOUT_MS = 60_000;
/** How often the started file is looked for, and how many looks between checks that systemd-run is still there. */
const SCOPE_POLL_MS = 25;
const SCOPE_LIVENESS_EVERY = 8;

/** Whether `pid` has exited: gone, or a zombie its parent (this process, blocked here) has not reaped yet. */
function exited(pid: number): boolean {
    const ps = run(["ps", "-o", "stat=", "-p", String(pid)]);
    if (ps.code === 127) return false; // No ps to ask: the timeout decides.
    const state = ps.stdout.trim();
    return state === "" || state.startsWith("Z");
}

/**
 * Wait until the command systemd-run started as `pid` is inside its scope (`scoped.startedFile` exists), then remove
 * the file. Throws when systemd-run exits without making the scope, or after `SCOPE_START_TIMEOUT_MS` (the process is
 * then killed, so it never runs unaccounted for). Synchronous: callers start runs under the slots lock.
 */
export function awaitScope(pid: number, scoped: MarkedScoped): void {
    const deadline = Date.now() + SCOPE_START_TIMEOUT_MS;
    for (let look = 1; ; look++) {
        if (existsSync(scoped.startedFile)) {
            rmSync(scoped.startedFile, { force: true });
            return;
        }
        if (look % SCOPE_LIVENESS_EVERY === 0 && exited(pid) && !existsSync(scoped.startedFile))
            throw new ToliError(`systemd-run could not start ${scoped.unit} (see its supervisor.log)`);
        if (Date.now() > deadline) {
            try {
                process.kill(pid, "SIGKILL");
            } catch {
                // Already gone.
            }
            throw new ToliError(`systemd-run did not start ${scoped.unit} within ${SCOPE_START_TIMEOUT_MS / 1000}s`);
        }
        Bun.sleepSync(SCOPE_POLL_MS);
    }
}

/**
 * The argv and extra environment that start harness `argv` of run `runId`'s `attempt` in its own systemd scope,
 * `scopeUnit(runId, attempt)`: on Linux when systemd-run and a user manager are there; else null.
 * `TOLI_JAWAN_SCOPE=off` turns it off (tests). Inside the scope `/bin/sh` creates `startedFile` and execs the harness,
 * so the pid spawned is the harness's, it leads its own process group, and its exit code or killing signal is the
 * harness's; a missing `startedFile` after it exited means the scope was never made and the harness never ran.
 */
export function inJawanScope(runId: string, attempt: number, argv: Argv, startedFile: string): MarkedScoped | null {
    const scope = userScope("TOLI_JAWAN_SCOPE");
    if (scope === null) return null;
    const unit = scopeUnit(runId, attempt);
    return {
        argv: markedScopeArgv(scope, unit, "toli jawan", argv, startedFile),
        env: { XDG_RUNTIME_DIR: scope.runtimeDir },
        unit,
        startedFile,
    };
}

/** The unit name of a heavy build's scope: its slot's number (0 without a slot) and the build-slot process's pid. */
export function buildScopeUnit(slot: number, pid: number): string {
    return `toli-build-${slot}-${pid}.scope`;
}

/** Whether a /proc/<pid>/cgroup text puts the process inside a toli build scope (a build started within a build). */
export function inToliBuildCgroup(cgroup: string): boolean {
    return /\/toli-build-[^/\s]+\.scope(?:\/|$)/m.test(cgroup);
}

/** This process's cgroup membership ("" where /proc is unavailable, e.g. macOS). */
function ownCgroup(): string {
    try {
        return readFileSync(procFile(join("self", "cgroup")), "utf8");
    } catch {
        return "";
    }
}

/**
 * `systemd-run` starting `argv` in scope `unit` with memory cap `memoryMaxMB` (0: no cap, still its own scope): its
 * `MemoryMax` and `MemorySwapMax=0`, so the cap bounds the build's RAM and swap together. No `MemoryHigh`: with swap
 * off, a build past it has only page cache to give back, and once that is gone the kernel throttles its allocations
 * indefinitely instead of failing it (two 8.5 GB rustc jobs frozen 100+ minutes at a 90% `MemoryHigh` while the
 * machine had 7 GB free). At `MemoryMax` the kernel reclaims the same cache and then OOM-kills inside the scope, so a
 * build either runs at full speed up to its cap or fails at once. `--` ends systemd-run's options, so a command whose
 * arguments start with `-` reaches the command unchanged.
 */
export function buildScopeArgv(systemdRun: string, unit: string, memoryMaxMB: number, argv: Argv): Argv {
    const limit = memoryMaxMB > 0 ? ["-p", `MemoryMax=${memoryMaxMB}M`, "-p", "MemorySwapMax=0"] : [];
    return [systemdRun, "--user", "--scope", "--collect", "--quiet", `--unit=${unit}`, ...limit, "--", ...argv];
}

/**
 * A heavy build's scoped command line, the file its command creates once systemd-run has made the scope, and the
 * socket of the build's own sccache server (its `SCCACHE_SERVER_UDS`).
 */
export type BuildScoped = Scoped & { startedFile: string; sccacheSocket: string };

/**
 * The argv and extra environment that start heavy build `argv` in its own systemd scope, `toli-build-<slot>-<pid>`,
 * capped at `memoryMaxMB`: on Linux when systemd-run and a user manager are there and this process is not inside a
 * toli build scope already (a nested build stays in its parent's); else null. `TOLI_BUILD_SCOPE=off` turns it off
 * (tests). Inside the scope `/bin/sh` creates `startedFile` and then execs the build, so the pid in the scope is the
 * build's and its exit code or killing signal is the build's; a missing `startedFile` after systemd-run exits means
 * the scope was never made (no user session bus over ssh, no lingering) and the build never ran.
 *
 * The build's sccache gets its own server socket, `SCCACHE_SERVER_UDS` at `toli-sccache-<slot>-<pid>.sock` in the
 * user manager's runtime dir (T24). sccache's server, not cargo, starts every rustc, so the rustc lives in whatever
 * cgroup the server does, and a client with no server running starts one in its own cgroup. With the one shared
 * server, the first build to compile through it started it inside that build's scope: every later build's rustc ran
 * under that first scope's `MemoryMax` (a raised `capacity.buildMemoryMax` never reached it) until the server was
 * stopped. A server of the build's own starts inside the build's scope, so its rustc keep to the build's cap, and the
 * shared server is never started from inside a build scope; the server shares the machine's cache folder, so cache
 * hits carry over. src/fleet/build-slots.ts `stopBuildSccache` stops it once the build ends.
 */
export function inBuildScope(slot: number, memoryMaxMB: number, argv: Argv, startedFile: string): BuildScoped | null {
    const scope = userScope("TOLI_BUILD_SCOPE");
    if (scope === null || inToliBuildCgroup(ownCgroup())) return null;
    const marked: Argv = ["/bin/sh", "-c", ': > "$0" && exec "$@"', startedFile, ...argv];
    const sccacheSocket = join(scope.runtimeDir, `toli-sccache-${slot}-${process.pid}.sock`);
    return {
        argv: buildScopeArgv(scope.systemdRun, buildScopeUnit(slot, process.pid), memoryMaxMB, marked),
        env: { XDG_RUNTIME_DIR: scope.runtimeDir, SCCACHE_SERVER_UDS: sccacheSocket },
        startedFile,
        sccacheSocket,
    };
}
