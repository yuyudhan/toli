// The heavy-build slots' line (src/fleet/build-line.ts), in process: a waiter's place is the number it arrived with,
// so one that joins the line late (it gave way to a release-priority run meanwhile) is still ahead of every later
// arrival, whatever order the tickets are taken in (T2276).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { firstInLine, leaveLine, placeInLine, takeTicket } from "../src/fleet/build-line.ts";
import { type Flock, flock } from "../src/fleet/cargo-lock.ts";
import { tempDir } from "./helpers.ts";

let previousRoot: string | undefined;

beforeEach(() => {
    previousRoot = process.env.TOLI_ROOT;
    process.env.TOLI_ROOT = tempDir("build-line");
});

afterEach(() => {
    if (previousRoot === undefined) delete process.env.TOLI_ROOT;
    else process.env.TOLI_ROOT = previousRoot;
});

function lock(): Flock {
    const found = flock();
    if (found === null) throw new Error("flock(2) unavailable");
    return found;
}

describe("build line places", () => {
    test("an earlier arrival that joins the line later is still first", () => {
        const flocked = lock();
        const early = placeInLine(flocked);
        const late = placeInLine(flocked);
        expect(late).toBeGreaterThan(early);
        const lateTicket = takeTicket(flocked, late);
        const earlyTicket = takeTicket(flocked, early);
        try {
            expect(earlyTicket.seq).toBe(early);
            expect(firstInLine(earlyTicket, flocked)).toBe(true);
            expect(firstInLine(lateTicket, flocked)).toBe(false);
        } finally {
            leaveLine(earlyTicket, flocked);
            leaveLine(lateTicket, flocked);
        }
    });
});
