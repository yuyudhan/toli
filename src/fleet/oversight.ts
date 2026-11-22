// `bin/toli fleet check` (the other `fleet` subcommands: src/fleet/fleet-command.ts). The check is oversight that
// never pauses, away mode included: every reachable machine with no running jawan (no spawn run and no native
// subagent) while queued work (or an active task no live run works on) exists for a project cloned there is an idle
// machine, every active task with no live run on this machine or any reachable one is named, and so is every machine
// whose configured peer listener is down. Most other machines unreachable the same way read as one network fault, not
// one fault per host. `--wake` posts the findings as one inbox item (a `[toli wake]` for the lead); the coordinator's
// tick starts `fleet check --wake` every `oversight.fleetCheckMinutes` (default 60), so no job prompt can skip it.
import { spawn as spawnChild } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Args } from "../core/args.ts";
import {
    type FleetMachine,
    hasMachine,
    inboundOff,
    loadMachine,
    machineSettings,
    otherFleetMachines,
    remoteToliCommand,
    sshArgs,
} from "../core/config.ts";
import { paths } from "../core/paths.ts";
import {
    isJsonObject,
    now,
    out,
    printJson,
    readJson,
    runAsync,
    ToliError,
    withLock,
    writeJsonAtomic,
} from "../core/util.ts";
import { listenerProblem } from "../peer/supervise.ts";
import { loadBacklog, type Task } from "../records/backlog.ts";
import { addInboxItem } from "../records/inbox.ts";
import { findStaleTasks, redispatchCommand, staleLine } from "../records/stale.ts";
import { fleetStatus } from "./fleet-probe.ts";
import { commonNetworkFault, type NetworkFaultGroup, networkFaultLine } from "./network-fault.ts";
import type { FleetEntry } from "./resources.ts";

export const DEFAULT_FLEET_CHECK_MINUTES = 60;
const REMOTE_CONNECT_SECONDS = 10;
const REMOTE_CAP_MS = 30_000;

/** This CLI (not paths.toliBin(): TOLI_ROOT may point the data elsewhere, as in tests). */
const TOLI_SCRIPT = resolve(import.meta.dir, "..", "..", "bin", "toli");

/** `oversight.fleetCheckMinutes`: how often the coordinator's tick runs `fleet check --wake`. */
export function fleetCheckMinutes(): number {
    const raw = machineSettings().oversight?.fleetCheckMinutes;
    if (raw === undefined) return DEFAULT_FLEET_CHECK_MINUTES;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)
        throw new ToliError("config/machine.json oversight.fleetCheckMinutes must be a positive number");
    return raw;
}

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
};

export type IdleMachine = { machine: string; waiting: WaitingWork[] };

export type FleetCheck = {
    at: string;
    /** Every fleet machine, this one included. */
    machines: number;
    /** More than half of `machines` are unreachable or unchecked: what the check found says nothing of the rest. */
    blind: boolean;
    /** Stale active tasks per machine whose backlog holds them. */
    stale: { machine: string; line: string; command: string }[];
    idle: IdleMachine[];
    /** Machines whose configured peer listener is down or stuck on a replaced runtime. */
    listeners: { machine: string; problem: string }[];
    unreachable: { machine: string; reason: string }[];
    /** Most other machines unreachable the same way: one fault of the network here, not of each host. */
    networkFault: NetworkFaultGroup | null;
    /** Reachable machines whose own backlog could not be read (an older toli there). */
    unchecked: { machine: string; reason: string }[];
};

/**
 * `BLIND: N of M machines <what> (<names>)` when more than half of `machines` are among `missing`, else null: an
 * answer about the rest of the fleet is then no answer about the fleet.
 */
export function blindText(machines: number, missing: readonly { machine: string }[], what: string): string | null {
    if (missing.length * 2 <= machines) return null;
    return `BLIND: ${missing.length} of ${machines} machines ${what} (${missing.map((entry) => entry.machine).join(", ")})`;
}

/** This machine's stale active tasks and waiting work, from its own backlog, and its peer listener. */
export function localOversight(tasks: Task[], at: Date = now()): LocalOversight {
    // A task waiting on something (`task wait`) needs no dispatch, so it is neither stale nor waiting work here.
    const stale = findStaleTasks(tasks, at).filter((task) => task.reason !== "waiting");
    const staleIds = new Set(stale.map((task) => task.id));
    return {
        machine: hasMachine() ? loadMachine().name : "(unnamed)",
        stale: stale.map((task) => ({ line: staleLine(task, at), command: redispatchCommand(task) })),
        waiting: tasks
            .filter((task) => task.status === "queued" || (task.status === "active" && staleIds.has(task.id)))
            .map((task) => ({ id: task.id, project: task.project, status: task.status, title: task.title })),
        listener: listenerProblem(),
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
    };
}

/**
 * The findings: idle machines (reachable, no running jawan) with waiting work for a project cloned there, from this
 * machine's backlog and the machine's own, every stale active task, and every configured peer listener that is down.
 * `reports` maps a machine to its own backlog's report, or the reason it could not be read.
 */
export function checkFleet(
    entries: FleetEntry[],
    reports: Map<string, LocalOversight | string>,
    at: Date = now(),
): FleetCheck {
    const self = entries.find((entry) => entry.local)?.machine ?? "";
    const own = reports.get(self);
    const shared = typeof own === "object" ? own.waiting : [];
    const check: FleetCheck = {
        at: at.toISOString(),
        machines: entries.length,
        blind: false,
        stale: [],
        idle: [],
        listeners: [],
        unreachable: [],
        networkFault: commonNetworkFault(entries),
        unchecked: [],
    };
    for (const entry of entries) {
        if (!entry.reachable || entry.resources === null) {
            check.unreachable.push({ machine: entry.machine, reason: entry.reasons.join("; ") || "not reachable" });
            continue;
        }
        const report = reports.get(entry.machine);
        if (typeof report === "string") check.unchecked.push({ machine: entry.machine, reason: report });
        const mine = typeof report === "object" ? report : undefined;
        for (const stale of mine?.stale ?? []) check.stale.push({ machine: entry.machine, ...stale });
        if (mine?.listener) check.listeners.push({ machine: entry.machine, problem: mine.listener });
        // Busy when any jawan runs: spawn runs and the native subagents a lead starts in its session (the queue's
        // jawansRunning, as `fleet queues` shows it); `activeRuns` alone misses the subagents.
        if (entry.resources.activeRuns > 0 || (entry.resources.queue?.jawansRunning ?? 0) > 0) continue;
        const clones = new Set(entry.resources.projects);
        const seen = new Set<string>();
        const waiting = [...shared, ...(entry.machine === self ? [] : (mine?.waiting ?? []))].filter((work) => {
            const key = `${work.id}:${work.project}`;
            if (!clones.has(work.project) || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        if (waiting.length > 0) check.idle.push({ machine: entry.machine, waiting });
    }
    check.blind = (check.unreachable.length + check.unchecked.length) * 2 > check.machines;
    return check;
}

/** Whether the check found anything the lead must act on: a blind check is one. */
export function needsAction(check: FleetCheck): boolean {
    return check.blind || check.stale.length > 0 || check.idle.length > 0 || check.listeners.length > 0;
}

function listenersDown(check: FleetCheck): string {
    const count = check.listeners.length;
    return count === 0 ? "" : `, ${count} peer listener${count === 1 ? "" : "s"} down`;
}

/**
 * The one batched message: blindness first, then stale tasks, idle machines, down listeners, and what was not
 * checked. A blind check is never "all clear".
 */
export function fleetCheckText(check: FleetCheck): string {
    const missing = [...check.unreachable, ...check.unchecked];
    const blind = check.blind ? `${blindText(check.machines, missing, "not checked")}, ` : "";
    const fault = check.networkFault === null ? [] : [networkFaultLine(check.networkFault)];
    const grouped = new Set(check.networkFault?.machines ?? []);
    const unreachable = check.unreachable.filter((entry) => !grouped.has(entry.machine));
    if (!needsAction(check)) {
        const notes = [
            ...fault,
            ...[...unreachable, ...check.unchecked].map((entry) => `${entry.machine} (${entry.reason})`),
        ];
        return `fleet check at ${check.at}: all clear, no idle machine has waiting work and no active task lacks a live run${notes.length === 0 ? "" : `; not checked: ${notes.join(", ")}`}`;
    }
    const found = check.stale.length > 0 || check.idle.length > 0 || check.listeners.length > 0;
    const lines = found
        ? [
              `fleet check at ${check.at}: ${blind}${check.stale.length} active task${check.stale.length === 1 ? "" : "s"} with no live run, ${check.idle.length} idle machine${check.idle.length === 1 ? "" : "s"} with waiting work${listenersDown(check)}`,
              "Lead: dispatch now (toli-dispatch skill), spreading the waiting work over the idle machines; away mode changes nothing here.",
          ]
        : [`fleet check at ${check.at}: ${blind}so no all clear: what they run is unknown`];
    if (check.blind)
        lines.push(
            "Lead: find out why they cannot be reached (bin/toli fleet status; ssh, VPN, a machine asleep, swapping or overloaded) before trusting any fleet answer.",
        );
    if (check.stale.length > 0) {
        lines.push("", "Active tasks with no live run:");
        for (const entry of check.stale) lines.push(`- [${entry.machine}] ${entry.line}`, `  ${entry.command}`);
    }
    if (check.idle.length > 0) {
        lines.push("", "Idle machines (no running jawan) with waiting work for their clones:");
        for (const entry of check.idle)
            lines.push(
                `- ${entry.machine}: ${entry.waiting.map((work) => `${work.id} (${work.project}, ${work.status}): ${work.title}`).join("; ")}`,
            );
    }
    if (check.listeners.length > 0) {
        lines.push(
            "",
            "Peer listeners configured but down (that machine's lead service restarts its listener within seconds, so one still down means its lead service is not running there; bin/toli doctor on it says why):",
        );
        for (const entry of check.listeners) lines.push(`- ${entry.machine}: ${entry.problem}`);
    }
    if (fault.length > 0 || unreachable.length > 0 || check.unchecked.length > 0) {
        lines.push("", "Not checked:");
        for (const line of fault) lines.push(`- ${line}`);
        for (const entry of unreachable) lines.push(`- ${entry.machine}: ${entry.reason}`);
        for (const entry of check.unchecked) lines.push(`- ${entry.machine}: its own backlog (${entry.reason})`);
    }
    return lines.join("\n");
}

/**
 * One machine's own backlog over ssh, or why it was not checked. A machine that takes no inbound ssh may still answer
 * its status over HTTPS (a paired peer), so fleet status counts it reachable; it is never ssh-ed into.
 */
async function remoteReport(machine: FleetMachine): Promise<LocalOversight | string> {
    if (inboundOff(machine)) return "pull-only, not checked";
    let args: string[];
    try {
        args = sshArgs(machine.ssh, REMOTE_CONNECT_SECONDS);
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    const result = await runAsync([...args, remoteToliCommand(machine.root, "fleet check --local --json")], {
        timeoutMs: REMOTE_CAP_MS,
    });
    if (result.timedOut) return `no answer from ${machine.ssh} within ${REMOTE_CAP_MS / 1000}s`;
    if (result.code !== 0)
        return `ssh ${machine.ssh} exited ${result.code}: ${(result.stderr || result.stdout).trim().split("\n")[0] ?? ""}`;
    try {
        return parseLocalOversight(result.stdout);
    } catch (error) {
        return `bad fleet check output: ${error instanceof Error ? error.message : String(error)}`;
    }
}

/** Probe the fleet and every reachable machine's own backlog, and check them. */
export async function runFleetCheck(at: Date = now()): Promise<FleetCheck> {
    const entries = await fleetStatus();
    const reachable = new Set(entries.filter((entry) => entry.reachable).map((entry) => entry.machine));
    const remotes = otherFleetMachines().filter((machine) => reachable.has(machine.name));
    const reports = new Map<string, LocalOversight | string>();
    const self = entries.find((entry) => entry.local)?.machine;
    if (self !== undefined) reports.set(self, localOversight(loadBacklog().tasks, at));
    const remote = await Promise.all(remotes.map(remoteReport));
    remotes.forEach((machine, index) => {
        reports.set(machine.name, remote[index] ?? "no report");
    });
    return checkFleet(entries, reports, at);
}

/** Post the findings as one inbox item when the lead must act; returns the item's path, else null. */
export function postFleetCheck(check: FleetCheck): string | null {
    if (!needsAction(check)) return null;
    const found = check.stale.length > 0 || check.idle.length > 0 || check.listeners.length > 0;
    const findings = `${check.stale.length} stale task${check.stale.length === 1 ? "" : "s"}, ${check.idle.length} idle machine${check.idle.length === 1 ? "" : "s"} with waiting work${listenersDown(check)}`;
    const missing = check.unreachable.length + check.unchecked.length;
    const blind = check.blind ? `BLIND, ${missing} of ${check.machines} machines not checked` : "";
    const title = [blind, found ? findings : ""].filter((part) => part !== "").join("; ");
    return addInboxItem(hasMachine() ? loadMachine().name : "toli", `fleet check: ${title}`, fleetCheckText(check));
}

type FleetCheckState = { lastStarted?: string };

/**
 * Claim a due fleet check under a lock (the last start is at least `fleetCheckMinutes` ago), so two ticks never
 * start two. Coordinators only: workers' backlogs are read through the coordinator's check.
 */
function claimFleetCheck(at: Date): boolean {
    if (!hasMachine() || loadMachine().role !== "coordinator") return false;
    const intervalMs = fleetCheckMinutes() * 60_000;
    return withLock(paths.lock("fleet-check"), () => {
        const state = readJson<FleetCheckState>(paths.fleetCheckState(), {});
        const last = state.lastStarted === undefined ? Number.NaN : Date.parse(state.lastStarted);
        if (Number.isFinite(last) && at.getTime() - last < intervalMs) return false;
        writeJsonAtomic(paths.fleetCheckState(), { lastStarted: at.toISOString() });
        return true;
    });
}

/**
 * Called by the coordinator's tick: when a fleet check is due, run it. With other fleet machines it goes over ssh,
 * so it starts detached (`bin/toli fleet check --wake`, output in logs/fleet-check.log) and the tick never waits on
 * the network; a lone machine is checked in-process. Returns the log line, or null when none is due.
 */
export async function runDueFleetCheck(at: Date = now()): Promise<string | null> {
    if (!claimFleetCheck(at)) return null;
    if (otherFleetMachines().length === 0) {
        const posted = postFleetCheck(await runFleetCheck(at));
        return `fleet check: ${posted === null ? "all clear" : `posted ${relative(paths.root(), posted)}`}`;
    }
    mkdirSync(paths.logsDir(), { recursive: true });
    const log = openSync(paths.fleetCheckLog(), "a");
    try {
        writeSync(log, `${at.toISOString()} fleet check started by the tick\n`);
        const child = spawnChild(process.execPath, [TOLI_SCRIPT, "fleet", "check", "--wake"], {
            cwd: paths.root(),
            detached: true,
            stdio: ["ignore", log, log],
            env: process.env,
        });
        child.unref();
        return `fleet check: started in the background (pid ${child.pid ?? "unknown"}, log ${paths.fleetCheckLog()})`;
    } finally {
        closeSync(log);
    }
}

export async function checkCommand(argv: string[]): Promise<void> {
    const args = new Args(argv, { booleans: ["json", "wake", "local"] });
    args.maxPositional(0);
    if (args.bool("local")) {
        if (args.bool("wake")) throw new ToliError("--local reports this machine's backlog only; it never posts");
        const report = localOversight(loadBacklog().tasks);
        if (args.bool("json")) printJson(report);
        else out([...report.stale.map((entry) => entry.line), `${report.waiting.length} waiting`].join("\n"));
        return;
    }
    const check = await runFleetCheck();
    const posted = args.bool("wake") ? postFleetCheck(check) : null;
    if (args.bool("json")) printJson({ ...check, posted });
    else {
        out(fleetCheckText(check));
        if (posted !== null) out(`wake posted: ${relative(paths.root(), posted)}`);
    }
}
