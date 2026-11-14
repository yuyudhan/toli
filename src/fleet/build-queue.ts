// The heavy-build slots' locks and line (docs/fleet.md "Heavy-build slots"): a slot is a flock(2) on
// state/build-slots/<n>.lock, and a waiter holds a numbered ticket in state/build-slots/queue/ (also a flock, so a waiter
// that dies leaves the line with it); only the oldest live ticket may take a free slot. src/fleet/build-slots.ts runs
// commands in a slot, src/fleet/cargo-slot.ts holds one for a cargo that bypassed the shim. A holder writes where its
// build runs into the slot's lock file, so the disk keeper never deletes the target it builds into (live-builds.ts),
// and the slot's share of compile jobs into its job pool (`jobPoolDir`), which toli's rustc wrapper
// (bin/shims/toli-rustc-wrapper) holds every crate compilation of every cargo in the slot to.
// Every slot number ever used counts while held (a build keeps its slot when `capacity.buildSlots` drops), and so does
// each heavy build running outside the slots (src/fleet/outside-builds.ts): a waiter takes a slot only while all of
// them together number fewer than `capacity.buildSlots`.
import {
    closeSync,
    ftruncateSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { paths } from "../core/paths.ts";
import { ToliError, warn, writeTextAtomic } from "../core/util.ts";
import { type Flock, flock, LOCK_EX, LOCK_NB, LOCK_UN } from "./cargo-lock.ts";
import { heldCargoPids, type OutsideBuild, outsideBuilds, outsideBuildText } from "./outside-builds.ts";
import type { Capacity } from "./resources.ts";

/** How often a waiter looks again for a free slot, and a cargo's slot holder whether its cargo still runs. */
export const POLL_MS = 500;

const slotFile = (index: number): string => join(paths.buildSlotsDir(), `${index + 1}.lock`);
const SLOT = /^(\d+)\.lock$/;
const queueDir = (): string => join(paths.buildSlotsDir(), "queue");
const queueLockFile = (): string => join(paths.buildSlotsDir(), "queue.lock");
const TICKET = /^(\d+)\.wait$/;
const ticketFile = (seq: number): string => join(queueDir(), `${seq}.wait`);

/**
 * Slot `slot`'s job pool (counting from 1): its `size` file holds the slot's share of compile jobs, and each job taken
 * is a file `<k>` (1..size) holding the pid of the rustc wrapper that took it. The wrapper of every crate compilation in
 * the slot (its own cargo's, a nested cargo's, one started through `$CARGO` or an absolute cargo path) takes a job
 * before it compiles and frees it after, so all of them together compile at most `size` crates at once.
 */
export const jobPoolDir = (slot: number): string => join(paths.buildSlotsDir(), `jobs-${slot}`);

/** A waiter's place in line: its number and the fd holding the flock on its ticket file. */
type Ticket = { seq: number; fd: number };

/** Where a slot's build runs: its working directory and the CARGO_TARGET_DIR it builds into (resolved), if set. */
export type SlotHolder = { cwd: string; targetDir: string | null };

/** The holder of a build started in `cwd` with `env`; a relative CARGO_TARGET_DIR is cargo's, relative to `cwd`. */
export function slotHolder(cwd: string, env: Record<string, string | undefined> = process.env): SlotHolder {
    const targetDir = env.CARGO_TARGET_DIR ?? "";
    return { cwd, targetDir: targetDir === "" ? null : resolve(cwd, targetDir) };
}

/** A busy slot (its number from 1) and the holder written into its lock file. */
export type BusySlot = SlotHolder & { slot: number; pid: number };

/**
 * Run `body` holding the queue lock, which every ticket taken, checked or left goes through, so a ticket is never
 * seen between its file's creation and its owner's flock on it.
 */
function withQueueLock<T>(lock: Flock, body: () => T): T {
    mkdirSync(queueDir(), { recursive: true });
    const fd = openSync(queueLockFile(), "a");
    try {
        if (lock(fd, LOCK_EX) !== 0) throw new ToliError(`toli: cannot lock ${queueLockFile()}`);
        return body();
    } finally {
        closeSync(fd);
    }
}

/** Join the line: the next number from the queue's counter, its ticket file created and flocked by this process. */
function takeTicket(lock: Flock): Ticket {
    return withQueueLock(lock, () => {
        const counter = join(queueDir(), "next");
        let text = "";
        try {
            text = readFileSync(counter, "utf8").trim();
        } catch {
            // No ticket taken yet on this machine: start at 0.
        }
        let seq = /^\d+$/.test(text) ? Number(text) : 0;
        for (;;) {
            const fd = openSync(ticketFile(seq), "a");
            if (lock(fd, LOCK_EX | LOCK_NB) === 0) {
                writeFileSync(counter, `${seq + 1}\n`);
                return { seq, fd };
            }
            // Only a lost counter makes a number repeat; a live owner keeps its ticket, this waiter takes the next.
            closeSync(fd);
            seq += 1;
        }
    });
}

/** Whether `ticket` is the oldest live one. A ticket ahead whose owner died (its flock is free) is removed. */
function firstInLine(ticket: Ticket, lock: Flock): boolean {
    return withQueueLock(lock, () => {
        const ahead = readdirSync(queueDir())
            .flatMap((name) => {
                const match = TICKET.exec(name);
                return match === null ? [] : [Number(match[1])];
            })
            .filter((seq) => seq < ticket.seq)
            .sort((a, b) => a - b);
        for (const seq of ahead) {
            let fd: number;
            try {
                fd = openSync(ticketFile(seq), "r");
            } catch {
                continue; // Left the line meanwhile.
            }
            const dead = lock(fd, LOCK_EX | LOCK_NB) === 0;
            if (dead) unlinkSync(ticketFile(seq));
            closeSync(fd);
            if (!dead) return false;
        }
        return true;
    });
}

/** Leave the line: the ticket file removed and its flock released. */
function leaveLine(ticket: Ticket, lock: Flock): void {
    withQueueLock(lock, () => {
        unlinkSync(ticketFile(ticket.seq));
        closeSync(ticket.fd);
    });
}

/**
 * Wait in line for a free slot, first come first served; prints the waiting line once if it has to wait, and once
 * which builds outside the slots it waits for. `waiter` is the process the slot is for (its own ancestors are never
 * waited for). Gives up (null) once `wanted` says the slot is no longer needed. The slot taken gets one slot's share
 * of compile jobs (`capacity.cargoJobs`) in its job pool (`jobPoolDir`).
 */
export async function takeInTurn(
    capacity: Pick<Capacity, "buildSlots" | "cargoJobs">,
    lock: Flock,
    holder: SlotHolder,
    waiter: number,
    wanted: () => boolean = () => true,
): Promise<{ index: number; fd: number } | null> {
    const ticket = takeTicket(lock);
    try {
        let told = false;
        let toldOutside = false;
        for (;;) {
            if (!wanted()) return null;
            const taken = firstInLine(ticket, lock) ? tryTake(capacity.buildSlots, lock, holder, waiter) : null;
            if (taken !== null && "fd" in taken) {
                shareJobs(taken.index + 1, capacity.cargoJobs);
                return taken;
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
    } finally {
        leaveLine(ticket, lock);
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
export function buildsOutsideSlots(waiter: number | null = null): OutsideBuild[] {
    return outsideBuilds([...busySlots().map((slot) => slot.pid), ...heldCargoPids()], waiter);
}

/**
 * Take a free slot without waiting, recording `holder` in it: its index and fd. While the builds holding slots and
 * the heavy builds outside them (`buildsOutsideSlots`) number `slots` or more, none is free: then the outside builds.
 */
function tryTake(
    slots: number,
    lock: Flock,
    holder: SlotHolder,
    waiter: number,
): { index: number; fd: number } | { outside: OutsideBuild[] } {
    mkdirSync(paths.buildSlotsDir(), { recursive: true });
    const held = heldSlots(lock);
    if (held.size >= slots) return { outside: [] };
    const outside = buildsOutsideSlots(waiter);
    if (held.size + outside.length >= slots) return { outside };
    for (let index = 0; index < slots; index++) {
        if (held.has(index)) continue;
        const fd = openSync(slotFile(index), "a");
        if (lock(fd, LOCK_EX | LOCK_NB) === 0) {
            recordHolder(fd, holder);
            return { index, fd };
        }
        closeSync(fd);
    }
    return { outside };
}

/** Write `holder` and this pid over the slot's lock file; best effort, since a full disk never stops a build. */
function recordHolder(fd: number, holder: SlotHolder): void {
    try {
        ftruncateSync(fd, 0);
        writeSync(fd, `${JSON.stringify({ pid: process.pid, cwd: holder.cwd, targetDir: holder.targetDir })}\n`);
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
    const { pid, cwd, targetDir } = value as Record<string, unknown>;
    if (typeof pid !== "number" || typeof cwd !== "string") return null;
    return { pid, cwd, targetDir: typeof targetDir === "string" ? targetDir : null };
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

/** Whether a build waits in line for a slot: a ticket in the queue whose owner is alive (its flock is held). */
export function slotWaiters(lock: Flock): boolean {
    return withQueueLock(lock, () =>
        readdirSync(queueDir()).some((name) => {
            if (!TICKET.test(name)) return false;
            let fd: number;
            try {
                fd = openSync(join(queueDir(), name), "r");
            } catch {
                return false; // Left the line meanwhile.
            }
            const alive = lock(fd, LOCK_EX | LOCK_NB) !== 0;
            if (!alive) lock(fd, LOCK_UN);
            closeSync(fd);
            return alive;
        }),
    );
}
