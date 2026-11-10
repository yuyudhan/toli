// A machine's work queue (docs/sardars.md): what ranks machines for new work, published in `resources --json`.
import { type JawanRun, listRuns, RUNNING } from "../jawans/runs.ts";
import { loadBacklog, type Task } from "../records/backlog.ts";
import { currentFull, type Full } from "./full.ts";

/**
 * The machine's work queue: its own backlog's queued, active and held tasks, and its jawan runs holding a slot or
 * waiting for one. `depth` is the work waiting on or using its jawans: queued tasks + running jawans + queued runs.
 * Active tasks are not counted (a lead's bookkeeping tasks and work delegated elsewhere are active with no jawan
 * here). Machines rank by `depth` per jawan slot (src/fleet/pick.ts). `full`: its lead takes no more work.
 */
export type Queue = {
    queued: number;
    active: number;
    held: number;
    jawansRunning: number;
    jawansQueued: number;
    depth: number;
    full?: Full;
};

/**
 * The queued tasks that wait for a jawan: no run of this machine (running or waiting for a slot) works on them and
 * no other machine has them (an open delegation). Only these count as queue and only these are offered to another lead.
 */
export function waitingTasks(tasks: Task[] = loadBacklog().tasks, runs: JawanRun[] = listRuns()): Task[] {
    const working = new Set(
        runs
            .filter((entry) => entry.status === "queued" || RUNNING.includes(entry.status))
            .flatMap((entry) => (entry.task === null ? [] : [entry.task])),
    );
    const delegatedAway = (task: Task): boolean =>
        (task.delegatedTo ?? []).some((id) => {
            const state = task.delegates?.[id];
            return state === undefined || (state.status !== "dropped" && state.handedBack === undefined);
        });
    return tasks.filter((task) => task.status === "queued" && !working.has(task.id) && !delegatedAway(task));
}

/** This machine's queue, from its own backlog and jawan run records. */
export function localQueue(): Queue {
    const tasks = loadBacklog().tasks;
    const count = (status: string): number => tasks.filter((task) => task.status === status).length;
    const runs = listRuns();
    const queued = waitingTasks(tasks, runs).length;
    const jawansRunning = runs.filter((entry) => RUNNING.includes(entry.status)).length;
    const jawansQueued = runs.filter((entry) => entry.status === "queued").length;
    const full = currentFull();
    return {
        queued,
        active: count("active"),
        held: count("held"),
        jawansRunning,
        jawansQueued,
        depth: queued + jawansRunning + jawansQueued,
        ...(full === null ? {} : { full }),
    };
}

/** Queue depth per jawan slot, to two decimals: what ranks machines. */
export function perSlot(depth: number, slots: number): number {
    return Math.round((depth / Math.max(1, slots)) * 100) / 100;
}

/** `queue <depth> (<q> queued, <r> running + <w> waiting; <a> active, <h> held)`, or `queue unknown`. */
export function queueText(queue: Queue | null): string {
    if (queue === null) return "queue unknown";
    const text = `queue ${queue.depth} (${queue.queued} queued, ${queue.jawansRunning} running + ${queue.jawansQueued} waiting; ${queue.active} active, ${queue.held} held)`;
    return queue.full === undefined ? text : `full: ${queue.full.reason}; ${text}`;
}
