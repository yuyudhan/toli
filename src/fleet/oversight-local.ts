// One machine's own part of `bin/toli fleet check` (src/fleet/oversight.ts): its stale active tasks, waiting work,
// peer listener and low battery, as `fleet check --local --json` reports them for the coordinator to read over ssh.
import { hasMachine, loadMachine } from "../core/config.ts";
import { isJsonObject, now } from "../core/util.ts";
import { listenerProblem } from "../peer/supervise.ts";
import type { Task } from "../records/backlog.ts";
import { findStaleTasks, redispatchCommand, staleLine } from "../records/stale.ts";
import { lowBatteryText } from "./battery.ts";
import { waitingTasks } from "./queue.ts";

/** Work that waits for a machine: a queued task, or an active one no live run works on. */
export type WaitingWork = { id: string; project: string; status: string; title: string };

/** One machine's own backlog, as `fleet check --local --json` reports it. */
export type LocalOversight = {
    machine: string;
    /** One line per stale active task (src/records/stale.ts staleLine), with what to do about it. */
    stale: { line: string; command: string }[];
    waiting: WaitingWork[];
    /** Why its configured peer listener does not serve, or null (absent from an older toli's report). */
    listener: string | null;
    /**
     * The low-battery alert's line when this machine, one others depend on, is discharging under its threshold
     * (src/fleet/battery.ts); null otherwise, and absent from an older toli's report.
     */
    battery: string | null;
};

/** This machine's stale active tasks and waiting work, from its own backlog, its peer listener, and a low battery. */
export function localOversight(tasks: Task[], at: Date = now()): LocalOversight {
    // A task waiting on something (`task wait`) needs no dispatch, so it is neither stale nor waiting work here, unless
    // it is a slot wait the queue counts (src/fleet/queue.ts waitingTasks: not run here, not delegated away): an idle
    // machine can take that.
    const stale = findStaleTasks(tasks, at).filter((task) => task.reason !== "waiting");
    const staleIds = new Set(stale.map((task) => task.id));
    const slotWaits = new Set(
        waitingTasks(tasks)
            .filter((task) => task.status === "active")
            .map((task) => task.id),
    );
    return {
        machine: hasMachine() ? loadMachine().name : "(unnamed)",
        stale: stale.map((task) => ({ line: staleLine(task, at), command: redispatchCommand(task) })),
        waiting: tasks
            .filter(
                (task) =>
                    task.status === "queued" ||
                    slotWaits.has(task.id) ||
                    (task.status === "active" && staleIds.has(task.id)),
            )
            .map((task) => ({ id: task.id, project: task.project, status: task.status, title: task.title })),
        listener: listenerProblem(),
        battery: hasMachine() ? lowBatteryText(loadMachine()) : null,
    };
}

/** Parse another machine's `fleet check --local --json`, rejecting anything not shaped like one. */
export function parseLocalOversight(text: string): LocalOversight {
    const value: unknown = JSON.parse(text);
    if (!isJsonObject(value) || typeof value.machine !== "string") throw new Error("not a fleet check report");
    const list = (key: string): Record<string, unknown>[] => {
        const entries = value[key];
        if (!Array.isArray(entries) || !entries.every(isJsonObject)) throw new Error(`field ${key} is not a list`);
        return entries;
    };
    const str = (entry: Record<string, unknown>, key: string): string => {
        const field = entry[key];
        if (typeof field !== "string") throw new Error(`field ${key} is not a string`);
        return field;
    };
    const listener = value.listener;
    const battery = value.battery;
    return {
        machine: value.machine,
        stale: list("stale").map((entry) => ({ line: str(entry, "line"), command: str(entry, "command") })),
        waiting: list("waiting").map((entry) => ({
            id: str(entry, "id"),
            project: str(entry, "project"),
            status: str(entry, "status"),
            title: str(entry, "title"),
        })),
        listener: typeof listener === "string" ? listener : null,
        battery: typeof battery === "string" ? battery : null,
    };
}
