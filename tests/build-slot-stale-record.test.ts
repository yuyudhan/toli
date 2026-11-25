// A slot's lock file keeps its last holder's record after that holder is gone; only the flock says whether the slot is
// busy (src/fleet/build-queue.ts). T2791: a machine's state/build-slots/2.lock named a dead pid while waiters queued;
// that slot's flock was free (its record a stale one from a day before), and the waiters queued behind slot 1's live
// gate on a one-slot machine.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CARGO_SHIM, holdSlot, type Run, runs, slotBox, start, until } from "./build-slot-fixture.ts";

/** A slot lock file's holder record naming `pid`. */
const record = (pid: number, cwd: string, beside: number[]): string =>
    `${JSON.stringify({ pid, cwd, targetDir: null, beside })}\n`;

describe("a slot lock file's stale holder record", () => {
    test("naming a dead or reused pid without its flock, it is a free slot, taken at the first poll", async () => {
        const { box, log } = slotBox(1, 3);
        const dead = Bun.spawnSync(["true"]).pid;
        const dir = join(box.root, "state", "build-slots");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "1.lock"), record(dead, box.root, [1]));
        // A live pid that is not the holder: a reused pid, or the record of a holder whose process lives on.
        writeFileSync(join(dir, "2.lock"), record(process.pid, box.root, []));
        const result = await start(box, [CARGO_SHIM, "build"], { STUB_LABEL: "b" }).done;
        expect(result.code).toBe(0);
        expect(result.stderr).not.toContain("waiting");
        expect(runs(log).find((run) => run.label === "b")).toMatchObject({ slot: "1" });
        expect(readFileSync(join(dir, "1.lock"), "utf8")).not.toContain(`"pid":${dead},`);
    }, 30_000);

    test("a live holder keeps its slot when its lock file's record names a dead pid", async () => {
        const { box, log } = slotBox(1, 3);
        const holder = await holdSlot(box, log);
        const dead = Bun.spawnSync(["true"]).pid;
        // Rewritten in place: the holder's flock stays on the file, only the record it wrote changes.
        writeFileSync(join(box.root, "state", "build-slots", "1.lock"), record(dead, box.root, []));
        const waiter = start(box, [CARGO_SHIM, "build"], { STUB_LABEL: "b" });
        // Its first poll read the dead pid's record and still found the slot busy: a dead-pid record never frees it.
        await until("the waiting message", () => waiter.stderr.join("").includes("waiting for a heavy-build slot"));
        expect(runs(log).some((run) => run.label === "b")).toBe(false);
        writeFileSync(`${log}.done-a`, "");
        const [one, two] = await Promise.all([holder.done, waiter.done]);
        expect([one.code, two.code]).toEqual([0, 0]);
        const [a, b] = runs(log);
        expect(b).toMatchObject({ label: "b", slot: "1" });
        expect((b as Run).start).toBeGreaterThanOrEqual((a as Run).end);
    }, 30_000);
});
