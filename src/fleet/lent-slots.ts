// Lent heavy-build slots (docs/fleet.md "Heavy-build slots"): a waiter takes a slot beside one whose command has run
// nothing for the idle window (src/fleet/idle-slots.ts, T1660), recording the slot it was lent in its lock file
// (`beside`, src/fleet/build-queue.ts). Once that command wakes, its next build waits here for the lent build to end,
// so the machine never runs more heavy builds than `capacity.buildSlots` (T2050), and marks the slot woken meanwhile,
// so no waiter is lent it again and the wait never outlasts the builds lent already (T2620).
import { warn } from "../core/util.ts";
import { type BusySlot, busySlots, POLL_MS } from "./build-queue.ts";
import { besideIdleText, idleSlots, idleWatch, markWoken } from "./idle-slots.ts";
import { processTable } from "./outside-builds.ts";

/** How often a build waiting for the builds lent beside its slot says again what it waits for. */
const NOTICE_MS = 60_000;

/**
 * Wait while a build taken beside slot `slot` still runs, so that slot's command, woken, never builds beside it. A
 * build inside `slot` (`withBuildSlot`, the rustc wrapper's probe in `slotForCargo`) calls it before it starts, and says
 * what it waits for once a minute. While it waits the slot is marked woken (`markWoken`): it counts as busy, so no
 * waiter is lent it again. A lent build that has itself run nothing for the idle window (`idleSlots`: it may wait on
 * something this build's command holds) is not waited for, so the two never deadlock.
 */
export async function waitForLentBuilds(slot: number): Promise<void> {
    const watch = idleWatch();
    let release: (() => void) | null = null;
    let toldAt = Number.NEGATIVE_INFINITY;
    try {
        for (;;) {
            const lent = busySlots().filter((busy) => busy.beside.includes(slot));
            const idle = lent.length === 0 ? [] : idleSlots(watch, lent, processTable());
            const running = lent.filter((busy) => !idle.includes(busy));
            if (running.length === 0) {
                for (const busy of idle) warn(besideIdleText(busy, watch));
                return;
            }
            release ??= markWoken(slot);
            if (Date.now() - toldAt >= NOTICE_MS) {
                warn(
                    `toli: heavy-build slot ${slot} is lent to a build beside it (${lentText(running)}); waiting for it to end`,
                );
                toldAt = Date.now();
            }
            await Bun.sleep(POLL_MS);
        }
    } finally {
        release?.();
    }
}

/** The lent builds a woken slot's build waits for, as its notice names them. */
const lentText = (running: BusySlot[]): string =>
    running.map((busy) => `slot ${busy.slot}, pid ${busy.pid} in ${busy.cwd}`).join("; ");
