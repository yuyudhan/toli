// The low-battery alert (docs/fleet.md "Low battery"). A machine the others depend on, the coordinator or one whose
// config/machine.json says what goes through it (`battery.serves`, such as the auth broker every machine's AI goes
// through), that runs on battery under `battery.alertPercent` (default 30) posts one inbox item, forwarded to the
// coordinator on a worker, and repeats it at most every 15 minutes while it stays so; plugging it in ends the spell.
// The battery is read with `pmset -g batt` on macOS and from /sys/class/power_supply on Linux. On AC power or with no
// battery nothing is posted. The hourly `fleet check` names such a machine too (src/fleet/oversight.ts).
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadMachine, type Machine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, platform, readJson, run, stamp, ToliError, withLock, writeJsonAtomic } from "../core/util.ts";
import { notify } from "../jobs/outbox.ts";

export const DEFAULT_BATTERY_ALERT_PERCENT = 30;
/** While a machine stays on battery under the threshold, the alert repeats at most this often. */
export const BATTERY_ALERT_EVERY_MS = 15 * 60_000;
const PMSET_TIMEOUT_MS = 5_000;

/** The charge of the machine's battery (percent) and whether it is discharging (on battery power). */
export type Battery = { percent: number; discharging: boolean };

/** `pmset -g batt`: the internal battery's line, `-InternalBattery-0 (id=…)\t27%; discharging; …`; null without one. */
export function parsePmset(text: string): Battery | null {
    const line = text.split("\n").find((entry) => /-InternalBattery-\d+/.test(entry));
    const match = line === undefined ? null : /(\d{1,3})%;\s*([^;]+);/.exec(line);
    if (match === null) return null;
    return { percent: Number(match[1]), discharging: (match[2] ?? "").trim().toLowerCase() === "discharging" };
}

/**
 * The system batteries under a Linux power-supply directory (`type` Battery, not a peripheral's `scope` Device): their
 * mean charge, discharging when any one is. Null when there is none or the directory cannot be read.
 */
export function readPowerSupply(dir: string): Battery | null {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return null;
    }
    const batteries = names.flatMap((name) => {
        const field = (file: string): string | null => {
            try {
                return readFileSync(join(dir, name, file), "utf8").trim();
            } catch {
                return null;
            }
        };
        if (field("type") !== "Battery" || field("scope") === "Device") return [];
        const capacity = field("capacity");
        const percent = capacity === null ? Number.NaN : Number(capacity);
        if (!Number.isFinite(percent)) return [];
        return [{ percent, discharging: field("status") === "Discharging" }];
    });
    if (batteries.length === 0) return null;
    const mean = batteries.reduce((sum, battery) => sum + battery.percent, 0) / batteries.length;
    return { percent: Math.round(mean), discharging: batteries.some((battery) => battery.discharging) };
}

/** This machine's battery, or null when it has none (or its platform has no reader). */
export function readBattery(): Battery | null {
    const system = platform();
    if (system === "darwin") {
        const result = run(["pmset", "-g", "batt"], { timeoutMs: PMSET_TIMEOUT_MS });
        return result.code === 0 ? parsePmset(result.stdout) : null;
    }
    if (system === "linux") return readPowerSupply(process.env.TOLI_POWER_SUPPLY_DIR ?? "/sys/class/power_supply");
    return null;
}

/** What goes through this machine, for the alert's text; null when no other machine depends on it. */
function servesText(machine: Machine): string | null {
    const serves = machine.battery?.serves;
    if (serves !== undefined) {
        if (typeof serves !== "string" || serves.trim() === "")
            throw new ToliError("config/machine.json battery.serves must be a non-empty string");
        return serves.trim();
    }
    return machine.role === "coordinator"
        ? "it is the coordinator, every machine's inbox, holds and fleet checks go through it"
        : null;
}

/** `battery.alertPercent`: the charge under which a machine on battery alerts. */
function alertPercent(machine: Machine): number {
    const raw = machine.battery?.alertPercent;
    if (raw === undefined) return DEFAULT_BATTERY_ALERT_PERCENT;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > 100)
        throw new ToliError("config/machine.json battery.alertPercent must be a number from 1 to 100");
    return raw;
}

/**
 * The alert's text when `machine`, one the others depend on, is discharging under its threshold:
 * `<machine> on battery at N%, discharging: plug it in; <what goes through it>`. Null otherwise (no battery, on AC
 * power, charged enough, or nobody depends on it); the battery is read only when someone does.
 */
export function lowBatteryText(machine: Machine, read: () => Battery | null = readBattery): string | null {
    const serves = servesText(machine);
    if (serves === null) return null;
    const threshold = alertPercent(machine);
    const battery = read();
    if (battery === null || !battery.discharging || battery.percent >= threshold) return null;
    return `${machine.name} on battery at ${battery.percent}%, discharging: plug it in; ${serves}`;
}

/** state/battery-alert.json: when the alert last went out in this spell on battery. */
type BatteryAlertState = { at?: string };

/**
 * The tick's step: while this machine is low on battery, post the alert when none went out in the last 15 minutes of
 * this spell; once it is not (plugged in, charged, no battery) the spell ends, so the next one alerts at once. Returns
 * the line to log, or null.
 */
export function alertLowBattery(): string | null {
    const machine = loadMachine();
    const text = lowBatteryText(machine);
    return withLock(paths.lock("battery-alert"), () => {
        if (text === null) {
            rmSync(paths.batteryAlert(), { force: true });
            return null;
        }
        const at = now();
        const last = Date.parse(readJson<BatteryAlertState>(paths.batteryAlert(), {}).at ?? "");
        if (Number.isFinite(last) && at.getTime() - last < BATTERY_ALERT_EVERY_MS) return null;
        writeJsonAtomic(paths.batteryAlert(), { at: at.toISOString() } satisfies BatteryAlertState);
        const body = [
            `${text}.`,
            "",
            `Every ${BATTERY_ALERT_EVERY_MS / 60_000} minutes while it stays on battery under ${alertPercent(machine)}%, this alert repeats; once it sleeps or dies, what goes through it stops for every machine.`,
        ].join("\n");
        notify(machine, text, body, `battery-${machine.name}-${stamp(at)}`);
        return `${text}: alert posted`;
    });
}
