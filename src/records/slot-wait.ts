// A task parked for a free jawan slot on this machine (docs/fleet.md "Oversight"). `task wait --on` takes
// free text, so the wait's text decides: one that starts with "slot" ("slot", "slot: after T610", "slot (3/3 busy)")
// or with "free slot" after an optional "a", "the" or "next", with at most one word between "free" and "slot"
// ("a free slot", "next free slot", "next free WEB slot (3/3 busy)"). Such a task waits only for capacity here, so it
// is queue like a queued task. Any other wait (a person, a release, a push, another machine, "a build machine ... when
// a slot frees") is not.
import type { Task } from "./backlog.ts";

const SLOT_WAIT = /^(?:(?:a|the|next)\s+)*(?:free\s+(?:[\w.-]+\s+)?)?slots?\b/i;

/** Whether `task` is active and parked with `task wait` on a free jawan slot here. */
export function waitsForSlot(task: Pick<Task, "status" | "waitingOn">): boolean {
    return task.status === "active" && task.waitingOn !== undefined && SLOT_WAIT.test(task.waitingOn.trim());
}
