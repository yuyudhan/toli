// Each jawan in its own systemd scope (docs/sardars.md "Jawans report to their own lead"). On Linux the lead service
// is a systemd user service: anything it starts lives in its cgroup, so systemd-oomd (or a service restart) killing
// that cgroup took the lead and every jawan it had spawned with it. A jawan's supervisor therefore starts through
// `systemd-run --user --scope --unit toli-jawan-<run id>`: the scope is its own cgroup under the user manager, and an
// OOM kill takes that one jawan. Where systemd-run or the user manager is missing (crontab-only boxes, containers),
// the supervisor starts as before. On macOS the supervisor is detached into its own process group (setsid), which
// launchd leaves alone when it stops or restarts the lead's job.
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

/** The unit name of a run's scope. */
export function scopeUnit(runId: string): string {
    return `toli-jawan-${runId}.scope`;
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
export function inJawanScope(runId: string, argv: Argv): Scoped {
    const scope = userScope("TOLI_JAWAN_SCOPE");
    if (scope === null) return { argv, env: {} };
    return {
        argv: [
            scope.systemdRun,
            "--user",
            "--scope",
            "--quiet",
            "--collect",
            `--unit=${scopeUnit(runId)}`,
            "--description=toli jawan",
            ...argv,
        ],
        env: { XDG_RUNTIME_DIR: scope.runtimeDir },
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
