// config/fleet.json comes from the coordinator (docs/fleet.md "The fleet list"): the coordinator's list is the one
// kept, and every worker's `bin/toli self sync` (or `bin/toli fleet sync`) replaces its own with it. ssh names are the
// one part that differs per machine (an ssh alias only exists where it is configured), so the coordinator exports
// each machine as `user@host` resolved through its own ssh config, a worker reaches the coordinator by its
// `coordinator.ssh`, and a machine this worker already lists keeps the ssh name it has (the one known to work here).
import { Args } from "../core/args.ts";
import {
    type Fleet,
    type FleetMachine,
    hasMachine,
    loadFleet,
    loadMachine,
    type Machine,
    remoteToliCommand,
    sshArgs,
} from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { out, printJson, run, ToliError, writeJsonAtomic } from "../core/util.ts";

/** What `fleet export` prints: the coordinator's name and its list with portable ssh targets. */
export type FleetExport = { coordinator: string; machines: FleetMachine[] };

/** `user@host` (with `ssh://...:port` when not 22) for an ssh name, from `ssh -G`; the name itself when that fails. */
function portableSsh(name: string): string {
    const result = run(["ssh", "-G", name]);
    if (result.code !== 0) return name;
    const options = new Map(
        result.stdout
            .split("\n")
            .map((line) => line.trim().split(/\s+/, 2))
            .filter((parts): parts is [string, string] => parts.length === 2)
            .map(([key, value]) => [key.toLowerCase(), value] as const),
    );
    const user = options.get("user");
    const host = options.get("hostname");
    const port = options.get("port") ?? "22";
    if (user === undefined || host === undefined) return name;
    return port === "22" ? `${user}@${host}` : `ssh://${user}@${host}:${port}`;
}

/** This machine's fleet list as the workers take it. */
export function fleetExport(): FleetExport {
    const self = loadMachine().name;
    return {
        coordinator: self,
        machines: loadFleet().machines.map((entry) => ({
            name: entry.name,
            root: entry.root,
            ssh: entry.name === self ? entry.ssh : portableSsh(entry.ssh),
        })),
    };
}

function parseExport(text: string): FleetExport {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new ToliError(`the coordinator's fleet export is not JSON: ${text.trim().slice(0, 200)}`);
    }
    if (typeof value !== "object" || value === null || !("machines" in value) || !("coordinator" in value))
        throw new ToliError("the coordinator's fleet export has no machines");
    const { coordinator, machines } = value;
    if (typeof coordinator !== "string" || !Array.isArray(machines))
        throw new ToliError("the coordinator's fleet export has no machines");
    const valid = machines.filter(
        (entry): entry is FleetMachine =>
            typeof entry === "object" &&
            entry !== null &&
            typeof entry.name === "string" &&
            typeof entry.ssh === "string" &&
            typeof entry.root === "string",
    );
    if (valid.length !== machines.length) throw new ToliError("the coordinator's fleet export has a malformed machine");
    return { coordinator, machines: valid };
}

/**
 * The worker's new list: every machine the coordinator lists, in its order. The coordinator is reached by this
 * worker's `coordinator.ssh`/`root`, this machine keeps its own entry, and a machine already listed here keeps its ssh
 * name; any other takes the coordinator's portable `user@host`. Machines the coordinator no longer lists are dropped.
 */
export function mergeFleet(exported: FleetExport, local: Fleet, machine: Machine): Fleet {
    const known = new Map(local.machines.map((entry) => [entry.name, entry]));
    return {
        machines: exported.machines.map((entry) => {
            if (entry.name === machine.name)
                return { name: entry.name, ssh: known.get(entry.name)?.ssh ?? entry.name, root: paths.root() };
            if (entry.name === exported.coordinator && machine.coordinator !== undefined)
                return { name: entry.name, ssh: machine.coordinator.ssh, root: machine.coordinator.root };
            return { name: entry.name, ssh: known.get(entry.name)?.ssh ?? entry.ssh, root: entry.root };
        }),
    };
}

export type FleetSyncResult = { changed: boolean; added: string[]; removed: string[]; machines: number };

/** On a worker: fetch the coordinator's list and write config/fleet.json from it. Null on the coordinator. */
export function syncFleetFromCoordinator(): FleetSyncResult | null {
    const machine = loadMachine();
    if (machine.role !== "worker" || machine.coordinator === undefined) return null;
    const { ssh, root } = machine.coordinator;
    const result = run([...sshArgs(ssh), remoteToliCommand(root, "fleet export")], { timeoutMs: 60_000 });
    if (result.code !== 0)
        throw new ToliError(
            `could not read the coordinator's fleet list (ssh ${ssh} exited ${result.code}): ${(result.stderr || result.stdout).trim()}`,
        );
    const local = loadFleet();
    const next = mergeFleet(parseExport(result.stdout), local, machine);
    const before = new Set(local.machines.map((entry) => entry.name));
    const after = new Set(next.machines.map((entry) => entry.name));
    const changed = JSON.stringify(local) !== JSON.stringify(next);
    if (changed) writeJsonAtomic(paths.fleet(), next);
    return {
        changed,
        added: [...after].filter((name) => !before.has(name)),
        removed: [...before].filter((name) => !after.has(name)),
        machines: next.machines.length,
    };
}

export function fleetSyncText(result: FleetSyncResult): string {
    if (!result.changed)
        return `fleet: config/fleet.json already matches the coordinator (${result.machines} machines)`;
    const parts = [
        ...(result.added.length > 0 ? [`added ${result.added.join(", ")}`] : []),
        ...(result.removed.length > 0 ? [`removed ${result.removed.join(", ")}`] : []),
    ];
    return `fleet: config/fleet.json updated from the coordinator (${result.machines} machines${parts.length > 0 ? `; ${parts.join("; ")}` : ""})`;
}

/** `fleet export [--json]` (the coordinator's list for workers) | `fleet sync` (a worker takes it). */
export function fleetListCommand(sub: "export" | "sync", argv: string[]): void {
    new Args(argv, { booleans: ["json"] }).maxPositional(0);
    if (sub === "export") {
        printJson(fleetExport());
        return;
    }
    const result = syncFleetFromCoordinator();
    out(
        result === null
            ? "fleet: this machine is the coordinator; its config/fleet.json is the list"
            : fleetSyncText(result),
    );
}

/**
 * `self sync`'s fleet step: the result on a worker, null on the coordinator (or before `init`), or the error text
 * when the coordinator could not be read (the runtime sync already happened; the old list stays).
 */
export function syncWorkerFleet(): FleetSyncResult | string | null {
    if (!hasMachine()) return null;
    try {
        return syncFleetFromCoordinator();
    } catch (error) {
        return `config/fleet.json kept: ${error instanceof Error ? error.message : String(error)}`;
    }
}
