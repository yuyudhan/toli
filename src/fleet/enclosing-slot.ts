// Whether a build already runs inside a heavy-build slot (docs/fleet.md "Heavy-build slots"), so `bin/toli build-slot`,
// the cargo shim and the rustc wrapper's probe reuse that slot instead of queueing for a second one (T601).
import { ancestry } from "../core/ancestry.ts";
import { busySlots } from "./build-queue.ts";
import { heldCargoSlot } from "./outside-builds.ts";

/** Names the pid of the process holding the slot `TOLI_BUILD_SLOT` names, as that holder recorded it in its lock file. */
const SLOT_HOLDER_ENV = "TOLI_BUILD_SLOT_HOLDER";

/**
 * The slot this process already runs in (counting from 1), or null. `bin/toli build-slot`, so the cargo shim, and the
 * rustc wrapper's probe (`build-slot --cargo`) all ask this before they queue, so a build inside a slot never waits for
 * the slot it runs in. It runs in one when
 * - its `TOLI_BUILD_SLOT` names a busy slot and its `TOLI_BUILD_SLOT_HOLDER` that slot's holder, which whoever takes a
 *   slot exports (`slotMarker`), so a builder a test kit detached from the slot's process tree still counts; or
 * - a busy slot's holder is this process or one of its ancestors, so a layer that dropped the variables (`env -u`, a
 *   script that rebuilds its environment) changes nothing: the pid in a busy slot's lock file, or a cargo whose
 *   rustc-wrapper holder holds a slot for it (`cargo-<pid>.held`, src/fleet/cargo-slot.ts).
 * A slot is busy only while its holder's flock is held, so a `TOLI_BUILD_SLOT` left by a holder that died, naming a
 * slot nobody holds now, never skips the line; nor does one naming a slot another build has taken since (T2276).
 */
export function enclosingSlot(): number | null {
    const busy = busySlots();
    if (busy.length === 0) return null; // A held cargo's holder holds a busy slot too.
    const marked = busy.find(
        ({ slot, pid }) => process.env.TOLI_BUILD_SLOT === String(slot) && process.env[SLOT_HOLDER_ENV] === String(pid),
    );
    if (marked !== undefined) return marked.slot;
    for (const pid of ancestry()) {
        const holder = busy.find((slot) => slot.pid === pid);
        if (holder !== undefined) return holder.slot;
        const cargo = heldCargoSlot(pid);
        if (cargo !== null) return cargo;
    }
    return null;
}

/**
 * The variables a command run in slot `slot` gets, naming the slot and its holder (`holder`, else the pid its lock file
 * records), so a builder it detaches from its process tree runs in that slot (`enclosingSlot`).
 */
export function slotMarker(slot: number, holder?: number): Record<string, string> {
    const pid = holder ?? busySlots().find((busy) => busy.slot === slot)?.pid;
    return { TOLI_BUILD_SLOT: String(slot), ...(pid === undefined ? {} : { [SLOT_HOLDER_ENV]: String(pid) }) };
}
