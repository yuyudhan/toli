// The OS schedulers behind the tick (schedule.ts) and the helpers (src/helpers/): which one this machine uses, and
// the launchd, systemd --user and crontab primitives both share.
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { platform, run, ToliError, writeTextAtomic } from "../core/util.ts";

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

/** Where launchd user agents live; `TOLI_LAUNCH_AGENTS_DIR` overrides for tests. */
export function launchAgentsDir(): string {
    return process.env.TOLI_LAUNCH_AGENTS_DIR ?? join(homedir(), "Library", "LaunchAgents");
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

/**
 * The bun on PATH (e.g. Homebrew's /opt/homebrew/bin/bun symlink) survives upgrades, unlike the versioned
 * Cellar path in process.execPath; fall back to the running binary when bun is not on PATH.
 */
export function bunPath(): string {
    return Bun.which("bun", { PATH: process.env.PATH ?? "" }) ?? process.execPath;
}

/** PATH for the scheduled tick: the directories of every tool a job may call, resolved now. */
export function schedulePath(): string {
    const dirs: string[] = [dirname(bunPath())];
    for (const tool of ["omp", "git", "gh", "no-mistakes", "ssh"]) {
        const found = Bun.which(tool, { PATH: process.env.PATH ?? "" });
        if (found) dirs.push(dirname(found));
    }
    dirs.push("/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin");
    return [...new Set(dirs)].join(":");
}

function xml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** One launchd user agent. Optional keys are written only when set, in a fixed order. */
export type PlistSpec = {
    label: string;
    program: string[];
    workingDirectory: string;
    env: Record<string, string>;
    /** Run every N seconds. */
    startInterval?: number;
    /** StartCalendarInterval entries (keys Minute, Hour, Day, Month, Weekday); absent keys mean "every". */
    calendar?: Record<string, number>[];
    runAtLoad?: boolean;
    /** Restart whenever it exits (a long-running service). */
    keepAlive?: boolean;
    processType?: "Background";
    nice?: number;
    lowPriorityIO?: boolean;
    stdoutPath: string;
    stderrPath: string;
};

export function renderLaunchdPlist(spec: PlistSpec): string {
    const lines: string[] = [
        "    <key>Label</key>",
        `    <string>${xml(spec.label)}</string>`,
        "    <key>ProgramArguments</key>",
        "    <array>",
        ...spec.program.map((value) => `        <string>${xml(value)}</string>`),
        "    </array>",
        "    <key>WorkingDirectory</key>",
        `    <string>${xml(spec.workingDirectory)}</string>`,
        "    <key>EnvironmentVariables</key>",
        "    <dict>",
        ...Object.entries(spec.env).flatMap(([key, value]) => [
            `        <key>${xml(key)}</key>`,
            `        <string>${xml(value)}</string>`,
        ]),
        "    </dict>",
    ];
    if (spec.startInterval !== undefined)
        lines.push("    <key>StartInterval</key>", `    <integer>${spec.startInterval}</integer>`);
    if (spec.calendar !== undefined) {
        lines.push("    <key>StartCalendarInterval</key>", "    <array>");
        for (const entry of spec.calendar) {
            lines.push("        <dict>");
            for (const [key, value] of Object.entries(entry))
                lines.push(`            <key>${key}</key>`, `            <integer>${value}</integer>`);
            lines.push("        </dict>");
        }
        lines.push("    </array>");
    }
    if (spec.runAtLoad) lines.push("    <key>RunAtLoad</key>", "    <true/>");
    if (spec.keepAlive) lines.push("    <key>KeepAlive</key>", "    <true/>");
    if (spec.processType !== undefined)
        lines.push("    <key>ProcessType</key>", `    <string>${spec.processType}</string>`);
    if (spec.nice !== undefined) lines.push("    <key>Nice</key>", `    <integer>${spec.nice}</integer>`);
    if (spec.lowPriorityIO) lines.push("    <key>LowPriorityIO</key>", "    <true/>");
    lines.push(
        "    <key>StandardOutPath</key>",
        `    <string>${xml(spec.stdoutPath)}</string>`,
        "    <key>StandardErrorPath</key>",
        `    <string>${xml(spec.stderrPath)}</string>`,
    );
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${lines.join("\n")}
</dict>
</plist>
`;
}

export function guiDomain(): string {
    return `gui/${process.getuid?.() ?? 0}`;
}

export function launchctlLoaded(label: string): boolean {
    return run(["launchctl", "print", `${guiDomain()}/${label}`]).code === 0;
}

/** Write a launchd agent and (re)load it: an already-loaded copy is booted out first, so reinstalling is safe. */
export function loadLaunchAgent(label: string, target: string, plist: string): void {
    writeTextAtomic(target, plist);
    if (launchctlLoaded(label)) mustRun(["launchctl", "bootout", `${guiDomain()}/${label}`]);
    mustRun(["launchctl", "bootstrap", guiDomain(), target]);
}

/** Boot out a launchd agent (when loaded) and remove its plist; returns whether anything was there. */
export function unloadLaunchAgent(label: string, target: string): boolean {
    const loaded = launchctlLoaded(label);
    if (loaded) mustRun(["launchctl", "bootout", `${guiDomain()}/${label}`]);
    const present = existsSync(target);
    rmSync(target, { force: true });
    return loaded || present;
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
