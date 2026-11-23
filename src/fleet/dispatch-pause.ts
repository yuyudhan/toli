// Dispatch paused for a fleet reboot (`bin/toli fleet reboot --drain`, docs/fleet.md "Rebooting the fleet"):
// state/dispatch-pause.json holds new jobs here the way a disk hold does (src/fleet/disk-hold.ts): queued jawan runs
// stay queued, a new one queues (unless `spawn --now`), and the tick starts no scheduled job; running work goes on.
// The pause belongs to the boot it was set in, so a rebooted machine resumes by itself even when the command that
// paused it is gone; `fleet drain resume` lifts it by hand, and one nobody lifts lapses at its `until`.
import { rmSync } from "node:fs";
import { uptime } from "node:os";
import { paths } from "../core/paths.ts";
import { now, readJson, writeJsonAtomic } from "../core/util.ts";
import { currentDiskHold, diskHoldText } from "./disk-hold.ts";

/** Why new jobs wait, since and until when, and the start of the boot it holds for (ISO). */
export type DispatchPause = { reason: string; since: string; until: string; bootedAt: string };

/** How far two readings of one boot's start may differ: uptime and the clock are read at slightly different times. */
const SAME_BOOT_MS = 2 * 60_000;

/** When this machine booted (the real clock, never TOLI_NOW: the uptime is real). */
export function bootedAt(): Date {
    return new Date(Date.now() - uptime() * 1000);
}

/** Whether two boot starts are the same boot. */
export function sameBoot(left: string, right: string): boolean {
    return Math.abs(Date.parse(left) - Date.parse(right)) <= SAME_BOOT_MS;
}

/** The live pause, or null when there is none, it lapsed, or this machine rebooted since it was set. */
export function currentDispatchPause(): DispatchPause | null {
    const pause = readJson<Partial<DispatchPause> | null>(paths.dispatchPause(), null);
    if (
        pause === null ||
        typeof pause.reason !== "string" ||
        typeof pause.since !== "string" ||
        typeof pause.until !== "string" ||
        typeof pause.bootedAt !== "string"
    )
        return null;
    if (!(Date.parse(pause.until) > now().getTime())) return null;
    const live = { reason: pause.reason, since: pause.since, until: pause.until, bootedAt: pause.bootedAt };
    return sameBoot(live.bootedAt, bootedAt().toISOString()) ? live : null;
}

/** Pause new jobs here for at most `minutes`, or until this machine reboots; a live pause keeps its `since`. */
export function pauseDispatch(reason: string, minutes: number): DispatchPause {
    const at = now();
    const pause: DispatchPause = {
        reason,
        since: currentDispatchPause()?.since ?? at.toISOString(),
        until: new Date(at.getTime() + minutes * 60_000).toISOString(),
        bootedAt: bootedAt().toISOString(),
    };
    writeJsonAtomic(paths.dispatchPause(), pause);
    return pause;
}

/** Lift the pause, set or not. */
export function resumeDispatch(): void {
    rmSync(paths.dispatchPause(), { force: true });
}

/** Why new jobs wait here now (`new jobs paused (since <time>): <reason>`), and what lifts that. */
export type JobsPause = { text: string; lifts: string };

/** A disk hold first, then a dispatch pause; null when new jobs may start. */
export function jobsPause(): JobsPause | null {
    const hold = currentDiskHold();
    if (hold !== null) return { text: diskHoldText(hold), lifts: "the disk keeper lifts the pause" };
    const pause = currentDispatchPause();
    if (pause === null) return null;
    return {
        text: `new jobs paused (since ${pause.since}): ${pause.reason}`,
        lifts: "the reboot or `bin/toli fleet drain resume` lifts the pause",
    };
}
