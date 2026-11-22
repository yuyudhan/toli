// A task parked for a free jawan slot on this machine (docs/fleet.md "Oversight", "Waits on a free slot are queue").
// `task wait --on` takes free text, so the wait's text decides, trimmed and in any case. It counts when it:
//   1. starts with `slot`, or with `free slot` optionally after one `a`, `the` or `next`, with at most one word of
//      letters and digits between `free` and `slot` that is not a non-jawan slot kind (NOT_JAWAN: build, ci, cpu,
//      deploy, gpu, meeting, release, review, test);
//   2. then ends, or goes on with `:`, `;`, `,` or `(` (spaces allowed before) or with the word `after`;
//   3. and nowhere names another fleet machine as `on <machine>`.
// "slot", "slot: after T610", "slot (3/3 busy)", "a free slot", "next free web slot, after T610" count; "slot 3 on
// m3", "next free slot on m3", "slot machine", "slots", "a free gpu slot", "the next free slot" do not. Such a task
// waits only for capacity here, so it is queue like a queued task; any other wait (a person, a release, a push,
// another machine) is not.
import type { Task } from "./backlog.ts";

const SLOT_WAIT = /^(?:slot|(?:(?:a|the|next)\s+)?free\s+(?:([a-z0-9]+)\s+)?slot)(?=$|\s*[:;,(]|\s+after\b)/i;
const NOT_JAWAN = new Set(["build", "ci", "cpu", "deploy", "gpu", "meeting", "release", "review", "test"]);

/**
 * Whether `task` is active and parked with `task wait` on a free jawan slot here; `otherMachines` are the other fleet
 * machines' names, so a wait `on <one of them>` is that machine's, not queue here.
 */
export function waitsForSlot(task: Pick<Task, "status" | "waitingOn">, otherMachines: readonly string[]): boolean {
    if (task.status !== "active" || task.waitingOn === undefined) return false;
    const text = task.waitingOn.trim().toLowerCase();
    const head = SLOT_WAIT.exec(text);
    if (head === null || NOT_JAWAN.has(head[1] ?? "")) return false;
    const others = new Set(otherMachines.map((name) => name.toLowerCase()));
    return ![...text.matchAll(/\bon\s+([\w.-]+)/g)].some((match) => others.has((match[1] ?? "").replace(/\.+$/, "")));
}
