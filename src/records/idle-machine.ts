// A machine that stopped working while work waits (docs/fleet.md "Oversight"): a provider's rate limit can stop every
// agent on a machine, its lead included, and nothing starts them again until someone looks. With queued or active
// work and no agent activity for `oversight.idleMachineMinutes` (default 30), the tick re-dispatches the stopped
// jawans (src/records/redispatch.ts, which then also takes subagents that stopped reporting) and, when no lead session
// lives here, alerts the coordinator and the machines that delegated the waiting work, once per idle spell. toli never
// kills or signals a live omp. Activity is what agents leave in toli's records: a jawan run running, started or
// ended, a subagent's report, a lead turn.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fleetMachine, hasMachine, loadMachine, machineSettings } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, readJson, stamp, ToliError, warn, withLock, writeJsonAtomic } from "../core/util.ts";
import { interactiveLeadPid, readLeadState, turnPid } from "../fleet/lead-state.ts";
import { type JawanRun, listRuns, RUNNING } from "../jawans/runs.ts";
import { notify, sendToMachine } from "../jobs/outbox.ts";
import type { AgentReport } from "./agents.ts";
import type { Task } from "./backlog.ts";

export const DEFAULT_IDLE_MACHINE_MINUTES = 30;

/** `oversight.idleMachineMinutes`: how long a machine with waiting work may show no agent activity. */
export function idleMachineMinutes(): number {
    const raw: unknown = machineSettings().oversight?.idleMachineMinutes;
    if (raw === undefined) return DEFAULT_IDLE_MACHINE_MINUTES;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)
        throw new ToliError("config/machine.json oversight.idleMachineMinutes must be a positive number");
    return raw;
}

/** Every subagent report's last beat or end (state/agents/*.json). */
function agentTimes(): string[] {
    const dir = join(paths.root(), "state", "agents");
    let files: string[];
    try {
        files = readdirSync(dir).filter((file) => file.endsWith(".json"));
    } catch {
        return [];
    }
    return files.flatMap((file) => {
        const report = readJson<Partial<AgentReport> | null>(join(dir, file), null);
        return [report?.at, report?.endedAt].filter((time): time is string => typeof time === "string");
    });
}

/**
 * The last agent activity on this machine (ms): `at` itself while a jawan run or a lead turn is running, else the
 * newest run start or end, subagent report and lead turn; null when nothing ever ran.
 */
export function lastActivityMs(runs: JawanRun[], at: Date): number | null {
    const lead = readLeadState();
    if (runs.some((run) => RUNNING.includes(run.status)) || turnPid(lead) !== null) return at.getTime();
    const times = [...runs.flatMap((run) => [run.startedAt, run.endedAt]), ...agentTimes(), lead.lastTurnAt]
        .map((time) => (time ? Date.parse(time) : Number.NaN))
        .filter(Number.isFinite);
    return times.length === 0 ? null : Math.max(...times);
}

type IdleState = { alerted?: string };

/** What the watchdog found: whether the machine is idle (minutes without activity) and the lines to log. */
export type IdleMachine = { idleMinutes: number | null; lines: string[] };

/** Tell the coordinator (on a worker) and every machine that delegated waiting work that this machine stopped. */
function alert(waiting: Task[], minutes: number): string {
    const machine = loadMachine();
    const title = `${machine.name}: no agent activity for ${minutes} min with ${waiting.length} task${waiting.length === 1 ? "" : "s"} waiting, and no live lead session`;
    const body = [
        `${machine.name} has queued or active work, no jawan, subagent or lead turn active for ${minutes} minutes, and no lead session alive (its Sardar's omp is gone). toli re-dispatches the jawans that stopped; the lead itself needs starting there: \`bin/toli fleet start\` from the coordinator, or \`bin/toli lead attach\` on ${machine.name}. toli never kills or signals a live omp.`,
        "",
        ...waiting.slice(0, 20).map((task) => `- ${task.id} (${task.project}, ${task.status}): ${task.title}`),
    ].join("\n");
    const sent = [`inbox ${notify(machine, title, body, `idle-${machine.name}-${stamp()}`)}`];
    const delegators = new Set(waiting.flatMap((task) => (task.delegatedBy ? [task.delegatedBy.machine] : [])));
    delegators.delete(machine.name);
    for (const name of delegators) {
        try {
            const result = sendToMachine(
                machine.name,
                fleetMachine(name),
                title,
                body,
                `idle-${machine.name}-${name}-${stamp()}`,
            );
            sent.push(result.delivered ? name : `${name} (queued)`);
        } catch (error) {
            warn(`idle alert to ${name} not sent: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return sent.join(", ");
}

/**
 * The tick's idle-machine watchdog over this machine's backlog `tasks`: the minutes without agent activity when work
 * waits and that is over `oversight.idleMachineMinutes`, else null; with no live lead session it alerts once per idle
 * spell (keyed by the last activity).
 */
export function watchIdleMachine(tasks: Task[], at: Date = now()): IdleMachine {
    const waiting = tasks.filter(
        (task) => task.status === "queued" || (task.status === "active" && task.waitingOn === undefined),
    );
    if (waiting.length === 0 || !hasMachine()) return { idleMinutes: null, lines: [] };
    const last = lastActivityMs(listRuns(), at);
    const minutes = last === null ? null : Math.floor((at.getTime() - last) / 60_000);
    if (minutes === null || minutes < idleMachineMinutes()) return { idleMinutes: null, lines: [] };
    if (interactiveLeadPid() !== null || turnPid(readLeadState()) !== null) return { idleMinutes: minutes, lines: [] };
    const spell = new Date(last ?? 0).toISOString();
    const alerted = withLock(paths.lock("idle-machine"), () => {
        const state = readJson<IdleState>(paths.idleMachineState(), {});
        if (state.alerted === spell) return false;
        writeJsonAtomic(paths.idleMachineState(), { alerted: spell } satisfies IdleState);
        return true;
    });
    const lines = alerted
        ? [
              `no agent activity for ${minutes} min with work waiting and no live lead session: alerted ${alert(waiting, minutes)}`,
          ]
        : [];
    return { idleMinutes: minutes, lines };
}
