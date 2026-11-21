// The lead service in the OS scheduler (docs/sardars.md): a launchd agent (or a LaunchDaemon already installed), a
// systemd user service or a per-minute crontab line running `bin/toli lead run`, and `lead status`.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../core/paths.ts";
import { out, run, shellQuote, writeTextAtomic } from "../core/util.ts";
import { sessionFile } from "../jawans/launch.ts";
import {
    launchctlLoaded,
    launchdDetail,
    launchdDomain,
    launchdLoadPlan,
    launchdPlistPath,
    launchdRemovalPlan,
    loadLaunchdJob,
    unloadLaunchdJob,
} from "../jobs/launchd.ts";
import { renderLaunchdPlist } from "../jobs/launchd-plist.ts";
import {
    bunPath,
    dryRun,
    mustRun,
    osScheduler,
    readCrontab,
    type Scheduler,
    schedulePath,
    systemctl,
    systemdEnv,
    systemdPath,
    systemdUserDir,
    systemdWord,
    writeCrontab,
} from "../jobs/os-scheduler.ts";
import { LEAD_TURN_ENV } from "./full.ts";
import { type SilentSession, silentSession, silentSessionText } from "./idle-session.ts";
import { interactiveLeadPid, readLeadState, turnPid } from "./lead-state.ts";
import { silentAlertFor } from "./silent-alert.ts";

export const LEAD_LABEL = "com.toli.lead";
export const LEAD_CRON_TAG = "# toli lead";
/** The lead's systemd user service: `toli-lead.service`. */
export const LEAD_UNIT = "toli-lead.service";

export function leadPlistPath(): string {
    return launchdPlistPath(LEAD_LABEL);
}

export function leadUnitPath(): string {
    return join(systemdUserDir(), LEAD_UNIT);
}

function serviceProgram(): string[] {
    return [bunPath(), paths.toliBin(), "lead", "run"];
}

/** The launchd agent: started at load and kept alive, at full priority (turns run omp, which jawans wait on). */
export function renderLeadPlist(): string {
    return renderLaunchdPlist({
        label: LEAD_LABEL,
        program: serviceProgram(),
        workingDirectory: paths.root(),
        env: { PATH: schedulePath() },
        runAtLoad: true,
        keepAlive: true,
        processType: "Interactive",
        stdoutPath: paths.leadLog(),
        stderrPath: paths.leadLog(),
    });
}

/**
 * The systemd user service: a long-running `lead run`, restarted whenever it exits. `KillMode=control-group`:
 * stopping the unit ends `lead run` and everything left in its cgroup (a headless turn's omp and what that started,
 * the peer listener), so a stopped lead never wakes again to start work (T1763: under `KillMode=process` a
 * `lead run` left in the cgroup outlived `systemctl --user stop` and spawned jawans). Jawans run in scopes of
 * their own (src/jawans/scope.ts), outside this cgroup, so a stop or restart leaves them running.
 */
export function renderLeadUnit(): string {
    const log = systemdPath(paths.leadLog());
    return [
        "[Unit]",
        "Description=toli lead (bin/toli lead run)",
        "",
        "[Service]",
        "Type=simple",
        `WorkingDirectory=${systemdPath(paths.root())}`,
        `Environment=${systemdEnv("PATH", schedulePath())}`,
        `ExecStart=${serviceProgram().map(systemdWord).join(" ")}`,
        "Restart=always",
        "KillMode=control-group",
        "RestartSec=10",
        `StandardOutput=append:${log}`,
        `StandardError=append:${log}`,
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ].join("\n");
}

/** Where neither launchd nor systemd works: one pass a minute (single-flight, so a long turn is never doubled). */
export function leadCronLine(): string {
    const command = [
        `cd ${shellQuote(paths.root())}`,
        `PATH=${shellQuote(schedulePath())} ${shellQuote(bunPath())} ${shellQuote(paths.toliBin())} lead run --once >> ${shellQuote(paths.leadLog())} 2>&1`,
    ].join(" && ");
    return `* * * * * ${command} ${LEAD_CRON_TAG}`;
}

/** A systemd user service stops at logout unless lingering is on; say so once at install. */
function lingerHint(): void {
    const user = process.env.USER ?? "";
    const result = run(["loginctl", "show-user", user, "--property=Linger"]);
    if (result.code === 0 && result.stdout.trim() === "Linger=yes") return;
    out(`note: the lead service stops at logout until lingering is on: loginctl enable-linger ${user}`.trimEnd());
}

export function installLeadService(): void {
    mkdirSync(paths.logsDir(), { recursive: true });
    const scheduler = osScheduler();
    if (scheduler === "launchd") {
        const plist = renderLeadPlist();
        const target = leadPlistPath();
        if (dryRun()) {
            out(`# dry run: would write ${target}`);
            out(plist);
            for (const line of launchdLoadPlan(LEAD_LABEL, { restartUnchanged: true })) out(line);
            return;
        }
        const when = launchdDomain(LEAD_LABEL) === "system" ? "at every boot" : "at every login";
        const action = loadLaunchdJob(LEAD_LABEL, plist, { restartUnchanged: true });
        out(
            action === "restarted"
                ? `${target} is unchanged and ${LEAD_LABEL} is loaded: restarted it in place (launchctl kickstart -k)`
                : `installed and loaded ${target}: the lead service runs now and ${when}`,
        );
        return;
    }
    if (scheduler === "systemd") {
        const unit = renderLeadUnit();
        const target = leadUnitPath();
        if (dryRun()) {
            out(`# dry run: would write ${target}`);
            out(unit);
            out(
                `# would run: systemctl --user daemon-reload && systemctl --user enable ${LEAD_UNIT} && systemctl --user restart ${LEAD_UNIT}`,
            );
            return;
        }
        writeTextAtomic(target, unit);
        mustRun(systemctl("daemon-reload"));
        mustRun(systemctl("enable", LEAD_UNIT));
        if (process.env[LEAD_TURN_ENV] === "headless") {
            // This command runs inside the unit's own headless turn: a restart would kill the turn and this command
            // with it. The loop exits after the turn once a newer runtime is installed (`upgrade`), and systemd starts
            // it again on the reloaded unit.
            out(
                `installed ${target}: the lead service runs it from its next restart (a headless turn never restarts its own service)`,
            );
            return;
        }
        // restart, not start: a reinstall must pick up the rewritten unit.
        mustRun(systemctl("restart", LEAD_UNIT));
        out(`installed and started ${target}: the lead service runs now and at every login`);
        lingerHint();
        return;
    }
    const line = leadCronLine();
    const lines = [...readCrontab().filter((entry) => !entry.includes(LEAD_CRON_TAG)), line];
    if (dryRun()) {
        out("# dry run: would install crontab:");
        out(lines.join("\n"));
        return;
    }
    writeCrontab(lines);
    out(`installed crontab line: ${line}`);
}

export function uninstallLeadService(): void {
    const scheduler = osScheduler();
    if (scheduler === "launchd") {
        const target = leadPlistPath();
        if (dryRun()) {
            out(launchdRemovalPlan(LEAD_LABEL));
            return;
        }
        out(unloadLaunchdJob(LEAD_LABEL) ? `uninstalled ${target}` : "no lead service installed");
        return;
    }
    if (scheduler === "systemd") {
        const target = leadUnitPath();
        if (dryRun()) {
            out(`# dry run: would run systemctl --user disable --now ${LEAD_UNIT} and remove ${target}`);
            return;
        }
        if (!existsSync(target)) {
            out("no lead service installed");
            return;
        }
        // A unit systemd no longer knows is not an error here; the file goes either way.
        run(systemctl("disable", "--now", LEAD_UNIT));
        rmSync(target, { force: true });
        mustRun(systemctl("daemon-reload"));
        out(`uninstalled ${target}`);
        return;
    }
    const lines = readCrontab();
    const kept = lines.filter((entry) => !entry.includes(LEAD_CRON_TAG));
    if (dryRun()) {
        out("# dry run: would install crontab:");
        out(kept.join("\n"));
        return;
    }
    if (kept.length !== lines.length) writeCrontab(kept);
    out(kept.length !== lines.length ? "removed the toli lead crontab line" : "no lead crontab line installed");
}

export type LeadServiceStatus = { scheduler: Scheduler; installed: boolean; running: boolean; detail: string };

/** Whether the lead service is installed in the scheduler in use, and running (a crontab line runs every minute). */
export function leadServiceStatus(): LeadServiceStatus {
    const scheduler = osScheduler();
    if (scheduler === "launchd")
        return {
            scheduler,
            installed: existsSync(leadPlistPath()),
            running: launchctlLoaded(LEAD_LABEL),
            detail: launchdDetail(LEAD_LABEL),
        };
    if (scheduler === "systemd") {
        const target = leadUnitPath();
        const running = run(systemctl("is-active", LEAD_UNIT)).stdout.trim() === "active";
        return { scheduler, installed: existsSync(target), running, detail: target };
    }
    const installed = readCrontab().some((entry) => entry.includes(LEAD_CRON_TAG));
    return { scheduler, installed, running: installed, detail: installed ? "crontab line present" : "no crontab line" };
}

export type LeadStatus = LeadServiceStatus & {
    /** The interactive lead session open on this machine (registered by the omp extension, or `lead attach`). */
    interactivePid: number | null;
    /** The lead conversation: the newest session file in state/lead/sessions/. */
    sessionFile: string | null;
    lastTurnAt: string | null;
    lastExit: number | null;
    turns: number;
    /** The process running a headless turn right now. */
    turnPid: number | null;
    /** A failed turn's wake text waits in state/lead/pending.md for the next pass. */
    pendingWake: boolean;
    /**
     * The interactive session when it has taken no wake for `lead.silentSessionMinutes`, with the coordinator alerted
     * about it (`alertedTo` null on the coordinator itself) and when; both null before the tick has alerted.
     */
    silent: (SilentSession & { alertedTo: string | null; alertedAt: string | null }) | null;
};

export function leadStatus(): LeadStatus {
    const state = readLeadState();
    const silent = silentSession();
    const alert = silent === null ? null : silentAlertFor(silent);
    return {
        ...leadServiceStatus(),
        interactivePid: interactiveLeadPid(),
        sessionFile: sessionFile(paths.leadSessionsDir()),
        lastTurnAt: state.lastTurnAt,
        lastExit: state.lastExit,
        turns: state.turns,
        turnPid: turnPid(state),
        pendingWake: existsSync(paths.leadPending()),
        silent: silent === null ? null : { ...silent, alertedTo: alert?.to ?? null, alertedAt: alert?.at ?? null },
    };
}

export function printStatus(status: LeadStatus): void {
    const service = status.installed ? `installed, ${status.running ? "running" : "not running"}` : "not installed";
    out(`service: ${status.scheduler} ${service} (${status.detail})`);
    out(`interactive: ${status.interactivePid === null ? "none" : `pid ${status.interactivePid}`}`);
    out(`conversation: ${status.sessionFile ?? "none yet"}`);
    out(
        status.lastTurnAt === null
            ? "last turn: none yet"
            : `last turn: ${status.lastTurnAt}, exit ${status.lastExit ?? "?"} (${status.turns} turn${status.turns === 1 ? "" : "s"})`,
    );
    if (status.turnPid !== null) out(`turn in progress: pid ${status.turnPid}`);
    out(`pending wake: ${status.pendingWake ? paths.leadPending() : "none"}`);
    if (status.silent !== null) {
        const { alertedTo, alertedAt } = status.silent;
        let alerted = "the next tick raises it";
        if (alertedAt !== null)
            alerted =
                alertedTo === null
                    ? `logged at ${alertedAt} (this is the coordinator: nobody to alert)`
                    : `${alertedTo} alerted at ${alertedAt}`;
        out(`silent: interactive session ${silentSessionText(status.silent)}; ${alerted}`);
    }
    if (!status.installed) out("warn: the lead service is not installed (bin/toli lead install)");
}
