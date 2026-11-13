// Each jawan in its own systemd scope (docs/sardars.md "Jawans report to their own lead"). On Linux the lead service
// is a systemd user service: anything it starts lives in its cgroup, so systemd-oomd (or a service restart) killing
// that cgroup took the lead and every jawan it had spawned with it. A jawan's supervisor therefore starts through
// `systemd-run --user --scope --unit toli-supervisor-<run id>`, and the supervisor starts the harness through
// `systemd-run --user --scope --unit toli-jawan-<run id>` (`toli-jawan-<run id>-<n>` for the n-th attempt): two
// cgroups under the user manager. An OOM kill takes the jawan's scope (the harness, its tools and builds) and leaves
// the small supervisor, which records the signal and what the journal says sent it (src/jawans/death.ts); with both
// in one scope (before T1255) oomd took the supervisor too and the run ended without an outcome. Where systemd-run or
// the user manager is missing (crontab-only boxes, containers), both start as before; a harness scope systemd-run
// cannot make (no user session bus over ssh) starts the harness unscoped. On macOS the supervisor and the harness are
// each detached into their own session and process group (setsid), which launchd leaves alone when it stops or
// restarts the lead's job, and a signal to the harness's group never reaches the supervisor.
//
// Heavy builds (`bin/toli build-slot`, src/fleet/build-slots.ts) start the same way, each in its own
// `toli-build-<slot>-<pid>.scope` with a `MemoryMax`, a `MemoryHigh` below it and no swap, so an OOM kill takes the
// build and not the session that ran it. Without `MemorySwapMax=0` a build at its cap pushes the rest of its memory
// into swap instead; once the machine's swap fills, systemd-oomd kills the biggest swap user (the whole build) and
// the cap never held anything (itlinux8, 2026-11-13: MemoryMax set, the scope's 140 processes killed by oomd).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "../core/util.ts";
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

/**
 * The argv and extra environment that start `argv` as run `runId`'s supervisor: wrapped in its own systemd scope on
 * Linux when systemd-run and a user manager are there, else unchanged. `TOLI_JAWAN_SCOPE=off` turns it off (tests).
 * `systemd-run --scope` execs the command itself, so the pid spawned is the supervisor's.
 */
export function inSupervisorScope(runId: string, argv: Argv): Scoped {
    const scope = userScope("TOLI_JAWAN_SCOPE");
    if (scope === null) return { argv, env: {} };
    return {
        argv: [
            scope.systemdRun,
            "--user",
            "--scope",
            "--quiet",
            "--collect",
            `--unit=${supervisorScopeUnit(runId)}`,
            "--description=toli jawan supervisor",
            "--",
            ...argv,
        ],
        env: { XDG_RUNTIME_DIR: scope.runtimeDir },
    };
}

/** A harness's scoped command line, its unit, and the file its command creates once systemd-run has made the scope. */
export type HarnessScoped = Scoped & { unit: string; startedFile: string };

/**
 * The argv and extra environment that start harness `argv` of run `runId`'s `attempt` in its own systemd scope,
 * `scopeUnit(runId, attempt)`: on Linux when systemd-run and a user manager are there; else null.
 * `TOLI_JAWAN_SCOPE=off` turns it off (tests). Inside the scope `/bin/sh` creates `startedFile` and execs the harness,
 * so the pid spawned is the harness's, it leads its own process group, and its exit code or killing signal is the
 * harness's; a missing `startedFile` after it exited means the scope was never made and the harness never ran.
 */
export function inJawanScope(runId: string, attempt: number, argv: Argv, startedFile: string): HarnessScoped | null {
    const scope = userScope("TOLI_JAWAN_SCOPE");
    if (scope === null) return null;
    const unit = scopeUnit(runId, attempt);
    return {
        argv: [
            scope.systemdRun,
            "--user",
            "--scope",
            "--quiet",
            "--collect",
            `--unit=${unit}`,
            "--description=toli jawan",
            "--",
            "/bin/sh",
            "-c",
            ': > "$0" && exec "$@"',
            startedFile,
            ...argv,
        ],
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

/** `MemoryHigh` as a share of `MemoryMax`: past it the kernel throttles and reclaims the build, before any OOM kill. */
const MEMORY_HIGH_SHARE = 0.9;

/**
 * `systemd-run` starting `argv` in scope `unit` with memory cap `memoryMaxMB` (0: no cap, still its own scope): its
 * `MemoryMax`, a `MemoryHigh` at `MEMORY_HIGH_SHARE` of it and `MemorySwapMax=0`, so the cap bounds the build's RAM
 * and swap together. `--` ends systemd-run's options, so a command whose arguments start with `-` reaches the command
 * unchanged.
 */
export function buildScopeArgv(systemdRun: string, unit: string, memoryMaxMB: number, argv: Argv): Argv {
    const limit =
        memoryMaxMB > 0
            ? [
                  "-p",
                  `MemoryHigh=${Math.max(1, Math.floor(memoryMaxMB * MEMORY_HIGH_SHARE))}M`,
                  "-p",
                  `MemoryMax=${memoryMaxMB}M`,
                  "-p",
                  "MemorySwapMax=0",
              ]
            : [];
    return [systemdRun, "--user", "--scope", "--collect", "--quiet", `--unit=${unit}`, ...limit, "--", ...argv];
}

/** A heavy build's scoped command line, and the file its command creates once systemd-run has made the scope. */
export type BuildScoped = Scoped & { startedFile: string };

/**
 * The argv and extra environment that start heavy build `argv` in its own systemd scope, `toli-build-<slot>-<pid>`,
 * capped at `memoryMaxMB`: on Linux when systemd-run and a user manager are there and this process is not inside a
 * toli build scope already (a nested build stays in its parent's); else null. `TOLI_BUILD_SCOPE=off` turns it off
 * (tests). Inside the scope `/bin/sh` creates `startedFile` and then execs the build, so the pid in the scope is the
 * build's and its exit code or killing signal is the build's; a missing `startedFile` after systemd-run exits means
 * the scope was never made (no user session bus over ssh, no lingering) and the build never ran.
 */
export function inBuildScope(slot: number, memoryMaxMB: number, argv: Argv, startedFile: string): BuildScoped | null {
    const scope = userScope("TOLI_BUILD_SCOPE");
    if (scope === null || inToliBuildCgroup(ownCgroup())) return null;
    const marked: Argv = ["/bin/sh", "-c", ': > "$0" && exec "$@"', startedFile, ...argv];
    return {
        argv: buildScopeArgv(scope.systemdRun, buildScopeUnit(slot, process.pid), memoryMaxMB, marked),
        env: { XDG_RUNTIME_DIR: scope.runtimeDir },
        startedFile,
    };
}
