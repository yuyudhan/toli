import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Args } from "./args.ts";
import { paths } from "./paths.ts";
import { MateError, out, platform, printJson, run, shellQuote, writeTextAtomic } from "./util.ts";

export const LABEL = "com.yuyudhan.mate.tick";
export const CRON_TAG = "# yuyudhan-mate tick";

/** `MATE_DRY_RUN=1`: print what would be written and run, touching nothing. */
function dryRun(): boolean {
    return process.env.MATE_DRY_RUN === "1";
}

export function plistPath(): string {
    return join(process.env.MATE_LAUNCH_AGENTS_DIR ?? join(homedir(), "Library", "LaunchAgents"), `${LABEL}.plist`);
}

/**
 * The bun on PATH (e.g. Homebrew's /opt/homebrew/bin/bun symlink) survives upgrades, unlike the versioned
 * Cellar path in process.execPath; fall back to the running binary when bun is not on PATH.
 */
function bunPath(): string {
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

export function renderPlist(): string {
    const strings = (values: string[]): string =>
        values.map((value) => `        <string>${xml(value)}</string>`).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${strings([bunPath(), paths.mateBin(), "job", "tick"])}
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(paths.root())}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${xml(schedulePath())}</string>
    </dict>
    <key>StartInterval</key>
    <integer>60</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xml(join(paths.logsDir(), "launchd.out.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${xml(join(paths.logsDir(), "launchd.err.log"))}</string>
</dict>
</plist>
`;
}

export function cronLine(): string {
    const root = paths.root();
    const command = [
        `cd ${shellQuote(root)}`,
        `PATH=${shellQuote(schedulePath())} ${shellQuote(bunPath())} ${shellQuote(paths.mateBin())} job tick >> ${shellQuote(join(paths.logsDir(), "cron.log"))} 2>&1`,
    ].join(" && ");
    return `* * * * * ${command} ${CRON_TAG}`;
}

function guiDomain(): string {
    return `gui/${process.getuid?.() ?? 0}`;
}

function launchctlLoaded(): boolean {
    return run(["launchctl", "print", `${guiDomain()}/${LABEL}`]).code === 0;
}

function readCrontab(): string[] {
    const result = run(["crontab", "-l"]);
    // `crontab -l` exits non-zero with "no crontab for <user>" when none exists yet.
    if (result.code !== 0) return [];
    return result.stdout.split("\n").filter((line) => line !== "");
}

function writeCrontab(lines: string[]): void {
    const text = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
    const result = run(["crontab", "-"], { stdin: text });
    if (result.code !== 0) throw new MateError(`crontab - failed: ${(result.stderr || result.stdout).trim()}`);
}

function mustRun(cmd: string[]): void {
    const result = run(cmd);
    if (result.code !== 0) throw new MateError(`${cmd.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
}

function install(): void {
    mkdirSync(paths.logsDir(), { recursive: true });
    if (platform() === "darwin") {
        const plist = renderPlist();
        const target = plistPath();
        if (dryRun()) {
            out(`# dry run: would write ${target}`);
            out(plist);
            out(`# would run: launchctl bootout ${guiDomain()}/${LABEL} (if loaded)`);
            out(`# would run: launchctl bootstrap ${guiDomain()} ${target}`);
            return;
        }
        writeTextAtomic(target, plist);
        if (launchctlLoaded()) mustRun(["launchctl", "bootout", `${guiDomain()}/${LABEL}`]);
        mustRun(["launchctl", "bootstrap", guiDomain(), target]);
        out(`installed and loaded ${target}: bin/mate job tick runs every minute`);
        return;
    }
    const line = cronLine();
    const lines = [...readCrontab().filter((entry) => !entry.includes(CRON_TAG)), line];
    if (dryRun()) {
        out("# dry run: would install crontab:");
        out(lines.join("\n"));
        return;
    }
    writeCrontab(lines);
    out(`installed crontab line: ${line}`);
}

function uninstall(): void {
    if (platform() === "darwin") {
        const target = plistPath();
        if (dryRun()) {
            out(`# dry run: would run launchctl bootout ${guiDomain()}/${LABEL} (if loaded) and remove ${target}`);
            return;
        }
        if (launchctlLoaded()) mustRun(["launchctl", "bootout", `${guiDomain()}/${LABEL}`]);
        rmSync(target, { force: true });
        out(`uninstalled ${target}`);
        return;
    }
    const lines = readCrontab();
    const kept = lines.filter((entry) => !entry.includes(CRON_TAG));
    if (dryRun()) {
        out("# dry run: would install crontab:");
        out(kept.join("\n"));
        return;
    }
    if (kept.length !== lines.length) writeCrontab(kept);
    out(kept.length !== lines.length ? "removed mate crontab line" : "no mate crontab line installed");
}

export type ScheduleStatus = { scheduler: "launchd" | "crontab"; installed: boolean; loaded: boolean; detail: string };

export function scheduleStatus(): ScheduleStatus {
    if (platform() === "darwin") {
        const target = plistPath();
        const installed = existsSync(target);
        const loaded = launchctlLoaded();
        return { scheduler: "launchd", installed, loaded, detail: target };
    }
    const installed = readCrontab().some((entry) => entry.includes(CRON_TAG));
    return {
        scheduler: "crontab",
        installed,
        loaded: installed,
        detail: installed ? "crontab line present" : "no crontab line",
    };
}

export function scheduleCommand(argv: string[]): void {
    const [sub, ...rest] = argv;
    const args = new Args(rest, { booleans: ["json"] });
    args.maxPositional(0);
    switch (sub) {
        case "install":
            install();
            break;
        case "uninstall":
            uninstall();
            break;
        case "status": {
            const status = scheduleStatus();
            if (args.bool("json")) printJson(status);
            else {
                out(
                    `${status.scheduler}: ${status.installed ? "installed" : "not installed"}, ${status.loaded ? "loaded" : "not loaded"} (${status.detail})`,
                );
            }
            break;
        }
        default:
            throw new MateError("usage: mate schedule install|uninstall|status");
    }
}
