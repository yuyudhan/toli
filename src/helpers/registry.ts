import { isAbsolute, join } from "node:path";
import { type Cron, parseCron } from "../core/cron.ts";
import { paths } from "../core/paths.ts";
import { isJsonObject, isValidName, readJson, ToliError } from "../core/util.ts";

/**
 * local/helpers.json: the private, per-installation registry of machine helpers (scripts the user's own agents
 * write into local/scripts/). toli only reads it and installs schedules for it; it is never committed.
 */
export type HelperSchedule =
    /** Run every N seconds (launchd StartInterval, a systemd timer, or the matching crontab step). */
    | { kind: "every"; seconds: number; text: string }
    /** A 5-field cron expression (launchd StartCalendarInterval, systemd OnCalendar, or a crontab line). */
    | { kind: "cron"; expr: string; cron: Cron }
    /** Keep one process running, restarting it when it exits (launchd KeepAlive, systemd Restart=always). */
    | { kind: "always" };

export type Helper = {
    name: string;
    description: string;
    /** Absolute path of the program: an absolute `exec`, or a repo-relative one resolved against the toli root. */
    exec: string;
    /** Arguments, passed as-is; the working directory is the toli root, so repo-relative paths work. */
    args: string[];
    schedule: HelperSchedule;
    /** Also run once as soon as the schedule is loaded (and at login/boot). */
    runAtLoad: boolean;
    /** Scheduling priority 0-19 (higher is gentler); unset leaves the default. */
    nice: number | undefined;
    /** Low-priority disk I/O (launchd LowPriorityIO, systemd IOSchedulingClass=idle). */
    lowPriorityIO: boolean;
    /** Extra environment; PATH here replaces the default scheduled PATH. */
    env: Record<string, string>;
    /** Platforms to install on (process.platform values); unset means every platform. */
    platforms: string[] | undefined;
    enabled: boolean;
};

const KEYS: readonly string[] = [
    "name",
    "description",
    "exec",
    "args",
    "schedule",
    "runAtLoad",
    "nice",
    "lowPriorityIO",
    "env",
    "platforms",
    "enabled",
];

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** "90s", "15m", "1h", "1d" → seconds. */
export function parseDuration(text: string): number {
    const match = /^(\d+)([smhd])$/.exec(text.trim());
    const amount = match ? Number(match[1]) : 0;
    const unit = match?.[2];
    if (unit === undefined || amount <= 0)
        throw new ToliError(`bad duration "${text}": use a positive number with s, m, h or d (e.g. 15m)`);
    return amount * (UNIT_SECONDS[unit] ?? 1);
}

function stringList(value: unknown, where: string): string[] {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
        throw new ToliError(`${where} must be an array of strings`);
    return value as string[];
}

function optionalBool(value: unknown, where: string, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") throw new ToliError(`${where} must be true or false`);
    return value;
}

function parseSchedule(value: unknown, where: string): HelperSchedule {
    if (!isJsonObject(value))
        throw new ToliError(`${where} must be an object: {"every": "15m"}, {"cron": "..."} or {"always": true}`);
    const keys = Object.keys(value);
    if (keys.length !== 1)
        throw new ToliError(
            `${where} needs exactly one of "every", "cron" or "always" (got ${keys.join(", ") || "none"})`,
        );
    const [key] = keys;
    const raw = value[key as string];
    if (key === "every") {
        if (typeof raw !== "string") throw new ToliError(`${where}.every must be a duration string such as "15m"`);
        return { kind: "every", seconds: parseDuration(raw), text: raw.trim() };
    }
    if (key === "cron") {
        if (typeof raw !== "string") throw new ToliError(`${where}.cron must be a 5-field cron string`);
        return { kind: "cron", expr: raw.trim(), cron: parseCron(raw) };
    }
    if (key === "always") {
        if (raw !== true) throw new ToliError(`${where}.always must be true`);
        return { kind: "always" };
    }
    throw new ToliError(`${where}: unknown schedule "${key}" (use every, cron or always)`);
}

function parseHelper(value: unknown, index: number, root: string, source: string): Helper {
    const where = `${source} helpers[${index}]`;
    if (!isJsonObject(value)) throw new ToliError(`${where} must be an object`);
    for (const key of Object.keys(value))
        if (!KEYS.includes(key)) throw new ToliError(`${where}: unknown key "${key}" (allowed: ${KEYS.join(", ")})`);
    const name = value.name;
    if (typeof name !== "string" || !isValidName(name))
        throw new ToliError(`${where}.name must be a name of letters, digits, . _ - (got ${JSON.stringify(name)})`);
    const at = `${source} helper "${name}"`;
    const exec = value.exec;
    if (typeof exec !== "string" || exec.trim() === "")
        throw new ToliError(`${at}: "exec" must be an absolute or repo-relative path`);
    const description = value.description ?? "";
    if (typeof description !== "string") throw new ToliError(`${at}: "description" must be a string`);
    const nice = value.nice;
    if (nice !== undefined && (typeof nice !== "number" || !Number.isInteger(nice) || nice < 0 || nice > 19))
        throw new ToliError(`${at}: "nice" must be an integer 0-19`);
    const env: Record<string, string> = {};
    if (value.env !== undefined) {
        if (!isJsonObject(value.env)) throw new ToliError(`${at}: "env" must be an object of strings`);
        for (const [key, item] of Object.entries(value.env)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new ToliError(`${at}: bad env name "${key}"`);
            if (typeof item !== "string") throw new ToliError(`${at}: env ${key} must be a string`);
            env[key] = item;
        }
    }
    return {
        name,
        description,
        exec: isAbsolute(exec) ? exec : join(root, exec),
        args: value.args === undefined ? [] : stringList(value.args, `${at}: "args"`),
        schedule: parseSchedule(value.schedule, `${at}: "schedule"`),
        runAtLoad: optionalBool(value.runAtLoad, `${at}: "runAtLoad"`, false),
        nice: nice as number | undefined,
        lowPriorityIO: optionalBool(value.lowPriorityIO, `${at}: "lowPriorityIO"`, false),
        env,
        platforms: value.platforms === undefined ? undefined : stringList(value.platforms, `${at}: "platforms"`),
        enabled: optionalBool(value.enabled, `${at}: "enabled"`, true),
    };
}

/** Validate a parsed helpers.json document; every problem is a ToliError naming the file and helper. */
export function parseHelpers(raw: unknown, root: string, source: string): Helper[] {
    if (!isJsonObject(raw) || !Array.isArray(raw.helpers)) throw new ToliError(`${source} must be {"helpers": [...]}`);
    const extra = Object.keys(raw).filter((key) => key !== "helpers");
    if (extra.length > 0) throw new ToliError(`${source}: unknown top-level key "${extra[0]}"`);
    const helpers = raw.helpers.map((item, index) => parseHelper(item, index, root, source));
    const seen = new Set<string>();
    for (const helper of helpers) {
        if (seen.has(helper.name)) throw new ToliError(`${source}: helper "${helper.name}" is declared twice`);
        seen.add(helper.name);
    }
    return helpers;
}

/** The registry; a missing local/helpers.json means no helpers. */
export function loadHelpers(): Helper[] {
    return parseHelpers(readJson<unknown>(paths.helpersConfig(), { helpers: [] }), paths.root(), "local/helpers.json");
}

export function scheduleText(schedule: HelperSchedule): string {
    if (schedule.kind === "every") return `every ${schedule.text}`;
    if (schedule.kind === "cron") return `cron "${schedule.expr}"`;
    return "always running";
}
