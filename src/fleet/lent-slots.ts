// Lent heavy-build slots (docs/fleet.md "Heavy-build slots"): a waiter takes a slot beside one whose command has run
// nothing for the idle window (src/fleet/idle-slots.ts, T1660), recording the slot it was lent in its lock file
// (`beside`, src/fleet/build-queue.ts). Once that command wakes, its next build waits here for the lent build to end,
// so the machine never runs more heavy builds than `capacity.buildSlots` (T2050).
import { warn } from "../core/util.ts";
import { busySlots, POLL_MS } from "./build-queue.ts";
import { besideIdleText, idleSlots, idleWatch } from "./idle-slots.ts";
import { processTable } from "./outside-builds.ts";

/**
 * Wait while a build taken beside slot `slot` still runs, so that slot's command, woken, never builds beside it. A
 * build inside `slot` (`withBuildSlot`, the rustc wrapper's probe in `slotForCargo`) calls it before it starts, and says
 * once what it waits for. A lent build that has itself run nothing for the idle window (`idleSlots`: it may wait on
 * something this build's command holds) is not waited for, so the two never deadlock.
 */
export async function waitForLentBuilds(slot: number): Promise<void> {
    const watch = idleWatch();
    let told = false;
    for (;;) {
        const lent = busySlots().filter((busy) => busy.beside.includes(slot));
        const idle = lent.length === 0 ? [] : idleSlots(watch, lent, processTable());
        const running = lent.filter((busy) => !idle.includes(busy));
        if (running.length === 0) {
            for (const busy of idle) warn(besideIdleText(busy, watch));
            return;
        }
        if (!told) {
            const builds = running.map((busy) => `slot ${busy.slot}, pid ${busy.pid} in ${busy.cwd}`).join("; ");
            warn(`toli: heavy-build slot ${slot} is lent to a build beside it (${builds}); waiting for it to end`);
            told = true;
        }
        await Bun.sleep(POLL_MS);
    }
}
