// A check that takes its heavy-build slot at its first heavy step (docs/fleet.md "Heavy-build slots", T2257). A
// project set `--slot-at-heavy-step yes` declares that its gate recipes and pre-push hook run their heavy steps (cargo,
// a test suite) through `bin/toli build-slot --` (or toli's cargo shim and rustc wrapper). Its gate runner and its
// `bin/toli push` then run the check without a slot, exporting their pid as TOLI_DEFERRED_SLOT, so its cheap steps
// (guards, spelling, formatting, type checks, lint) never wait in line and a cheap failure ends it without queueing.
// The first heavy step asks that run for its slot (a request file, state/build-slots/deferred-<run pid>.want) and waits
// until the run holds one: the run waits in line itself (src/fleet/build-slots.ts `withSlotAtHeavyStep`) and keeps
// the slot until the check ends, so every later step of it, heavy or cheap, runs in that one slot without queueing
// again (`enclosingSlot` finds the run among each step's ancestors).
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ancestry } from "../core/ancestry.ts";
import { paths } from "../core/paths.ts";
import { pidAlive, writeTextAtomic } from "../core/util.ts";
import { busySlots } from "./build-queue.ts";

/** The variable a check run without a slot exports to its steps: its pid, the run that takes the slot for them. */
export const DEFERRED_SLOT_ENV = "TOLI_DEFERRED_SLOT";
/** How often a heavy step looks again whether its run holds the slot it asked for. */
const REQUEST_POLL_MS = 100;

/** The file a heavy step writes to ask run `runPid` for its slot. */
export const slotRequestFile = (runPid: number): string => join(paths.buildSlotsDir(), `deferred-${runPid}.want`);

/**
 * The run this process's heavy step takes its slot from: the pid in TOLI_DEFERRED_SLOT while that process is one of
 * this process's live ancestors, else null (a variable a process outside the check inherited, or a run that ended).
 */
export function deferredSlotRun(): number | null {
    const pid = Number(process.env[DEFERRED_SLOT_ENV] ?? "");
    if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return null;
    return ancestry().includes(pid) ? pid : null;
}

/**
 * Ask run `runPid` for its slot and wait until it holds one: that slot's number, at once when the run holds it already,
 * or null when the run ended first.
 */
export async function slotFromRun(runPid: number): Promise<number | null> {
    let asked = false;
    for (;;) {
        const held = busySlots().find((slot) => slot.pid === runPid);
        if (held !== undefined) return held.slot;
        if (!pidAlive(runPid)) return null;
        if (!asked) {
            mkdirSync(paths.buildSlotsDir(), { recursive: true });
            writeTextAtomic(slotRequestFile(runPid), `${process.pid}\n`);
            asked = true;
        }
        await Bun.sleep(REQUEST_POLL_MS);
    }
}

/**
 * Remove run `runPid`'s request file and the `cargo-<pid>.held` files naming it as the holder of its heavy steps'
 * cargos (src/fleet/cargo-slot.ts `slotForProcess`), at its start (a pid reused after a killed run) and at its end.
 */
export function clearSlotRequest(runPid: number): void {
    rmSync(slotRequestFile(runPid), { force: true });
    let names: string[];
    try {
        names = readdirSync(paths.buildSlotsDir());
    } catch {
        return; // No slot taken yet on this machine.
    }
    for (const name of names) {
        if (!/^cargo-\d+\.held$/.test(name)) continue;
        const file = join(paths.buildSlotsDir(), name);
        let holder = "";
        try {
            holder = readFileSync(file, "utf8").split(" ")[0] ?? "";
        } catch {
            continue; // Removed meanwhile.
        }
        if (holder === String(runPid)) rmSync(file, { force: true });
    }
}
