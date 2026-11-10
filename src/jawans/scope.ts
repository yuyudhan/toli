// Each jawan in its own systemd scope (docs/sardars.md "Jawans report to their own lead"). On Linux the lead service
// is a systemd user service: anything it starts lives in its cgroup, so systemd-oomd (or a service restart) killing
// that cgroup took the lead and every jawan it had spawned with it. A jawan's supervisor therefore starts through
// `systemd-run --user --scope --unit toli-jawan-<run id>`: the scope is its own cgroup under the user manager, and an
// OOM kill takes that one jawan. Where systemd-run or the user manager is missing (crontab-only boxes, containers),
// the supervisor starts as before. On macOS the supervisor is detached into its own process group (setsid), which
// launchd leaves alone when it stops or restarts the lead's job.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { platform } from "../core/util.ts";

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

/**
 * The argv and extra environment that start `argv` as run `runId`'s supervisor: wrapped in its own systemd scope on
 * Linux when systemd-run and a user manager are there, else unchanged. `TOLI_JAWAN_SCOPE=off` turns it off (tests).
 * `systemd-run --scope` execs the command itself, so the pid spawned is the supervisor's.
 */
export function inJawanScope(runId: string, argv: Argv): { argv: Argv; env: Record<string, string> } {
    if (platform() !== "linux" || process.env.TOLI_JAWAN_SCOPE === "off") return { argv, env: {} };
    const systemdRun = Bun.which("systemd-run");
    const runtimeDir = userRuntimeDir();
    if (systemdRun === null || runtimeDir === null) return { argv, env: {} };
    return {
        argv: [
            systemdRun,
            "--user",
            "--scope",
            "--quiet",
            "--collect",
            `--unit=${scopeUnit(runId)}`,
            "--description=toli jawan",
            ...argv,
        ],
        env: { XDG_RUNTIME_DIR: runtimeDir },
    };
}
