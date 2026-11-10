// A machine's work queue (docs/sardars.md): what ranks machines for new work, published in `resources --json`.
import { listRuns, RUNNING } from "../jawans/runs.ts";
import { loadBacklog } from "../records/backlog.ts";

/**
 * The machine's work queue: its own backlog's queued, active and held tasks, and its jawan runs holding a slot or
 * waiting for one. `depth` (queued + active tasks + queued runs) is what ranks machines for new work.
 */
export type Queue = {
    queued: number;
    active: number;
    held: number;
    jawansRunning: number;
    jawansQueued: number;
    depth: number;
};

/** This machine's queue, from its own backlog and jawan run records. */
export function localQueue(): Queue {
    const tasks = loadBacklog().tasks;
    const count = (status: string): number => tasks.filter((task) => task.status === status).length;
    const runs = listRuns();
    const queued = count("queued");
    const active = count("active");
    const jawansQueued = runs.filter((entry) => entry.status === "queued").length;
    return {
        queued,
        active,
        held: count("held"),
        jawansRunning: runs.filter((entry) => RUNNING.includes(entry.status)).length,
        jawansQueued,
        depth: queued + active + jawansQueued,
    };
}

/** `queue <depth> (queued/active/held, jawans running+queued)`, or `queue unknown` from an older toli. */
export function queueText(queue: Queue | null): string {
    if (queue === null) return "queue unknown";
    return `queue ${queue.depth} (${queue.queued}/${queue.active}/${queue.held}, jawans ${queue.jawansRunning}+${queue.jawansQueued})`;
}
