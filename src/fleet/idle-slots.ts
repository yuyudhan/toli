// Idle heavy-build slots (docs/fleet.md "Heavy-build slots"): a slot whose command has run nothing for a while,
// blocked on a lock the waiting build may hold (a project's test-database lock), does not count as busy for the first
// waiter in line (src/fleet/build-queue.ts `takeInTurn`), so a waiter never deadlocks against it (T1660). A slot whose
// command waits for a build lent beside it (src/fleet/lent-slots.ts) is woken, never idle, so no further build is lent
// it and the lent ones only drain (T2620).
import { closeSync, mkdirSync, openSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../core/paths.ts";
import { pidAlive } from "../core/util.ts";
import type { BusySlot } from "./build-queue.ts";
import { type Flock, flock, LOCK_EX, LOCK_NB, LOCK_SH, LOCK_UN } from "./cargo-lock.ts";
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
 * below its holder (the holder itself only waits on it), or a rustc-wrapper holder's cargo and everything below it. A
 * woken slot (`markWoken`) is never idle, and the watch forgets it, so once its command runs its window starts over.
 */
export function idleSlots(watch: IdleWatch, busy: BusySlot[], table: ProcessTable): BusySlot[] {
    const now = Date.now();
    const cargos = heldCargosByHolder();
    const woken = wokenSlots();
    const idle: BusySlot[] = [];
    const seen = new Set<string>();
    for (const slot of busy) {
        if (woken.has(slot.slot)) continue;
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

/** Locked by build `pid` in slot `slot` while it waits for the builds lent beside that slot (`markWoken`). */
const wokenFile = (slot: number, pid: number): string => join(paths.buildSlotsDir(), `woken-${slot}-${pid}.lock`);
const WOKEN = /^woken-(\d+)-(\d+)\.lock$/;

/**
 * Mark slot `slot` woken while this build inside it waits for the builds lent beside it: an exclusive flock on a woken
 * file of this process's own, so several builds in one slot mark it at once and one that dies unmarks it with its
 * flock. Returns the release, or null where flock(2) is unavailable (then no slot is ever busy, so none is lent) or
 * this process marks the slot already.
 */
export function markWoken(slot: number): (() => void) | null {
    const lock = flock();
    if (lock === null) return null;
    mkdirSync(paths.buildSlotsDir(), { recursive: true });
    const file = wokenFile(slot, process.pid);
    const fd = openSync(file, "w");
    if (lock(fd, LOCK_EX | LOCK_NB) !== 0) {
        closeSync(fd);
        return null;
    }
    return () => {
        rmSync(file, { force: true });
        lock(fd, LOCK_UN);
        closeSync(fd);
    };
}

/**
 * The slots some build marks woken right now (`markWoken`). Looks with a shared lock, so waiters looking at once never
 * take each other's look for a mark; removes the woken file of a build that died.
 */
function wokenSlots(): Set<number> {
    const woken = new Set<number>();
    const lock = flock();
    if (lock === null) return woken;
    let names: string[];
    try {
        names = readdirSync(paths.buildSlotsDir());
    } catch {
        return woken; // No slot taken yet on this machine.
    }
    for (const name of names) {
        const match = WOKEN.exec(name);
        if (match === null) continue;
        const file = join(paths.buildSlotsDir(), name);
        if (marked(lock, file)) woken.add(Number(match[1]));
        else if (!pidAlive(Number(match[2]))) rmSync(file, { force: true });
    }
    return woken;
}

/** Whether some process holds an exclusive lock on `file`. */
function marked(lock: Flock, file: string): boolean {
    let fd: number;
    try {
        fd = openSync(file, "r");
    } catch {
        return false; // Released meanwhile.
    }
    try {
        if (lock(fd, LOCK_SH | LOCK_NB) !== 0) return true;
        lock(fd, LOCK_UN);
        return false;
    } finally {
        closeSync(fd);
    }
}
