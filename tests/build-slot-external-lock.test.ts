import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Resources } from "../src/fleet/resources.ts";
import { runs, type Started, slotBox, start, toliArgs, until } from "./build-slot-fixture.ts";

// T1660: a slot's command that waits on a lock of its own (a project's dev-DB test lock) while the build holding that
// lock waits for the slot. The real process table (no TOLI_PROCESS_TABLE), so the waiter sees the holder's command
// sleeping, and a short idle window.
const REAL_PROCESSES = { TOLI_PROCESS_TABLE: "", TOLI_SLOT_IDLE_MS: "2000" };

describe("build slots and locks taken inside the wrapped command", () => {
    test("a build waiting for a slot whose command waits on the build's own lock builds beside it", async () => {
        const { box, log } = slotBox(1, 3);
        const dbLock = join(box.root, ".db-test-lock");
        // The plain `just test`: it holds the DB lock, then its cargo (through the shim) needs a slot.
        mkdirSync(dbLock);
        const started: Started[] = [];
        try {
            // `bin/toli build-slot -- just test crate X`: takes the slot, then waits for the DB lock, polling.
            const wrapped = start(
                box,
                toliArgs(
                    "build-slot",
                    "--",
                    "sh",
                    "-c",
                    `until mkdir "${dbLock}" 2>/dev/null; do sleep 0.5; done; cargo test; rmdir "${dbLock}"`,
                ),
                { ...REAL_PROCESSES, STUB_LABEL: "a" },
            );
            started.push(wrapped);
            await until(
                "the wrapper holding the slot",
                () => (JSON.parse(box.ok(["resources", "--json"])) as Resources).buildSlotsBusy === 1,
            );
            const plain = start(box, ["sh", "-c", `cargo build && rmdir "${dbLock}"`], {
                ...REAL_PROCESSES,
                STUB_LABEL: "b",
            });
            started.push(plain);
            await until(
                "both builds to finish",
                () => runs(log).filter((run) => !Number.isNaN(run.end)).length === 2,
                20_000,
            );
            const [a, b] = await Promise.all([wrapped.done, plain.done]);
            expect([a.code, b.code]).toEqual([0, 0]);
            expect(b.stderr).toContain("waiting for a heavy-build slot (1 busy)");
            expect(b.stderr).toMatch(/heavy-build slot 1 \(pid \d+ in .+\) has run nothing for 2s/);
            const [first, second] = runs(log);
            expect(first).toMatchObject({ label: "b", slot: "2", args: "build" });
            expect(second).toMatchObject({ label: "a", slot: "1", args: "test" });
        } finally {
            for (const proc of started) proc.proc.kill("SIGKILL");
        }
    }, 40_000);

    test("a build waits for a slot whose command keeps running, however long", async () => {
        const { box, log } = slotBox(1, 3);
        const stop = join(box.root, ".stop");
        const started: Started[] = [];
        try {
            // A command at work: a shell spinning on the CPU until told to stop.
            const busy = start(
                box,
                toliArgs("build-slot", "--", "sh", "-c", `while [ ! -e "${stop}" ]; do :; done`),
                REAL_PROCESSES,
            );
            started.push(busy);
            await until(
                "the busy command holding the slot",
                () => (JSON.parse(box.ok(["resources", "--json"])) as Resources).buildSlotsBusy === 1,
            );
            const waiter = start(box, ["cargo", "build"], { ...REAL_PROCESSES, STUB_LABEL: "b" });
            started.push(waiter);
            await until("the waiting message", () => waiter.stderr.join("").includes("waiting for a heavy-build slot"));
            // Real processes, real process states: only wall time shows the waiter staying put past two idle windows.
            await Bun.sleep(4000);
            expect(runs(log)).toEqual([]);
            mkdirSync(stop);
            const [held, waited] = await Promise.all([busy.done, waiter.done]);
            expect([held.code, waited.code]).toEqual([0, 0]);
            expect(waited.stderr).not.toContain("has run nothing");
            expect(runs(log)[0]).toMatchObject({ label: "b", slot: "1" });
        } finally {
            for (const proc of started) proc.proc.kill("SIGKILL");
        }
    }, 40_000);
});
