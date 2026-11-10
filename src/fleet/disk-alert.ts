// The low-disk alert, for a machine whose disk keeper is switched off (capacity.diskKeep false in
// config/machine.json): toli then deletes nothing on its own. Before every jawan start and in every minute tick it
// only reads free disk, and under the alert level (10 GB, or the keeper's emergency level when that is higher) it
// posts one inbox item naming the biggest build folders, at most once per machine every 6 hours
// (state/disk-alert.stamp), so the lead decides what goes. `bin/toli disk keep` by hand still frees space.
import { existsSync, readFileSync } from "node:fs";
import { loadMachine, type Machine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, out, writeTextAtomic } from "../core/util.ts";
import { notify } from "../jobs/outbox.ts";
import { buildDirs, projectCheckouts, sizeGB } from "./disk-scan.ts";
import { describe, gb, machineFloor, startDetachedDisk } from "./disk-state.ts";
import { diskEmergencyGB, measureVolume } from "./resources.ts";

/** Free disk (GB) under which the alert goes out, unless the emergency level is higher. */
export const DISK_ALERT_GB = 10;
/** At most one alert per machine in this long. */
export const DISK_ALERT_EVERY_MS = 6 * 60 * 60_000;
/** How many of the biggest build folders the alert names. */
const BIGGEST = 10;

/**
 * `capacity.diskKeep`: whether toli frees disk on its own (true by default), or why the value is invalid, which
 * switches automatic deletion off, never on.
 */
export function diskKeepSetting(machine: Machine): boolean | string {
    const raw: unknown = machine.capacity?.diskKeep;
    if (raw === undefined) return true;
    return typeof raw === "boolean" ? raw : "config/machine.json capacity.diskKeep must be true or false";
}

/** The free disk under which the alert goes out on a volume of `totalGB`. */
function alertLevelGB(machine: Machine, totalGB: number): number {
    return Math.max(DISK_ALERT_GB, diskEmergencyGB(machineFloor(machine, totalGB).floorGB, totalGB));
}

/** Whether an alert went out within DISK_ALERT_EVERY_MS (the stamp holds its ISO time; an unreadable one: no). */
function alertedRecently(): boolean {
    const file = paths.diskAlertStamp();
    if (!existsSync(file)) return false;
    try {
        const at = Date.parse(readFileSync(file, "utf8").trim());
        return Number.isFinite(at) && now().getTime() - at < DISK_ALERT_EVERY_MS;
    } catch {
        return false;
    }
}

/**
 * With the keeper off: under the alert level and not alerted within 6 h, post the alert (`inline`, a jawan start) or
 * start `bin/toli disk alert` detached (the minute tick, which never waits on sizing folders). Returns what it did, or
 * null when nothing was due. A dry run only says what it would do. Never throws: disk never stops work.
 */
export function diskAlertBeforeWork(mode: "inline" | "detached", dryRun: boolean): string | null {
    try {
        const machine = loadMachine();
        const volume = measureVolume(paths.root());
        if (typeof volume === "string")
            return `disk keeper off (capacity.diskKeep false): cannot read free disk (${volume})`;
        const levelGB = alertLevelGB(machine, volume.totalGB);
        if (volume.freeGB >= levelGB || alertedRecently()) return null;
        const why = `disk keeper off (capacity.diskKeep false): free ${gb(volume.freeGB)} < ${gb(levelGB)}`;
        if (dryRun) return `${why}: would alert the inbox (dry run)`;
        writeTextAtomic(paths.diskAlertStamp(), `${now().toISOString()}\n`);
        if (mode === "detached") {
            startDetachedDisk(["alert"]);
            return `${why}: alerting the inbox in the background, deleting nothing`;
        }
        return `${why}: alerted the inbox (${postDiskAlert(machine)}), deleting nothing`;
    } catch (error) {
        return `disk keeper off (capacity.diskKeep false): low-disk alert failed: ${describe(error)}`;
    }
}

/** Post the low-disk alert now, naming the biggest build folders; returns the inbox item's path. */
function postDiskAlert(machine: Machine): string {
    const volume = measureVolume(paths.root());
    if (typeof volume === "string") throw new Error(`cannot read free disk: ${volume}`);
    const levelGB = alertLevelGB(machine, volume.totalGB);
    const folders = projectCheckouts()
        .flatMap((checkout) => buildDirs(checkout))
        .map((dir) => ({ path: dir.path, project: dir.checkout.project, size: sizeGB(dir.path) }))
        .sort((a, b) => b.size - a.size)
        .slice(0, BIGGEST);
    const listed =
        folders.length === 0
            ? "No build folders in the project checkouts."
            : `Biggest build folders:\n${folders.map((dir) => `- ${gb(dir.size)} ${dir.path} (${dir.project})`).join("\n")}`;
    const title = `disk low on ${machine.name}: ${gb(volume.freeGB)} free`;
    const body = [
        `Free disk on ${machine.name} is ${gb(volume.freeGB)} of ${gb(volume.totalGB)}, under ${gb(levelGB)}.`,
        "capacity.diskKeep is false, so toli deletes nothing on its own; the next alert comes 6 h after this one at the earliest.",
        "",
        listed,
        "",
        "To free space: `bin/toli disk keep --dry-run` lists what the keeper would delete, `bin/toli disk keep` deletes it.",
    ].join("\n");
    return notify(machine, title, body, `disk-alert-${now().getTime()}`);
}

/** `toli disk alert`: post the low-disk alert now, whatever free disk and the last alert are. */
export function diskAlertCommand(): void {
    const path = postDiskAlert(loadMachine());
    writeTextAtomic(paths.diskAlertStamp(), `${now().toISOString()}\n`);
    out(`disk alert: ${path}`);
}
