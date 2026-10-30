import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Args } from "../core/args.ts";
import { paths } from "../core/paths.ts";
import { out, platform, printJson, run, shellQuote, ToliError, writeTextAtomic } from "../core/util.ts";

export const LABEL = "com.toli.tick";
export const CRON_TAG = "# toli tick";

/** `TOLI_DRY_RUN=1`: print what would be written and run, touching nothing. */
export function dryRun(): boolean {
    return process.env.TOLI_DRY_RUN === "1";
}

/** Where launchd user agents live; `TOLI_LAUNCH_AGENTS_DIR` overrides for tests. */
export function launchAgentsDir(): string {
    return process.env.TOLI_LAUNCH_AGENTS_DIR ?? join(homedir(), "Library", "LaunchAgents");
}

export function plistPath(): string {
    return join(launchAgentsDir(), `${LABEL}.plist`);
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

export function renderPlist(): string {
    return renderLaunchdPlist({
        label: LABEL,
        program: [bunPath(), paths.toliBin(), "job", "tick"],
        workingDirectory: paths.root(),
        env: { PATH: schedulePath() },
        startInterval: 60,
        runAtLoad: true,
        stdoutPath: join(paths.logsDir(), "launchd.out.log"),
        stderrPath: join(paths.logsDir(), "launchd.err.log"),
    });
}

export function cronLine(): string {
    const root = paths.root();
    const command = [
        `cd ${shellQuote(root)}`,
        `PATH=${shellQuote(schedulePath())} ${shellQuote(bunPath())} ${shellQuote(paths.toliBin())} job tick >> ${shellQuote(join(paths.logsDir(), "cron.log"))} 2>&1`,
    ].join(" && ");
    return `* * * * * ${command} ${CRON_TAG}`;
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
        loadLaunchAgent(LABEL, target, plist);
        out(`installed and loaded ${target}: bin/toli job tick runs every minute`);
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
        unloadLaunchAgent(LABEL, target);
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
    out(kept.length !== lines.length ? "removed toli crontab line" : "no toli crontab line installed");
}

export type ScheduleStatus = { scheduler: "launchd" | "crontab"; installed: boolean; loaded: boolean; detail: string };

export function scheduleStatus(): ScheduleStatus {
    if (platform() === "darwin") {
        const target = plistPath();
        const installed = existsSync(target);
        const loaded = launchctlLoaded(LABEL);
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
            throw new ToliError("usage: toli schedule install|uninstall|status");
    }
}
