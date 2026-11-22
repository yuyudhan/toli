// The heavy-build slots' line (docs/fleet.md "Heavy-build slots"): a waiter holds a numbered ticket in
// state/build-slots/queue/, a flock(2) on `<n>.wait`, so a waiter that dies leaves the line with it, and only the oldest
// live ticket may take a free slot (src/fleet/build-queue.ts `takeInTurn`). A waiter's number is its place in line: the
// queue's counter, past every ticket in the queue, taken once as it arrives and kept while it waits outside the line.
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../core/paths.ts";
import { ToliError } from "../core/util.ts";
import { type Flock, LOCK_EX, LOCK_NB, LOCK_UN } from "./cargo-lock.ts";

const queueDir = (): string => join(paths.buildSlotsDir(), "queue");
const queueLockFile = (): string => join(paths.buildSlotsDir(), "queue.lock");
const TICKET = /^(\d+)\.wait$/;
const ticketFile = (seq: number): string => join(queueDir(), `${seq}.wait`);

/** A waiter's place in line: its number and the fd holding the flock on its ticket file. */
export type Ticket = { seq: number; fd: number };

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

/**
 * The next number in line, the queue lock held: past the queue's counter and past every ticket in the queue, so a lost
 * or stale counter never gives a newcomer a number ahead of a waiter's.
 */
function nextSeq(): number {
    const counter = join(queueDir(), "next");
    let text = "";
    try {
        text = readFileSync(counter, "utf8").trim();
    } catch {
        // No ticket taken yet on this machine: start at 0.
    }
    const waiting = readdirSync(queueDir()).flatMap((name) => {
        const match = TICKET.exec(name);
        return match === null ? [] : [Number(match[1]) + 1];
    });
    const seq = Math.max(/^\d+$/.test(text) ? Number(text) : 0, ...waiting);
    writeFileSync(counter, `${seq + 1}\n`);
    return seq;
}

/** A newcomer's place in line: the next number, which it keeps while it waits outside the line (`takeTicket`). */
export function placeInLine(lock: Flock): number {
    return withQueueLock(lock, nextSeq);
}

/**
 * Join the line at `place` (the waiter's arrival number): its ticket file created and flocked by this process. A live
 * owner of that number (only a lost counter makes one repeat) keeps it, and this waiter takes the next.
 */
export function takeTicket(lock: Flock, place: number): Ticket {
    return withQueueLock(lock, () => {
        let seq = place;
        for (;;) {
            const fd = openSync(ticketFile(seq), "a");
            if (lock(fd, LOCK_EX | LOCK_NB) === 0) return { seq, fd };
            closeSync(fd);
            seq = nextSeq();
        }
    });
}

/** Whether `ticket` is the oldest live one. A ticket ahead whose owner died (its flock is free) is removed. */
export function firstInLine(ticket: Ticket, lock: Flock): boolean {
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
export function leaveLine(ticket: Ticket, lock: Flock): void {
    withQueueLock(lock, () => {
        unlinkSync(ticketFile(ticket.seq));
        closeSync(ticket.fd);
    });
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
