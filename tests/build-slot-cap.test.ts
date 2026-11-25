import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CARGO_SHIM, holdSlot, type Run, runs, slotBox, start, until } from "./build-slot-fixture.ts";

describe("build slot cap changed while builds wait", () => {
    test("a waiter re-reads buildSlots while it waits, so a raised cap is taken at once (T2740)", async () => {
        const { box, log } = slotBox(1, 3);
        const first = await holdSlot(box, log);
        const second = start(box, [CARGO_SHIM, "build"], { STUB_LABEL: "b" });
        await until("the waiting message", () => second.stderr.join("").includes("waiting for a heavy-build slot"));
        const config = join(box.root, "config", "machine.json");
        const parsed = JSON.parse(readFileSync(config, "utf8")) as { capacity: Record<string, number> };
        writeFileSync(config, JSON.stringify({ ...parsed, capacity: { ...parsed.capacity, buildSlots: 2 } }));
        // One poll (500 ms) plus the stub's start-up: the head of the line takes slot 2 while `a` still holds slot 1.
        await until("the waiter taking the raised slot", () => runs(log).some((run) => run.label === "b"), 3_000);
        expect(runs(log).find((run) => run.label === "b")).toMatchObject({ slot: "2", args: "build" });
        expect(Number.isNaN((runs(log).find((run) => run.label === "a") as Run).end)).toBe(true);
        writeFileSync(`${log}.done-a`, "");
        const [one, two] = await Promise.all([first.done, second.done]);
        expect([one.code, two.code]).toEqual([0, 0]);
    }, 30_000);
});
