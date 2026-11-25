// The capacity a heavy-build waiter (src/fleet/build-queue.ts `takeInTurn`) takes its slot with, read from
// config/machine.json again on each poll, so a `capacity.buildSlots` changed while builds wait applies at once (T2740).
import { availableParallelism } from "node:os";
import { hasMachine, loadMachine, type Machine } from "../core/config.ts";
import { ToliError } from "../core/util.ts";
import { type Capacity, capacityFor } from "./resources.ts";

/** This machine's capacity as config/machine.json says it now; an uninitialised machine gets the defaults. */
export function machineCapacity(): Capacity {
    const machine: Machine = hasMachine() ? loadMachine() : { name: "", role: "coordinator" };
    return capacityFor(machine, availableParallelism());
}

/**
 * A waiter's capacity, read again on each call, starting from `first`, the capacity it joined the line with. A
 * config/machine.json that cannot be read right now (mid-edit, invalid) keeps the last capacity read instead of
 * failing the build.
 */
export function capacityWhileWaiting(first: Capacity): () => Capacity {
    let last = first;
    return () => {
        try {
            last = machineCapacity();
        } catch (err) {
            if (!(err instanceof ToliError)) throw err;
        }
        return last;
    };
}
