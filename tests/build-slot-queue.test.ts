import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { holdSlot, type Run, runs, type Started, slotBox, start, toliArgs, until } from "./build-slot-fixture.ts";
import type { Sandbox } from "./helpers.ts";

/** Start heavy build `label` and wait until it reports waiting for the slot, so arrival order is fixed. */
async function waitInLine(box: Sandbox, label: string): Promise<Started> {
    const waiter = start(box, toliArgs("build-slot", "--", "cargo", "build"), { STUB_LABEL: label });
    await until(`${label} waiting`, () => waiter.stderr.join("").includes("waiting for a heavy-build slot"));
    return waiter;
}

describe("build slot waiters, first come first served", () => {
    test("waiters get the slot in arrival order, one after another", async () => {
        const { box, log } = slotBox(1, 3);
        const holder = await holdSlot(box, log);
        const labels = ["w1", "w2", "w3", "w4", "w5"];
        const waiters: Started[] = [];
        for (const label of labels) waiters.push(await waitInLine(box, label));
        expect(runs(log).map((run) => run.label)).toEqual(["a"]);
        writeFileSync(`${log}.done-a`, "");
        const results = await Promise.all([holder.done, ...waiters.map((waiter) => waiter.done)]);
        expect(results.map((result) => result.code)).toEqual([0, 0, 0, 0, 0, 0]);
        const order = runs(log);
        expect(order.map((run) => run.label)).toEqual(["a", ...labels]);
        for (let i = 1; i < order.length; i++)
            expect((order[i] as Run).start).toBeGreaterThanOrEqual((order[i - 1] as Run).end);
    }, 60_000);

    test("a waiter that dies leaves the line and a killed holder's slot goes to the oldest live waiter", async () => {
        const { box, log } = slotBox(1, 3);
        const holder = await holdSlot(box, log);
        const first = await waitInLine(box, "w1");
        const dying = await waitInLine(box, "w2");
        const third = await waitInLine(box, "w3");
        const fourth = await waitInLine(box, "w4");
        const fifth = await waitInLine(box, "w5");
        dying.proc.kill("SIGKILL");
        await dying.done;
        holder.proc.kill("SIGKILL");
        const results = await Promise.all([first.done, third.done, fourth.done, fifth.done]);
        expect(results.map((result) => result.code)).toEqual([0, 0, 0, 0]);
        expect(runs(log).map((run) => run.label)).toEqual(["a", "w1", "w3", "w4", "w5"]);
    }, 60_000);
});
