import { describe, expect, test } from "bun:test";
import { cronFiredBetween, cronMatches, parseCron } from "../src/core/cron.ts";

// Local-time constructor: cron matches against the machine's wall clock.
const at = (y: number, mo: number, d: number, h: number, mi: number): Date => new Date(y, mo - 1, d, h, mi);

describe("cron matching", () => {
    test("steps and ranges", () => {
        const cron = parseCron("*/15 9-17 * * *");
        expect(cronMatches(cron, at(2026, 3, 4, 9, 0))).toBe(true);
        expect(cronMatches(cron, at(2026, 3, 4, 17, 45))).toBe(true);
        expect(cronMatches(cron, at(2026, 3, 4, 9, 10))).toBe(false);
        expect(cronMatches(cron, at(2026, 3, 4, 18, 0))).toBe(false);
        const stepped = parseCron("5-20/5 * * * *");
        expect([5, 10, 15, 20].every((minute) => cronMatches(stepped, at(2026, 3, 4, 1, minute)))).toBe(true);
        expect(cronMatches(stepped, at(2026, 3, 4, 1, 25))).toBe(false);
    });

    test("lists and day-of-week 7 is Sunday", () => {
        const cron = parseCron("0 8 * * 1,3,7");
        // 2026-03-01 is a Sunday.
        expect(cronMatches(cron, at(2026, 3, 1, 8, 0))).toBe(true);
        expect(cronMatches(cron, at(2026, 3, 2, 8, 0))).toBe(true);
        expect(cronMatches(cron, at(2026, 3, 3, 8, 0))).toBe(false);
    });

    test("restricted day-of-month and day-of-week match on either", () => {
        const cron = parseCron("0 0 1 * 1");
        expect(cronMatches(cron, at(2026, 3, 2, 0, 0))).toBe(true); // Monday, not the 1st
        expect(cronMatches(cron, at(2026, 4, 1, 0, 0))).toBe(true); // the 1st, a Wednesday
        expect(cronMatches(cron, at(2026, 3, 3, 0, 0))).toBe(false);
    });

    test("only day-of-month restricted ignores weekday", () => {
        const cron = parseCron("0 0 15 * *");
        expect(cronMatches(cron, at(2026, 3, 15, 0, 0))).toBe(true);
        expect(cronMatches(cron, at(2026, 3, 16, 0, 0))).toBe(false);
    });

    test("rejects malformed expressions", () => {
        for (const bad of [
            "* * * *",
            "60 * * * *",
            "* 24 * * *",
            "* * 0 * *",
            "5-1 * * * *",
            "*/0 * * * *",
            "a * * * *",
        ]) {
            expect(() => parseCron(bad)).toThrow();
        }
    });

    test("fired-between window is exclusive of start, inclusive of end", () => {
        const cron = parseCron("0 * * * *");
        expect(cronFiredBetween(cron, at(2026, 3, 4, 10, 0), at(2026, 3, 4, 10, 59))).toBe(false);
        expect(cronFiredBetween(cron, at(2026, 3, 4, 10, 0), at(2026, 3, 4, 11, 0))).toBe(true);
    });
});
