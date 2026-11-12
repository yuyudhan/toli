// The OS schedulers behind the tick (schedule.ts) and the helpers (src/helpers/): which one this machine uses, and
// the systemd --user and crontab primitives both share (launchd's are in launchd.ts).
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { platform, run, ToliError } from "../core/util.ts";

/** `TOLI_DRY_RUN=1`: print what would be written and run, touching nothing. */
export function dryRun(): boolean {
    return process.env.TOLI_DRY_RUN === "1";
}

/** What runs the tick and the helpers here: launchd on macOS, systemd --user on Linux when it works, else crontab. */
export type Scheduler = "launchd" | "systemd" | "crontab";

/** `TOLI_SCHEDULER` forces one (tests, or a Linux box whose systemd user session is unusable). */
export function osScheduler(): Scheduler {
    const forced = process.env.TOLI_SCHEDULER;
    if (forced === "launchd" || forced === "systemd" || forced === "crontab") return forced;
    if (forced !== undefined && forced !== "")
        throw new ToliError(`TOLI_SCHEDULER must be launchd, systemd or crontab (got "${forced}")`);
    if (platform() === "darwin") return "launchd";
    return run(systemctl("show-environment")).code === 0 ? "systemd" : "crontab";
}

/** Where systemd user units live; `TOLI_SYSTEMD_USER_DIR` overrides for tests. */
export function systemdUserDir(): string {
    const override = process.env.TOLI_SYSTEMD_USER_DIR;
    if (override) return override;
    return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user");
}

export function systemctl(...args: string[]): string[] {
    return ["systemctl", "--user", ...args];
}

/** Quote one word for a systemd unit file (its own syntax: double quotes, and % and $ doubled). */
export function systemdWord(word: string): string {
    const escaped = word.replace(/%/g, "%%").replace(/\$/g, "$$$$");
    if (/^[A-Za-z0-9_./:=@+,%$-]+$/.test(escaped)) return escaped;
    return `"${escaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A path setting such as WorkingDirectory= or append:: taken verbatim except for % specifiers, so never quoted. */
export function systemdPath(path: string): string {
    return path.replace(/%/g, "%%");
}

/** One Environment= assignment: % specifiers doubled, quoted when needed; $ is literal there (unlike ExecStart=). */
export function systemdEnv(key: string, value: string): string {
    const assignment = `${key}=${value}`.replace(/%/g, "%%");
    if (!/[\s"'\\]/.test(assignment)) return assignment;
    return `"${assignment.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * PATH without bun's `bun-node-*` temp dirs: bun prepends one (under /tmp or $TMPDIR, holding bun and node shims)
 * when `bin/toli` runs from toli's root, and a reboot deletes it, so nothing installed may point into it.
 */
function stablePath(): string {
    return (process.env.PATH ?? "")
        .split(":")
        .filter((dir) => !basename(dir).startsWith("bun-node-"))
        .join(":");
}

/**
 * The bun on the stable PATH (e.g. Homebrew's /opt/homebrew/bin/bun symlink) survives upgrades, unlike the
 * versioned Cellar path in process.execPath; fall back to the running binary when bun is not on that PATH.
 */
export function bunPath(): string {
    return Bun.which("bun", { PATH: stablePath() }) ?? process.execPath;
}

/**
 * PATH for the scheduled tick: the directories of every tool a job may call, resolved now. Jawans that the tick
 * starts from the queue inherit it, so it covers their build tools too (cargo/rustc, just, node).
 */
export function schedulePath(): string {
    const path = stablePath();
    const dirs: string[] = [dirname(bunPath())];
    for (const tool of ["omp", "git", "gh", "no-mistakes", "ssh", "cargo", "just", "node"]) {
        const found = Bun.which(tool, { PATH: path });
        if (found) dirs.push(dirname(found));
    }
    dirs.push("/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin");
    return [...new Set(dirs)].join(":");
}

export function readCrontab(): string[] {
    const result = run(["crontab", "-l"]);
    // `crontab -l` exits non-zero with "no crontab for <user>" when none exists yet.
    if (result.code !== 0) return [];
    return result.stdout.split("\n").filter((line) => line !== "");
}

export function writeCrontab(lines: string[]): void {
    const text = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
    const result = run(["crontab", "-"], { stdin: text });
    if (result.code !== 0) throw new ToliError(`crontab - failed: ${(result.stderr || result.stdout).trim()}`);
}

export function mustRun(cmd: string[]): void {
    const result = run(cmd);
    if (result.code !== 0) throw new ToliError(`${cmd.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
}
