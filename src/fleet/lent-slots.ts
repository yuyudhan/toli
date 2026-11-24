// Lent heavy-build slots (docs/fleet.md "Heavy-build slots"): a waiter takes a slot beside one whose command has run
// nothing for the idle window (src/fleet/idle-slots.ts, T1660), recording the slot it was lent and that slot's holder
// in its lock file (`beside`, src/fleet/build-queue.ts). Once that holder's command wakes, its next build waits here for
// the lent build to end, so the machine never runs more heavy builds than `capacity.buildSlots` (T2050), and marks the
// slot woken meanwhile, so no waiter is lent it again and the wait never outlasts the builds lent already (T2620). The
// wait never lasts forever (T2668): a lent build counts only beside the holder it was lent by, never one of the slot's
// later holders; one running inside the waiting slot's own process tree, or whose holder is gone, is never waited for;
// and one that itself waits (woken) and runs nothing for five idle windows is set aside.
import { pidAlive, warn } from "../core/util.ts";
import { type BusySlot, busySlots, POLL_MS } from "./build-queue.ts";
import { besideIdleText, idleSlots, idleWatch, markWoken } from "./idle-slots.ts";
import { descendsFrom, heldCargosByHolder, type ProcessTable, processTable } from "./outside-builds.ts";

/** How often a build waiting for the builds lent beside its slot says again what it waits for. */
const NOTICE_MS = 60_000;

/**
 * Wait while a build lent beside slot `slot`'s current holder still runs, so that holder's command, woken, never builds
 * beside it. A build inside `slot` (`withBuildSlot`, the rustc wrapper's probe in `slotForCargo`) calls it before it
 * starts, and says what it waits for, and for how long so far, once a minute. While it waits the slot is marked woken
 * (`markWoken`): it counts as busy, so no waiter is lent it again. Not waited for, each said once: a lent build that
 * has itself run nothing for the idle window (`idleSlots`: it may wait on something this build's command holds), or
 * for five windows when it waits in turn; one inside the slot's own process tree, which this build's command may be
 * waiting on; one whose holder is gone. So the two never deadlock.
 */
export async function waitForLentBuilds(slot: number): Promise<void> {
    const watch = idleWatch();
    const since = Date.now();
    let release: (() => void) | null = null;
    let toldAt = Number.NEGATIVE_INFINITY;
    try {
        for (;;) {
            const busy = busySlots();
            const holder = busy.find((held) => held.slot === slot)?.pid;
            if (holder === undefined) return; // Its holder is gone: nothing was lent beside it any more.
            const table = processTable();
            const lent = busy.filter((held) => lentBeside(held, slot, holder));
            const own = lent.filter((held) => insideTree(table, held, holder));
            const gone = lent.filter((held) => !own.includes(held) && !pidAlive(held.pid));
            const others = lent.filter((held) => !own.includes(held) && !gone.includes(held));
            const idle = others.length === 0 ? [] : idleSlots(watch, others, table, true);
            const running = others.filter((held) => !idle.includes(held));
            if (running.length === 0) {
                for (const held of idle) warn(besideIdleText(held, watch));
                for (const held of own)
                    warn(
                        `toli: ${heldText(held)} runs inside heavy-build slot ${slot}'s own build; not waiting for it`,
                    );
                for (const held of gone) warn(`toli: ${heldText(held)} has no live holder; not waiting for it`);
                return;
            }
            release ??= markWoken(slot);
            if (Date.now() - toldAt >= NOTICE_MS) {
                const minutes = Math.floor((Date.now() - since) / 60_000);
                warn(
                    `toli: heavy-build slot ${slot} is lent to a build beside it (${running.map(heldText).join("; ")}); ` +
                        `waiting for it to end${minutes > 0 ? ` (${minutes} min so far)` : ""}`,
                );
                toldAt = Date.now();
            }
            await Bun.sleep(POLL_MS);
        }
    } finally {
        release?.();
    }
}

/**
 * Whether `held` was lent beside slot `slot` while `holder` held it. A mark an older toli wrote names no holder and
 * counts for whoever holds the slot.
 */
function lentBeside(held: BusySlot, slot: number, holder: number): boolean {
    return held.slot !== slot && held.beside.some((mark) => mark.slot === slot && (mark.pid ?? holder) === holder);
}

/**
 * Whether lent build `held` (its holder, or the cargo a rustc-wrapper holder holds it for) runs below `holder`, the
 * waiting slot's holder, or below the cargo `holder` holds its slot for.
 */
function insideTree(table: ProcessTable, held: BusySlot, holder: number): boolean {
    const cargos = heldCargosByHolder();
    const roots = [holder, cargos.get(holder)].filter((pid): pid is number => pid !== undefined);
    const lentPids = [held.pid, cargos.get(held.pid)].filter((pid): pid is number => pid !== undefined);
    return lentPids.some((pid) => roots.some((root) => descendsFrom(table, pid, root)));
}

/** A lent build, as the waiting build's lines name it. */
const heldText = (held: BusySlot): string => `slot ${held.slot}, pid ${held.pid} in ${held.cwd}`;
