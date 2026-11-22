// A machine's work queue (docs/sardars.md): what ranks machines for new work, published in `resources --json`.
import { otherFleetMachines } from "../core/config.ts";
import { now } from "../core/util.ts";
import { type JawanRun, listRuns, RUNNING } from "../jawans/runs.ts";
import { agentState, delegatedAway, nativeAgent } from "../records/agents.ts";
import { loadBacklog, type Task } from "../records/backlog.ts";
import { waitsForSlot } from "../records/slot-wait.ts";
import { staleTaskMinutes } from "../records/stale.ts";
import { currentFull, type Full } from "./full.ts";

/**
 * The machine's work queue: its own backlog's queued, active and held tasks, and its jawans. `depth` is the work
 * waiting on or using its jawans: queued tasks + tasks parked for a free slot here (`slotWaits`,
 * src/records/slot-wait.ts) + running jawans + queued runs. `jawansRunning` counts the `bin/toli spawn` runs holding
 * a slot and the native harness subagents working on its tasks (`subagentJawans`), and `subagents` is that second
 * part. Other active tasks are not counted (a lead's bookkeeping tasks, work delegated elsewhere, a task waiting on
 * anything but a slot here).
 * Machines rank by `depth` per jawan slot (src/fleet/pick.ts). `full`: its lead takes no more work.
 */
export type Queue = {
    queued: number;
    /** Active tasks parked with `task wait` for a free slot here; absent from machines on an older toli. */
    slotWaits?: number;
    active: number;
    held: number;
    jawansRunning: number;
    /** The native subagent jawans among `jawansRunning`; absent from machines on an older toli. */
    subagents?: number;
    jawansQueued: number;
    depth: number;
    full?: Full;
};

/** The ids of the tasks a run of this machine works on, running or waiting for a slot. */
function workedByRuns(runs: JawanRun[]): Set<string> {
    return new Set(
        runs
            .filter((entry) => entry.status === "queued" || RUNNING.includes(entry.status))
            .flatMap((entry) => (entry.task === null ? [] : [entry.task])),
    );
}

/**
 * The tasks that wait for a jawan: queued, or parked for a free slot here (`waitsForSlot`), that no run of this machine
 * (running or waiting for a slot) works on and no other machine has (an open delegation). Only these count as queue and
 * only these are offered to another lead; `fleet check` and the idle-machine watchdog take their slot waits from here
 * too, so the three never disagree.
 */
export function waitingTasks(tasks: Task[] = loadBacklog().tasks, runs: JawanRun[] = listRuns()): Task[] {
    const working = workedByRuns(runs);
    const others = otherFleetMachines().map((machine) => machine.name);
    return tasks.filter(
        (task) =>
            (task.status === "queued" || waitsForSlot(task, others)) && !working.has(task.id) && !delegatedAway(task),
    );
}

/**
 * The native harness subagents working on this machine's tasks, one per distinct agent id: active tasks whose jawan
 * was recorded with `task start --agent <id>` (a native agent, src/records/agents.ts) and that is running now: the
 * live lead session that recorded it has not seen it end, or, recorded outside a session, it reports running or was
 * recorded less than the grace minutes ago. Left out: a task a live run works on (counted as that run), one waiting
 * on something (`task wait`), and one whose subagent ended, died with its session or, outside a session, stopped
 * reporting (oversight lists it for a re-dispatch, src/records/stale.ts). This is the same agentState the stale-task
 * check reads, so the two never disagree. A subagent recorded on no open task (a lead's scout, reviewer or verifier)
 * takes no jawan slot: its heavy work, if any, waits for a heavy-build slot (the cargo shim, the Node preload, the bun
 * shim), and counting it would put a lead at cap with one helper, or deadlock a helper that waits on a run it spawned.
 */
export function subagentJawans(
    tasks: Task[],
    runs: JawanRun[],
    at: Date = now(),
    graceMinutes: number = staleTaskMinutes(),
): number {
    const working = workedByRuns(runs);
    const agents = new Set(
        tasks.flatMap((task) =>
            task.status === "active" &&
            nativeAgent(task) &&
            task.waitingOn === undefined &&
            !working.has(task.id) &&
            agentState(task, at, graceMinutes).state === "live"
                ? [task.agent]
                : [],
        ),
    );
    return agents.size;
}

/** This machine's queue, from its own backlog and jawan run records. */
export function localQueue(): Queue {
    const tasks = loadBacklog().tasks;
    const count = (status: string): number => tasks.filter((task) => task.status === status).length;
    const runs = listRuns();
    const waiting = waitingTasks(tasks, runs);
    const queued = waiting.filter((task) => task.status === "queued").length;
    const slotWaits = waiting.length - queued;
    const subagents = subagentJawans(tasks, runs);
    const jawansRunning = runs.filter((entry) => RUNNING.includes(entry.status)).length + subagents;
    const jawansQueued = runs.filter((entry) => entry.status === "queued").length;
    const full = currentFull();
    return {
        queued,
        slotWaits,
        active: count("active"),
        held: count("held"),
        jawansRunning,
        subagents,
        jawansQueued,
        depth: waiting.length + jawansRunning + jawansQueued,
        ...(full === null ? {} : { full }),
    };
}

/** Queue depth per jawan slot, to two decimals: what ranks machines. */
export function perSlot(depth: number, slots: number): number {
    return Math.round((depth / Math.max(1, slots)) * 100) / 100;
}

/**
 * `queue <depth> (<q> queued[ + <s> waiting for a slot], <r> running + <w> waiting; <a> active, <h> held)`, or
 * `queue unknown`. The slot waits show only when there are any.
 */
export function queueText(queue: Queue | null): string {
    if (queue === null) return "queue unknown";
    const slotWaits = queue.slotWaits ?? 0;
    const waits = slotWaits === 0 ? "" : ` + ${slotWaits} waiting for a slot`;
    const text = `queue ${queue.depth} (${queue.queued} queued${waits}, ${queue.jawansRunning} running + ${queue.jawansQueued} waiting; ${queue.active} active, ${queue.held} held)`;
    return queue.full === undefined ? text : `full: ${queue.full.reason}; ${text}`;
}

/**
 * The machine's jawans against its jawan slots (`capacity.maxRuns`): `jawans <n>/<slots>`, with the native subagent
 * jawans among them, and `jawans at cap <n>/<slots> (...): queue instead` once every slot is taken. Native subagents
 * share the cap with `bin/toli spawn` runs: a lead at cap queues new work (`bin/toli task add`, or `bin/toli spawn`,
 * which queues the run) instead of starting another subagent.
 */
export function slotText(queue: Pick<Queue, "jawansRunning" | "subagents">, slots: number): string {
    const subagents = queue.subagents ?? 0;
    const native = subagents === 0 ? "" : ` (${subagents} native subagent${subagents === 1 ? "" : "s"})`;
    const count = `${queue.jawansRunning}/${slots}`;
    return queue.jawansRunning >= slots ? `jawans at cap ${count}${native}: queue instead` : `jawans ${count}${native}`;
}
