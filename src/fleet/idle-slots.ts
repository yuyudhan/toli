// Idle heavy-build slots (docs/fleet.md "Heavy-build slots"): a slot whose command has run nothing for a while,
// blocked on a lock the waiting build may hold (a project's test-database lock), does not count as busy for the first
// waiter in line (src/fleet/build-queue.ts `takeInTurn`), so a waiter never deadlocks against it (T1660).
import type { BusySlot } from "./build-queue.ts";
import { heldCargosByHolder, type ProcessTable, treeRunning } from "./outside-builds.ts";

/**
 * How long a slot's command must have run (next to) nothing before the first waiter in line builds beside it.
 * `TOLI_SLOT_IDLE_MS` overrides it (tests).
 */
const IDLE_MS = 60_000;
/** The share of a slot's samples over that window its command may have been running in and still count as idle. */
const IDLE_RUNNING_SHARE = 0.05;

/**
 * What a waiter has seen of each busy slot's command (by `<slot>:<holder pid>`): since when, and each sample since,
 * over its idle window `windowMs`.
 */
export type IdleWatch = {
    windowMs: number;
    seen: Map<string, { since: number; samples: { at: number; running: boolean }[] }>;
};

/** A waiter's fresh watch over the busy slots, with the idle window (`TOLI_SLOT_IDLE_MS` when set). */
export function idleWatch(): IdleWatch {
    const override = Number(process.env.TOLI_SLOT_IDLE_MS);
    return { windowMs: Number.isInteger(override) && override > 0 ? override : IDLE_MS, seen: new Map() };
}

/**
 * The slots of `busy` whose command has run nothing for the window: in at most `IDLE_RUNNING_SHARE` of this waiter's
 * samples since it first saw them, one taken now from `table` and kept in `watch`. A slot's command is every process
 * below its holder (the holder itself only waits on it), or a rustc-wrapper holder's cargo and everything below it.
 */
export function idleSlots(watch: IdleWatch, busy: BusySlot[], table: ProcessTable): BusySlot[] {
    const now = Date.now();
    const cargos = heldCargosByHolder();
    const idle: BusySlot[] = [];
    const seen = new Set<string>();
    for (const slot of busy) {
        const key = `${slot.slot}:${slot.pid}`;
        seen.add(key);
        const cargo = cargos.get(slot.pid);
        const running = cargo === undefined ? treeRunning(table, slot.pid, false) : treeRunning(table, cargo, true);
        const seenBefore = watch.seen.get(key);
        const since = seenBefore?.since ?? now;
        const samples = [
            ...(seenBefore?.samples ?? []).filter((sample) => sample.at > now - watch.windowMs),
            { at: now, running },
        ];
        watch.seen.set(key, { since, samples });
        const runningShare = samples.filter((sample) => sample.running).length / samples.length;
        if (now - since >= watch.windowMs && runningShare <= IDLE_RUNNING_SHARE) idle.push(slot);
    }
    for (const key of watch.seen.keys()) if (!seen.has(key)) watch.seen.delete(key);
    return idle;
}

/** The line a waiter prints for each idle slot it builds beside. */
export function besideIdleText(idle: BusySlot, watch: IdleWatch): string {
    return (
        `toli: heavy-build slot ${idle.slot} (pid ${idle.pid} in ${idle.cwd}) has run nothing for ` +
        `${Math.round(watch.windowMs / 1000)}s, maybe waiting on a lock this build holds; building beside it`
    );
}
