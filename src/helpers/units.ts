import { homedir } from "node:os";
import { join } from "node:path";
import type { Cron } from "../core/cron.ts";
import { paths } from "../core/paths.ts";
import { platform, run, shellQuote, ToliError } from "../core/util.ts";
import { renderLaunchdPlist, schedulePath } from "../jobs/schedule.ts";
import type { Helper } from "./registry.ts";

/** How helpers get scheduled here: launchd on macOS, systemd --user on Linux when available, else crontab. */
export type HelperScheduler = "launchd" | "systemd" | "crontab";

/** `TOLI_HELPER_SCHEDULER` forces one (tests, or a Linux box whose systemd user session is unusable). */
export function helperScheduler(): HelperScheduler {
    const forced = process.env.TOLI_HELPER_SCHEDULER;
    if (forced === "launchd" || forced === "systemd" || forced === "crontab") return forced;
    if (forced !== undefined && forced !== "")
        throw new ToliError(`TOLI_HELPER_SCHEDULER must be launchd, systemd or crontab (got "${forced}")`);
    if (platform() === "darwin") return "launchd";
    return run(["systemctl", "--user", "show-environment"]).code === 0 ? "systemd" : "crontab";
}

export function helperLabel(name: string): string {
    return `com.toli.helper.${name}`;
}

export const HELPER_LABEL_PREFIX = "com.toli.helper.";
export const HELPER_CRON_PREFIX = "# toli helper ";
export const HELPER_UNIT_PREFIX = "toli-helper-";

export function helperCronTag(name: string): string {
    return `${HELPER_CRON_PREFIX}${name}`;
}

export function helperUnit(name: string): string {
    return `${HELPER_UNIT_PREFIX}${name}`;
}

/** Where systemd user units live; `TOLI_SYSTEMD_USER_DIR` overrides for tests. */
export function systemdUserDir(): string {
    const override = process.env.TOLI_SYSTEMD_USER_DIR;
    if (override) return override;
    return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user");
}

/** The environment a scheduled helper runs with: the scheduled PATH unless the helper sets its own. */
function helperEnv(helper: Helper): Record<string, string> {
    return { PATH: schedulePath(), ...helper.env };
}

function isWildcard(values: Set<number>, size: number): boolean {
    return values.size === size;
}

/** Days with both day-of-month and day-of-week restricted mean OR in cron but AND in launchd/systemd: refuse. */
function assertPortableDays(cron: Cron, expr: string): void {
    if (!cron.domStar && !cron.dowStar)
        throw new ToliError(
            `cron "${expr}": restrict day-of-month or day-of-week, not both (launchd and systemd cannot express cron's OR rule)`,
        );
}

/** launchd StartCalendarInterval entries for a cron expression: one dict per combination of restricted fields. */
export function cronToCalendar(cron: Cron, expr: string): Record<string, number>[] {
    assertPortableDays(cron, expr);
    const fields: [string, number[] | null][] = [
        ["Minute", isWildcard(cron.minutes, 60) ? null : [...cron.minutes]],
        ["Hour", isWildcard(cron.hours, 24) ? null : [...cron.hours]],
        ["Day", cron.domStar ? null : [...cron.daysOfMonth]],
        ["Month", isWildcard(cron.months, 12) ? null : [...cron.months]],
        ["Weekday", cron.dowStar ? null : [...cron.daysOfWeek]],
    ];
    let entries: Record<string, number>[] = [{}];
    for (const [key, values] of fields) {
        if (values === null) continue;
        entries = entries.flatMap((entry) => values.map((value) => ({ ...entry, [key]: value })));
    }
    if (entries.length > 1000)
        throw new ToliError(`cron "${expr}" expands to ${entries.length} launchd calendar entries; simplify it`);
    return entries;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** systemd OnCalendar for a cron expression, e.g. "Mon,Fri *-*-* 9:0:00". */
export function cronToOnCalendar(cron: Cron, expr: string): string {
    assertPortableDays(cron, expr);
    const list = (values: Set<number>, wildcard: boolean): string =>
        wildcard ? "*" : [...values].sort((a, b) => a - b).join(",");
    const days = cron.dowStar
        ? ""
        : `${[...cron.daysOfWeek]
              .sort((a, b) => a - b)
              .map((day) => WEEKDAYS[day])
              .join(",")} `;
    const month = list(cron.months, isWildcard(cron.months, 12));
    const dom = list(cron.daysOfMonth, cron.domStar);
    const hour = list(cron.hours, isWildcard(cron.hours, 24));
    const minute = list(cron.minutes, isWildcard(cron.minutes, 60));
    return `${days}*-${month}-${dom} ${hour}:${minute}:00`;
}

/** The crontab schedule for an `every` interval, when one exists exactly. */
export function everyToCron(seconds: number, text: string): string {
    const minutes = seconds / 60;
    if (Number.isInteger(minutes)) {
        if (minutes === 1) return "* * * * *";
        if (minutes < 60 && 60 % minutes === 0) return `*/${minutes} * * * *`;
        const hours = minutes / 60;
        if (hours === 24) return "0 0 * * *";
        if (Number.isInteger(hours) && hours < 24 && 24 % hours === 0)
            return hours === 1 ? "0 * * * *" : `0 */${hours} * * *`;
    }
    throw new ToliError(`every ${text} has no exact crontab form; use a "cron" schedule for this helper`);
}

export function renderHelperPlist(helper: Helper): string {
    const log = paths.helperLog(helper.name);
    const always = helper.schedule.kind === "always";
    return renderLaunchdPlist({
        label: helperLabel(helper.name),
        program: [helper.exec, ...helper.args],
        workingDirectory: paths.root(),
        env: helperEnv(helper),
        ...(helper.schedule.kind === "every" ? { startInterval: helper.schedule.seconds } : {}),
        ...(helper.schedule.kind === "cron"
            ? { calendar: cronToCalendar(helper.schedule.cron, helper.schedule.expr) }
            : {}),
        runAtLoad: helper.runAtLoad || always,
        keepAlive: always,
        ...(always ? { processType: "Background" as const } : {}),
        ...(helper.nice === undefined ? {} : { nice: helper.nice }),
        lowPriorityIO: helper.lowPriorityIO,
        stdoutPath: log,
        stderrPath: log,
    });
}

export function renderHelperCronLine(helper: Helper): string {
    if (helper.schedule.kind === "always")
        throw new ToliError(
            `helper "${helper.name}" is "always running", which crontab cannot keep alive: use launchd or systemd`,
        );
    const when =
        helper.schedule.kind === "every"
            ? everyToCron(helper.schedule.seconds, helper.schedule.text)
            : helper.schedule.expr;
    const env = Object.entries(helperEnv(helper)).map(([key, value]) => `${key}=${shellQuote(value)}`);
    const nice = helper.nice === undefined ? [] : ["nice", "-n", String(helper.nice)];
    const program = [helper.exec, ...helper.args].map(shellQuote);
    const command = [`cd ${shellQuote(paths.root())}`, ["env", ...env, ...nice, ...program].join(" ")].join(" && ");
    return `${when} ${command} >> ${shellQuote(paths.helperLog(helper.name))} 2>&1 ${helperCronTag(helper.name)}`;
}

/** Quote one word for a systemd unit file (its own syntax: double quotes, and % and $ doubled). */
function systemdWord(word: string): string {
    const escaped = word.replace(/%/g, "%%").replace(/\$/g, "$$$$");
    if (/^[A-Za-z0-9_./:=@+,%$-]+$/.test(escaped)) return escaped;
    return `"${escaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export type SystemdUnits = { service: string; timer: string | null };

export function renderHelperSystemd(helper: Helper): SystemdUnits {
    const log = paths.helperLog(helper.name).replace(/%/g, "%%");
    const always = helper.schedule.kind === "always";
    const description = helper.description ? `: ${helper.description}` : "";
    const service = [
        "[Unit]",
        `Description=toli helper ${helper.name}${description.replace(/%/g, "%%")}`,
        "",
        "[Service]",
        `Type=${always ? "simple" : "oneshot"}`,
        `WorkingDirectory=${systemdWord(paths.root())}`,
        ...Object.entries(helperEnv(helper)).map(([key, value]) => `Environment=${systemdWord(`${key}=${value}`)}`),
        `ExecStart=${[helper.exec, ...helper.args].map(systemdWord).join(" ")}`,
        ...(helper.nice === undefined ? [] : [`Nice=${helper.nice}`]),
        ...(helper.lowPriorityIO ? ["IOSchedulingClass=idle"] : []),
        `StandardOutput=append:${log}`,
        `StandardError=append:${log}`,
        ...(always ? ["Restart=always", "RestartSec=10", "", "[Install]", "WantedBy=default.target"] : []),
        "",
    ].join("\n");
    const schedule = helper.schedule;
    if (schedule.kind === "always") return { service, timer: null };
    const trigger =
        schedule.kind === "every"
            ? [
                  `OnActiveSec=${helper.runAtLoad ? 1 : schedule.seconds}s`,
                  `OnUnitActiveSec=${schedule.seconds}s`,
                  "AccuracySec=1s",
              ]
            : [
                  `OnCalendar=${cronToOnCalendar(schedule.cron, schedule.expr)}`,
                  "Persistent=true",
                  ...(helper.runAtLoad ? ["OnActiveSec=1s"] : []),
              ];
    const timer = [
        "[Unit]",
        `Description=Schedule for toli helper ${helper.name}`,
        "",
        "[Timer]",
        ...trigger,
        `Unit=${helperUnit(helper.name)}.service`,
        "",
        "[Install]",
        "WantedBy=timers.target",
        "",
    ].join("\n");
    return { service, timer };
}
