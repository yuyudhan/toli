// `bin/toli fleet status|queues|check` (queues: src/fleet/queues.ts). The check is oversight that never pauses, away
// mode included: every reachable machine with no active run while queued work (or an active task no live run works
// on) exists for a project cloned there is an idle machine, every active task with no live run on this machine or
// any reachable one is named, and so is every machine whose configured peer listener is down. `--wake` posts the
// findings as one inbox item (a `[toli wake]` for the lead); the coordinator's tick starts `fleet check --wake` every
// `oversight.fleetCheckMinutes` (default 60), so no job prompt can skip it.
import { spawn as spawnChild } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Args } from "../core/args.ts";
import {
    hasMachine,
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
import { waitingLines } from "../jobs/outbox-admin.ts";
import { listenerProblem } from "../peer/supervise.ts";
import { loadBacklog, type Task } from "../records/backlog.ts";
import { addInboxItem } from "../records/inbox.ts";
import { findStaleTasks, redispatchCommand, staleLine } from "../records/stale.ts";
import { fleetListCommand } from "./fleet-sync.ts";
import { availabilityLine, fleetStatus } from "./pick.ts";
import { queuesCommand } from "./queues.ts";
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
    /** Stale active tasks per machine whose backlog holds them. */
    stale: { machine: string; line: string; command: string }[];
    idle: IdleMachine[];
    /** Machines whose configured peer listener is down or stuck on a replaced runtime. */
    listeners: { machine: string; problem: string }[];
    unreachable: { machine: string; reason: string }[];
    /** Reachable machines whose own backlog could not be read (an older toli there). */
    unchecked: { machine: string; reason: string }[];
};

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
 * The findings: idle machines (reachable, no active run) with waiting work for a project cloned there, from this
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
        stale: [],
        idle: [],
        listeners: [],
        unreachable: [],
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
        if (entry.resources.activeRuns > 0) continue;
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
    return check;
}

/** Whether the check found anything the lead must act on. */
export function needsAction(check: FleetCheck): boolean {
    return check.stale.length > 0 || check.idle.length > 0 || check.listeners.length > 0;
}

function listenersDown(check: FleetCheck): string {
    const count = check.listeners.length;
    return count === 0 ? "" : `, ${count} peer listener${count === 1 ? "" : "s"} down`;
}

/** The one batched message: stale tasks first, then idle machines, then down listeners, then what was not checked. */
export function fleetCheckText(check: FleetCheck): string {
    if (!needsAction(check)) {
        const notes = [...check.unreachable, ...check.unchecked].map((entry) => `${entry.machine} (${entry.reason})`);
        return `fleet check at ${check.at}: all clear, no idle machine has waiting work and no active task lacks a live run${notes.length === 0 ? "" : `; not checked: ${notes.join(", ")}`}`;
    }
    const lines = [
        `fleet check at ${check.at}: ${check.stale.length} active task${check.stale.length === 1 ? "" : "s"} with no live run, ${check.idle.length} idle machine${check.idle.length === 1 ? "" : "s"} with waiting work${listenersDown(check)}`,
        "Lead: dispatch now (toli-dispatch skill), spreading the waiting work over the idle machines; away mode changes nothing here.",
    ];
    if (check.stale.length > 0) {
        lines.push("", "Active tasks with no live run:");
        for (const entry of check.stale) lines.push(`- [${entry.machine}] ${entry.line}`, `  ${entry.command}`);
    }
    if (check.idle.length > 0) {
        lines.push("", "Idle machines (no active run) with waiting work for their clones:");
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
    if (check.unreachable.length > 0 || check.unchecked.length > 0) {
        lines.push("", "Not checked:");
        for (const entry of check.unreachable) lines.push(`- ${entry.machine}: ${entry.reason}`);
        for (const entry of check.unchecked) lines.push(`- ${entry.machine}: its own backlog (${entry.reason})`);
    }
    return lines.join("\n");
}

async function remoteReport(machine: { name: string; ssh: string; root: string }): Promise<LocalOversight | string> {
    const result = await runAsync(
        [
            ...sshArgs(machine.ssh, REMOTE_CONNECT_SECONDS),
            remoteToliCommand(machine.root, "fleet check --local --json"),
        ],
        { timeoutMs: REMOTE_CAP_MS },
    );
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
    return addInboxItem(
        hasMachine() ? loadMachine().name : "toli",
        `fleet check: ${check.stale.length} stale task${check.stale.length === 1 ? "" : "s"}, ${check.idle.length} idle machine${check.idle.length === 1 ? "" : "s"} with waiting work${listenersDown(check)}`,
        fleetCheckText(check),
    );
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
        });
        child.unref();
        return `fleet check: started in the background (pid ${child.pid ?? "unknown"}, log ${paths.fleetCheckLog()})`;
    } finally {
        closeSync(log);
    }
}

async function checkCommand(argv: string[]): Promise<void> {
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

/**
 * `toli fleet status [--json]` | `queues [--json]` | `check [--json] [--wake] [--local]` | `export` | `sync`.
 */
export async function fleetCommand(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;
    if (sub === "check") return await checkCommand(rest);
    if (sub === "queues") return await queuesCommand(rest);
    if (sub === "export" || sub === "sync") return fleetListCommand(sub, rest);
    if (sub !== "status")
        throw new ToliError(
            "usage: toli fleet status [--json] | queues [--json] | check [--json] [--wake] [--local] | export | sync",
        );
    const args = new Args(rest, { booleans: ["json"] });
    args.maxPositional(0);
    const entries = await fleetStatus();
    if (args.bool("json")) printJson(entries);
    else {
        for (const entry of entries) out(availabilityLine(entry));
        for (const line of waitingLines()) out(`waiting to send: ${line}`);
    }
}
