// The heavy-build slots' locks and line (docs/fleet.md "Heavy-build slots"): a slot is a flock(2) on
// state/build-slots/<n>.lock, and a waiter holds a numbered ticket in state/build-slots/queue/ (also a flock, so a waiter
// that dies leaves the line with it); only the oldest live ticket may take a free slot. src/fleet/build-slots.ts runs
// commands in a slot, src/fleet/cargo-slot.ts holds one for a cargo that bypassed the shim.
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../core/paths.ts";
import { ToliError, warn } from "../core/util.ts";
import { type Flock, flock, LOCK_EX, LOCK_NB, LOCK_UN } from "./cargo-lock.ts";

/** How often a waiter looks again for a free slot, and a cargo's slot holder whether its cargo still runs. */
export const POLL_MS = 500;

const slotFile = (index: number): string => join(paths.buildSlotsDir(), `${index + 1}.lock`);
const queueDir = (): string => join(paths.buildSlotsDir(), "queue");
const queueLockFile = (): string => join(paths.buildSlotsDir(), "queue.lock");
const TICKET = /^(\d+)\.wait$/;
const ticketFile = (seq: number): string => join(queueDir(), `${seq}.wait`);

/** A waiter's place in line: its number and the fd holding the flock on its ticket file. */
type Ticket = { seq: number; fd: number };

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
 * Wait in line for a free slot, first come first served; prints the waiting line once if it has to wait. Gives up
 * (null) once `wanted` says the slot is no longer needed.
 */
export async function takeInTurn(
    slots: number,
    lock: Flock,
    wanted: () => boolean = () => true,
): Promise<{ index: number; fd: number } | null> {
    const ticket = takeTicket(lock);
    try {
        let told = false;
        for (;;) {
            if (!wanted()) return null;
            const held = firstInLine(ticket, lock) ? tryTake(slots, lock) : null;
            if (held !== null) return held;
            if (!told) warn(`toli: waiting for a heavy-build slot (${slots} busy)`);
            told = true;
            await Bun.sleep(POLL_MS);
        }
    } finally {
        leaveLine(ticket, lock);
    }
}

/** Take a free slot without waiting: its index and the fd holding it, or null when every slot is busy. */
function tryTake(slots: number, lock: Flock): { index: number; fd: number } | null {
    mkdirSync(paths.buildSlotsDir(), { recursive: true });
    for (let index = 0; index < slots; index++) {
        const fd = openSync(slotFile(index), "a");
        if (lock(fd, LOCK_EX | LOCK_NB) === 0) return { index, fd };
        closeSync(fd);
    }
    return null;
}

/** How many of the first `slots` build slots a command holds right now (0 where flock is unavailable). */
export function busyBuildSlots(slots: number): number {
    const lock = flock();
    if (lock === null) return 0;
    let busy = 0;
    for (let index = 0; index < slots; index++) {
        let fd: number;
        try {
            fd = openSync(slotFile(index), "r");
        } catch {
            continue; // Never taken yet: free.
        }
        if (lock(fd, LOCK_EX | LOCK_NB) === 0) lock(fd, LOCK_UN);
        else busy += 1;
        closeSync(fd);
    }
    return busy;
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
