// The disk keeper before work starts (src/fleet/disk.ts): inline before each jawan launch, detached from the minute
// tick. With capacity.diskKeep false nothing is deleted: low disk only alerts the inbox (disk-alert.ts).
import { loadMachine } from "../core/config.ts";
import { dryRun as envDryRun } from "../jobs/os-scheduler.ts";
import { floorText, type KeepReport, keepDisk } from "./disk.ts";
import { diskAlertBeforeWork, diskKeepSetting } from "./disk-alert.ts";
import { liftDiskHoldWhenFree } from "./disk-hold.ts";
import { describe, gb, keepDiskDetached } from "./disk-state.ts";
import { fallbackSweep } from "./stale-sweep.ts";

/**
 * Before work starts (each jawan launch): free disk inline. `detached` (the minute tick) only starts the background
 * keeper, to do all of it. With capacity.diskKeep false nothing is deleted: low disk only alerts the inbox
 * (src/fleet/disk-alert.ts). Never throws: disk never stops work.
 */
export function keepDiskBeforeWork(mode: "inline" | "detached" = "inline"): string | null {
    let setting: boolean | string = true;
    try {
        setting = diskKeepSetting(loadMachine());
    } catch {
        // An unreadable config: the keeper below reports it and falls back to sweeping, as it always has.
    }
    if (typeof setting === "string") return `disk keeper: ${setting}: deleting nothing`;
    if (!setting) return diskAlertBeforeWork(mode, envDryRun());
    if (mode === "detached") return (envDryRun() ? null : liftDiskHoldWhenFree()) ?? keepDiskDetached(envDryRun());
    let report: KeepReport;
    try {
        report = keepDisk();
    } catch (error) {
        fallbackSweep(error, false, envDryRun());
        return `disk keeper failed: ${describe(error)}; swept stale artifacts instead (logs/disk.log)`;
    }
    if (!report.ran) return null;
    const paused = report.jobsPaused ? "; new jobs paused: only build folders in use are left (logs/disk.log)" : "";
    return `disk keeper: free ${gb(report.freeBeforeGB)} -> ${gb(report.freeAfterGB)} (${floorText(report)})${paused}`;
}
