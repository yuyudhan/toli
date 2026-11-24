// The heavy-build slots' locks and line (docs/fleet.md "Heavy-build slots"): a slot is a flock(2) on
// state/build-slots/<n>.lock, and a waiter holds a numbered ticket in state/build-slots/queue/ (also a flock, so a waiter
// that dies leaves the line with it; src/fleet/build-line.ts); only the oldest live ticket may take a free slot.
// src/fleet/build-slots.ts runs commands in a slot, src/fleet/cargo-slot.ts holds one for a cargo that bypassed the
// shim. A holder writes where its build runs into the slot's lock file, so the disk keeper never deletes the target it
// builds into (live-builds.ts), and the slot's share of compile jobs into its job pool (`jobPoolDir`), which toli's
// rustc wrapper (bin/shims/toli-rustc-wrapper) holds every crate compilation of every cargo in the slot to.
// Every slot number ever used counts while held (a build keeps its slot when `capacity.buildSlots` drops), and so does
// each heavy build running outside the slots (src/fleet/outside-builds.ts): a waiter takes a slot only while all of
// them together number fewer than `capacity.buildSlots`. A slot whose command has run nothing for a while (blocked on
// a lock the waiter's build may hold) does not count, so a waiter never deadlocks against it (src/fleet/idle-slots.ts);
// that command's next build then waits for the build lent its slot (src/fleet/lent-slots.ts).
import { closeSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { paths } from "../core/paths.ts";
import { warn, writeTextAtomic } from "../core/util.ts";
import { firstInLine, leaveLine, placeInLine, type Ticket, takeTicket } from "./build-line.ts";
import { type Flock, flock, LOCK_EX, LOCK_NB, LOCK_UN } from "./cargo-lock.ts";
import { besideIdleText, type IdleWatch, idleSlots, idleWatch } from "./idle-slots.ts";
import {
    heldCargoPids,
    type OutsideBuild,
    outsideBuilds,
    outsideBuildText,
    type ProcessTable,
    processTable,
} from "./outside-builds.ts";
import { giveWayToPriorityRelease, priorityReleaseAhead } from "./release-priority.ts";
import type { Capacity } from "./resources.ts";

/** How often a waiter looks again for a free slot, and a cargo's slot holder whether its cargo still runs. */
export const POLL_MS = 500;

const slotFile = (index: number): string => join(paths.buildSlotsDir(), `${index + 1}.lock`);
const SLOT = /^(\d+)\.lock$/;

/**
 * Slot `slot`'s job pool (counting from 1): its `size` file holds the slot's share of compile jobs, and each job taken
 * is a file `<k>` (1..size) holding the pid of the rustc wrapper that took it. The wrapper of every crate compilation in
 * the slot (its own cargo's, a nested cargo's, one started through `$CARGO` or an absolute cargo path) takes a job
 * before it compiles and frees it after, so all of them together compile at most `size` crates at once.
 */
export const jobPoolDir = (slot: number): string => join(paths.buildSlotsDir(), `jobs-${slot}`);

/** Where a slot's build runs: its working directory and the CARGO_TARGET_DIR it builds into (resolved), if set. */
export type SlotHolder = { cwd: string; targetDir: string | null };

/** The holder of a build started in `cwd` with `env`; a relative CARGO_TARGET_DIR is cargo's, relative to `cwd`. */
export function slotHolder(cwd: string, env: Record<string, string | undefined> = process.env): SlotHolder {
    const targetDir = env.CARGO_TARGET_DIR ?? "";
    return { cwd, targetDir: targetDir === "" ? null : resolve(cwd, targetDir) };
}

/**
 * A lent mark: the busy slot a build was taken beside, by its number and the pid of the holder that held it then, whose
 * command's next builds wait for the lent build (`waitForLentBuilds`). `pid` is null in a record an older toli wrote,
 * which names only the number.
 */
export type LentMark = { slot: number; pid: number | null };

/**
 * A busy slot (its number from 1) and the holder written into its lock file, with `beside`: the idle slots it was taken
 * beside (`tryTake`).
 */
export type BusySlot = SlotHolder & { slot: number; pid: number; beside: LentMark[] };

/**
 * Wait in line for a free slot, first come first served; prints the waiting line once if it has to wait, and once
 * which builds outside the slots it waits for. `waiter` is the process the slot is for (its own ancestors are never
 * waited for). Gives up (null) once `wanted` says the slot is no longer needed. The slot taken gets one slot's share
 * of compile jobs (`capacity.cargoJobs`) in its job pool (`jobPoolDir`). A slot whose command has run nothing for the
 * idle window (`idleSlots`) does not count, so a build it waits on never waits for it; the waiter says so, naming it.
 * A build that gives way to a release-priority run (src/fleet/release-priority.ts) waits for it outside the line, and
 * leaves the line to wait again when one starts before its turn comes, so it never holds up the release's own builds
 * behind its ticket; it keeps the number it arrived with, so it rejoins the line ahead of every build that came later.
 */
export async function takeInTurn(
    capacity: Pick<Capacity, "buildSlots" | "cargoJobs">,
    lock: Flock,
    holder: SlotHolder,
    waiter: number,
    wanted: () => boolean = () => true,
): Promise<{ index: number; fd: number } | null> {
    const watch = idleWatch();
    let place = placeInLine(lock);
    for (;;) {
        if (!(await giveWayToPriorityRelease(holder.cwd, wanted))) return null;
        const ticket = takeTicket(lock, place);
        place = ticket.seq;
        try {
            const taken = await waitForTurn(capacity, lock, holder, waiter, wanted, ticket, watch);
            if (taken !== "give way") return taken;
        } finally {
            leaveLine(ticket, lock);
        }
    }
}

/**
 * `takeInTurn` holding `ticket`: the slot taken, null once `wanted` says it is no longer needed, or "give way" when a
 * release-priority run is ahead of the build once its ticket is first in line.
 */
async function waitForTurn(
    capacity: Pick<Capacity, "buildSlots" | "cargoJobs">,
    lock: Flock,
    holder: SlotHolder,
    waiter: number,
    wanted: () => boolean,
    ticket: Ticket,
    watch: IdleWatch,
): Promise<{ index: number; fd: number } | null | "give way"> {
    let told = false;
    let toldOutside = false;
    for (;;) {
        if (!wanted()) return null;
        const first = firstInLine(ticket, lock);
        if (first && priorityReleaseAhead(holder.cwd) !== null) return "give way";
        const taken = first
            ? tryTake(capacity.buildSlots, lock, holder, waiter, (table) => idleSlots(watch, busySlots(), table))
            : null;
        if (taken !== null && "fd" in taken) {
            for (const idle of taken.beside) warn(besideIdleText(idle, watch));
            shareJobs(taken.index + 1, capacity.cargoJobs);
            return { index: taken.index, fd: taken.fd };
        }
        if (!told) warn(`toli: waiting for a heavy-build slot (${capacity.buildSlots} busy)`);
        told = true;
        if (!toldOutside && taken !== null && taken.outside.length > 0) {
            const builds = taken.outside.map(outsideBuildText).join("; ");
            warn(`toli: counting heavy builds outside the slots as busy: ${builds}`);
            toldOutside = true;
        }
        await Bun.sleep(POLL_MS);
    }
}

/** Size slot `slot`'s job pool at `jobs`; best effort, since a full disk never stops a build. */
function shareJobs(slot: number, jobs: number): void {
    try {
        writeTextAtomic(join(jobPoolDir(slot), "size"), `${jobs}\n`);
    } catch {
        // A full disk: the wrapper finds no pool size and compiles at once, each cargo at its CARGO_BUILD_JOBS.
    }
}

/**
 * Every slot index a build holds now, up to the highest slot ever used: a build that took slot 3 before
 * `capacity.buildSlots` dropped to 2 still holds it, and still counts.
 */
function heldSlots(lock: Flock): Set<number> {
    const held = new Set<number>();
    let names: string[];
    try {
        names = readdirSync(paths.buildSlotsDir());
    } catch {
        return held; // No slot taken yet on this machine.
    }
    for (const name of names) {
        const match = SLOT.exec(name);
        if (match === null) continue;
        let fd: number;
        try {
            fd = openSync(join(paths.buildSlotsDir(), name), "r");
        } catch {
            continue;
        }
        if (lock(fd, LOCK_EX | LOCK_NB) === 0) lock(fd, LOCK_UN);
        else held.add(Number(match[1]) - 1);
        closeSync(fd);
    }
    return held;
}

/** The heavy builds running outside every slot now, `waiter`'s own ancestors left out (src/fleet/outside-builds.ts). */
export function buildsOutsideSlots(waiter: number | null = null, table: ProcessTable = processTable()): OutsideBuild[] {
    return outsideBuilds([...busySlots().map((slot) => slot.pid), ...heldCargoPids()], waiter, table);
}

/**
 * Take a free slot without waiting, recording `holder` in it: its index, fd and the idle slots (`idle`, which samples
 * them every call) it was lent past. While the builds holding slots, less the idle ones, and the heavy builds outside
 * them (`buildsOutsideSlots`) number `slots` or more, none is free: then the outside builds. A slot taken past an idle
 * one has a number above `slots`.
 */
function tryTake(
    slots: number,
    lock: Flock,
    holder: SlotHolder,
    waiter: number,
    idle: (table: ProcessTable) => BusySlot[],
): { index: number; fd: number; beside: BusySlot[] } | { outside: OutsideBuild[] } {
    mkdirSync(paths.buildSlotsDir(), { recursive: true });
    const held = heldSlots(lock);
    const table = processTable();
    const idleHeld = held.size > 0 ? idle(table) : [];
    if (held.size - idleHeld.length >= slots) return { outside: [] };
    const outside = buildsOutsideSlots(waiter, table);
    const room = slots - held.size - outside.length;
    if (room + idleHeld.length <= 0) return { outside };
    for (let index = 0; index < slots + held.size; index++) {
        if (held.has(index)) continue;
        const fd = openSync(slotFile(index), "a");
        if (lock(fd, LOCK_EX | LOCK_NB) === 0) {
            const beside = room > 0 ? [] : idleHeld;
            recordHolder(
                fd,
                holder,
                beside.map((slot) => ({ slot: slot.slot, pid: slot.pid })),
            );
            return { index, fd, beside };
        }
        closeSync(fd);
    }
    return { outside };
}

/**
 * Write `holder`, this pid and the idle slots it was taken beside (each with the holder it was lent by) over the slot's
 * lock file; best effort, since a full disk never stops a build.
 */
function recordHolder(fd: number, holder: SlotHolder, beside: LentMark[]): void {
    try {
        ftruncateSync(fd, 0);
        writeSync(
            fd,
            `${JSON.stringify({ pid: process.pid, cwd: holder.cwd, targetDir: holder.targetDir, beside })}\n`,
        );
    } catch {
        // A full disk: the keeper then sees a busy slot without knowing where it builds.
    }
}

/** A slot lock file's holder record, or null when it holds none (never written, a failed write, an older toli's). */
function parseHolder(text: string): Omit<BusySlot, "slot"> | null {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof value !== "object" || value === null) return null;
    const { pid, cwd, targetDir, beside } = value as Record<string, unknown>;
    if (typeof pid !== "number" || typeof cwd !== "string") return null;
    return {
        pid,
        cwd,
        targetDir: typeof targetDir === "string" ? targetDir : null,
        beside: Array.isArray(beside) ? beside.flatMap(lentMark) : [],
    };
}

/** One recorded lent mark, `{ slot, pid }` or an older toli's bare slot number; none when malformed. */
function lentMark(value: unknown): LentMark[] {
    if (Number.isInteger(value)) return [{ slot: value as number, pid: null }];
    if (typeof value !== "object" || value === null) return [];
    const { slot, pid } = value as Record<string, unknown>;
    if (!Number.isInteger(slot) || !Number.isInteger(pid)) return [];
    return [{ slot: slot as number, pid: pid as number }];
}

/**
 * Every slot a build holds right now with where that build runs, as its holder recorded it. A free slot's stale record
 * is never read: a holder that dies frees its slot with its flock.
 */
export function busySlots(): BusySlot[] {
    const lock = flock();
    if (lock === null) return [];
    let names: string[];
    try {
        names = readdirSync(paths.buildSlotsDir());
    } catch {
        return []; // No slot taken yet on this machine.
    }
    const held: BusySlot[] = [];
    for (const name of names) {
        const match = SLOT.exec(name);
        if (match === null) continue;
        let fd: number;
        try {
            fd = openSync(join(paths.buildSlotsDir(), name), "r");
        } catch {
            continue;
        }
        try {
            if (lock(fd, LOCK_EX | LOCK_NB) === 0) lock(fd, LOCK_UN);
            else {
                const record = parseHolder(readFileSync(fd, "utf8"));
                if (record !== null) held.push({ slot: Number(match[1]), ...record });
            }
        } finally {
            closeSync(fd);
        }
    }
    return held;
}

/**
 * How many build slots a command holds right now, every slot number counted, so a build that took its slot before
 * `capacity.buildSlots` dropped still counts (0 where flock is unavailable).
 */
export function busyBuildSlots(): number {
    const lock = flock();
    return lock === null ? 0 : heldSlots(lock).size;
}
