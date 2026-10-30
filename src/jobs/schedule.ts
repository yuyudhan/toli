// `bin/toli schedule`: the per-minute tick (`bin/toli job tick`) in this machine's OS scheduler (os-scheduler.ts).
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Args } from "../core/args.ts";
import { paths } from "../core/paths.ts";
import { out, printJson, run, shellQuote, ToliError, writeTextAtomic } from "../core/util.ts";
import {
    bunPath,
    dryRun,
    guiDomain,
    launchAgentsDir,
    launchctlLoaded,
    loadLaunchAgent,
    mustRun,
    osScheduler,
    readCrontab,
    renderLaunchdPlist,
    type Scheduler,
    schedulePath,
    systemctl,
    systemdEnv,
    systemdPath,
    systemdUserDir,
    systemdWord,
    unloadLaunchAgent,
    writeCrontab,
} from "./os-scheduler.ts";

export const LABEL = "com.toli.tick";
export const CRON_TAG = "# toli tick";
/** The tick's systemd user units: `toli-tick.service` run by `toli-tick.timer`. */
const TICK_UNIT = "toli-tick";

export function plistPath(): string {
    return join(launchAgentsDir(), `${LABEL}.plist`);
}

function tickUnitFiles(): { service: string; timer: string } {
    const base = join(systemdUserDir(), TICK_UNIT);
    return { service: `${base}.service`, timer: `${base}.timer` };
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

/** The tick as systemd user units: a oneshot service and a timer that starts it a second after load, then every 60s. */
export function renderTickSystemd(): { service: string; timer: string } {
    const log = systemdPath(join(paths.logsDir(), "systemd.log"));
    const service = [
        "[Unit]",
        "Description=toli tick (bin/toli job tick)",
        "",
        "[Service]",
        "Type=oneshot",
        `WorkingDirectory=${systemdPath(paths.root())}`,
        `Environment=${systemdEnv("PATH", schedulePath())}`,
        `ExecStart=${[bunPath(), paths.toliBin(), "job", "tick"].map(systemdWord).join(" ")}`,
        `StandardOutput=append:${log}`,
        `StandardError=append:${log}`,
        "",
    ].join("\n");
    const timer = [
        "[Unit]",
        "Description=Run the toli tick every minute",
        "",
        "[Timer]",
        "OnActiveSec=1s",
        "OnUnitActiveSec=60s",
        "AccuracySec=1s",
        `Unit=${TICK_UNIT}.service`,
        "",
        "[Install]",
        "WantedBy=timers.target",
        "",
    ].join("\n");
    return { service, timer };
}

/**
 * Drop a `# toli tick` crontab line once launchd or systemd runs the tick: a machine first set up on crontab (v0.1.0
 * on Linux) would otherwise tick twice a minute. Prints what it removed; dry run only says what it would remove.
 */
function dropCronTick(): void {
    const lines = readCrontab();
    const kept = lines.filter((entry) => !entry.includes(CRON_TAG));
    if (kept.length === lines.length) return;
    if (dryRun()) {
        out("# dry run: would remove the toli tick line from the crontab");
        return;
    }
    writeCrontab(kept);
    out("removed the leftover toli tick line from the crontab");
}

function install(): void {
    mkdirSync(paths.logsDir(), { recursive: true });
    const scheduler = osScheduler();
    if (scheduler === "launchd") {
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
        dropCronTick();
        return;
    }
    if (scheduler === "systemd") {
        const units = renderTickSystemd();
        const files = tickUnitFiles();
        const timer = `${TICK_UNIT}.timer`;
        if (dryRun()) {
            out(`# dry run: would write ${files.service}`);
            out(units.service);
            out(`# dry run: would write ${files.timer}`);
            out(units.timer);
            out(
                `# would run: systemctl --user daemon-reload && systemctl --user enable ${timer} && systemctl --user restart ${timer}`,
            );
            return;
        }
        writeTextAtomic(files.service, units.service);
        writeTextAtomic(files.timer, units.timer);
        mustRun(systemctl("daemon-reload"));
        mustRun(systemctl("enable", timer));
        mustRun(systemctl("restart", timer));
        out(`installed and started ${files.timer}: bin/toli job tick runs every minute`);
        dropCronTick();
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
    const scheduler = osScheduler();
    if (scheduler === "launchd") {
        const target = plistPath();
        if (dryRun()) {
            out(`# dry run: would run launchctl bootout ${guiDomain()}/${LABEL} (if loaded) and remove ${target}`);
            return;
        }
        unloadLaunchAgent(LABEL, target);
        out(`uninstalled ${target}`);
        return;
    }
    if (scheduler === "systemd") {
        const files = tickUnitFiles();
        if (dryRun()) {
            out(`# dry run: would run systemctl --user disable --now ${TICK_UNIT}.timer and remove ${files.timer}`);
            return;
        }
        if (!existsSync(files.timer) && !existsSync(files.service)) {
            out("no toli tick units installed");
            dropCronTick();
            return;
        }
        // A timer systemd no longer knows is not an error here; the files go either way.
        run(systemctl("disable", "--now", `${TICK_UNIT}.timer`));
        rmSync(files.timer, { force: true });
        rmSync(files.service, { force: true });
        mustRun(systemctl("daemon-reload"));
        out(`uninstalled ${files.timer}`);
        dropCronTick();
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

export type ScheduleStatus = {
    scheduler: Scheduler;
    installed: boolean;
    loaded: boolean;
    detail: string;
    /** The `bin/toli` an installed tick runs when that is another toli checkout; null when it runs this one. */
    otherBin: string | null;
    /** launchd or systemd runs the tick and the crontab still holds a toli tick line: two ticks a minute. */
    cronLeftover: boolean;
};

/**
 * The one per-machine tick is shared by every clone (same label/tag/unit): which `bin/toli` does it run, if not
 * ours? `ours` is how this checkout's `bin/toli` appears in the installed plist, crontab line or unit.
 */
function otherTickBin(installedText: string, ours: string): string | null {
    if (installedText.includes(ours)) return null;
    return /[^\s<>'"]*\/bin\/toli(?=[\s<'"])/.exec(installedText)?.[0] ?? "another toli checkout";
}

export function scheduleStatus(): ScheduleStatus {
    const scheduler = osScheduler();
    const bin = paths.toliBin();
    const cronLines = readCrontab().filter((entry) => entry.includes(CRON_TAG));
    const cronLeftover = scheduler !== "crontab" && cronLines.length > 0;
    if (scheduler === "launchd") {
        const target = plistPath();
        const installed = existsSync(target);
        const loaded = launchctlLoaded(LABEL);
        const otherBin = installed ? otherTickBin(readFileSync(target, "utf8"), `<string>${bin}</string>`) : null;
        return { scheduler, installed, loaded, detail: target, otherBin, cronLeftover };
    }
    if (scheduler === "systemd") {
        const files = tickUnitFiles();
        const installed = existsSync(files.service) && existsSync(files.timer);
        const loaded = run(systemctl("is-active", `${TICK_UNIT}.timer`)).stdout.trim() === "active";
        const otherBin = installed ? otherTickBin(readFileSync(files.service, "utf8"), ` ${systemdWord(bin)} `) : null;
        return { scheduler, installed, loaded, detail: files.timer, otherBin, cronLeftover };
    }
    const installed = cronLines.length > 0;
    return {
        scheduler,
        installed,
        loaded: installed,
        detail: installed ? "crontab line present" : "no crontab line",
        otherBin: installed ? otherTickBin(cronLines.join("\n"), ` ${shellQuote(bin)} `) : null,
        cronLeftover,
    };
}

/** The warning for a leftover crontab tick; shared by `schedule status`, doctor and the setup checklist. */
export const CRON_LEFTOVER_WARNING =
    "crontab still holds a toli tick line besides this tick (a leftover crontab tick line: two ticks a minute); bin/toli schedule install removes it";

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
                if (status.otherBin !== null)
                    out(
                        `warn: the tick runs ${status.otherBin}, not this checkout (bin/toli schedule install moves it here)`,
                    );
                if (status.cronLeftover) out(`warn: ${CRON_LEFTOVER_WARNING}`);
            }
            break;
        }
        default:
            throw new ToliError("usage: toli schedule install|uninstall|status");
    }
}
