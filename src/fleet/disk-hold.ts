// The disk hold: a build folder in use is never deleted, so when the keeper ends under the emergency level with only
// such folders left, it pauses new jobs instead (state/disk-hold.json). While the hold lasts queued jawan runs stay
// queued, a new jawan run is queued instead of started (unless started with `--now`), and the tick starts no
// scheduled job; running work goes on and frees its folders when it ends. The hold posts one inbox item when it
// starts. Each keeper run that ends the same way renews it; one that ends over the emergency level, or a tick that
// finds free disk back over the floor, lifts it, and an unrenewed hold lapses after DISK_HOLD_MINUTES.
import { existsSync, rmSync } from "node:fs";
import { loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, readJson, writeJsonAtomic } from "../core/util.ts";
import { addInboxItem } from "../records/inbox.ts";
import { type BuildDir, within } from "./disk-scan.ts";
import { DiskLog, describe, gb, machineFloor } from "./disk-state.ts";
import { targetsInUse } from "./live-builds.ts";
import { measureVolume } from "./resources.ts";

/** Why new jobs wait, since when, and until when unless a keeper run renews it. */
export type DiskHold = { reason: string; since: string; until: string };

/** How long a hold lasts without a keeper run renewing it. */
export const DISK_HOLD_MINUTES = 30;

/** The live hold, or null when there is none or it lapsed. */
export function currentDiskHold(): DiskHold | null {
    const hold = readJson<DiskHold | null>(paths.diskHold(), null);
    if (hold === null || typeof hold.reason !== "string" || typeof hold.until !== "string") return null;
    return Date.parse(hold.until) > now().getTime() ? hold : null;
}

/** `new jobs paused (since <time>): <reason>`. */
export const diskHoldText = (hold: DiskHold): string => `new jobs paused (since ${hold.since}): ${hold.reason}`;

/** A build folder the keeper left because it is in use, and why. */
export type InUse = { path: string; reason: string };

/**
 * After a keeper run: under the emergency level with build folders in use left, hold new jobs (renewing a live hold;
 * a new one posts an inbox item naming the folders); over the emergency level, lift any hold. Returns the line for
 * the keeper's log, or null when nothing changed. A failed write is reported in the line, never thrown: disk never
 * stops the keeper.
 */
export function settleDiskHold(
    machine: string,
    disk: { freeGB: number; emergencyGB: number; floorGB: number },
    inUseLeft: readonly InUse[],
): string | null {
    if (disk.freeGB >= disk.emergencyGB) return releaseDiskHold(`free ${gb(disk.freeGB)} is over the emergency level`);
    if (inUseLeft.length === 0) return null;
    const live = currentDiskHold();
    const at = now();
    const hold: DiskHold = {
        reason: `free ${gb(disk.freeGB)} is under the emergency level ${gb(disk.emergencyGB)} and only build folders in use are left`,
        since: live?.since ?? at.toISOString(),
        until: new Date(at.getTime() + DISK_HOLD_MINUTES * 60_000).toISOString(),
    };
    try {
        writeJsonAtomic(paths.diskHold(), hold);
    } catch (error) {
        return `new jobs not paused: cannot write ${paths.diskHold()} (${error instanceof Error ? error.message : String(error)})`;
    }
    if (live !== null) return null;
    const folders = inUseLeft.map((left) => `- ${left.path}: ${left.reason}`).join("\n");
    const body = [
        `Free disk on ${machine} is ${gb(disk.freeGB)}, under the emergency level ${gb(disk.emergencyGB)} (floor ${gb(disk.floorGB)}).`,
        "The keeper deleted every build folder nothing uses; these are in use, and a folder in use is never deleted:",
        folders,
        "",
        "New jobs are paused: queued jawan runs stay queued, new ones queue, and no scheduled job starts. Running work",
        "goes on; as it ends, the keeper frees its folders and lifts the pause once free disk is over the emergency level.",
        "This machine's disk is its own lead's job: anything that is not rebuildable build output waits on the user.",
    ].join("\n");
    try {
        addInboxItem(machine, `disk full on ${machine}: new jobs paused, only build folders in use left`, body);
    } catch (error) {
        return `new jobs paused (${hold.reason}); inbox alert not posted: ${error instanceof Error ? error.message : String(error)}`;
    }
    return `new jobs paused until free disk is over the emergency level (${hold.reason}); alert posted to the inbox`;
}

/** Lift the hold, if one is set; returns the line saying so (with `why`), or null when there was none. */
export function releaseDiskHold(why: string): string | null {
    if (readJson<DiskHold | null>(paths.diskHold(), null) === null) return null;
    try {
        rmSync(paths.diskHold(), { force: true });
    } catch (error) {
        return `new jobs still paused: cannot remove ${paths.diskHold()} (${error instanceof Error ? error.message : String(error)})`;
    }
    return `new jobs resume: ${why}`;
}

/**
 * Every build folder still on disk that the run kept because it is in use, with why: the targets a live build uses
 * first (naming that build), then each other folder kept for a reason (a jawan, gate, subagent or process in its
 * checkout, cargo's locks, open files, a container's mount), deleted folders and those inside them left out.
 */
export function foldersInUse(
    dirs: readonly BuildDir[],
    done: ReadonlySet<string>,
    kept: ReadonlyMap<string, { reason: string }>,
): InUse[] {
    const gone = (path: string): boolean => done.has(path) || [...done].some((dir) => within(path, dir));
    const targets = dirs.flatMap((dir) => (dir.kind === "target" && !gone(dir.path) ? [dir.path] : []));
    const left = new Map(targetsInUse(targets).map((entry) => [entry.path, entry.reason]));
    for (const [path, { reason }] of kept)
        if (!left.has(path) && !gone(path) && existsSync(path)) left.set(path, reason);
    return [...left].map(([path, reason]) => ({ path, reason }));
}

/**
 * The tick's check on a disk hold: no keeper runs while free disk is over the floor, so a hold whose disk came back
 * there by itself (work ended, space freed by hand) is lifted here. Returns the line saying so, or null. Never throws.
 */
export function liftDiskHoldWhenFree(): string | null {
    try {
        if (currentDiskHold() === null) return null;
        const volume = measureVolume(paths.root());
        if (typeof volume === "string") return null;
        const free = volume.freeGB;
        if (free < machineFloor(loadMachine(), volume.totalGB).floorGB) return null;
        const lifted = releaseDiskHold(`free ${gb(free)} is back over the floor`);
        if (lifted === null) return null;
        const log = new DiskLog(false);
        log.open();
        log.add(lifted);
        return `disk keeper: ${lifted}`;
    } catch (error) {
        return `disk keeper: disk hold not checked: ${describe(error)}`;
    }
}
