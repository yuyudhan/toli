import { existsSync } from "node:fs";
import { paths } from "./paths.ts";
import { MateError, readJson } from "./util.ts";

export type Role = "coordinator" | "worker";

/** Optional per-machine thresholds for `bin/mate resources`; any field left out uses its default. */
export type CapacityConfig = {
    maxRuns?: number;
    maxLoadPerCpu?: number;
    minMemAvailableMB?: number;
    minDiskFreeGB?: number;
};

export type Machine = {
    name: string;
    role: Role;
    coordinator?: { ssh: string; root: string };
    capacity?: CapacityConfig;
};

export type FleetMachine = { name: string; ssh: string; root: string };

export type Fleet = { machines: FleetMachine[] };

export function hasMachine(): boolean {
    return existsSync(paths.machine());
}

export function loadMachine(): Machine {
    if (!hasMachine())
        throw new MateError(
            "config/machine.json missing: run `bin/mate init --name <machine> --role coordinator|worker`",
        );
    const machine = readJson<Machine>(paths.machine(), { name: "", role: "coordinator" });
    if (!machine.name) throw new MateError("config/machine.json has no name");
    return machine;
}

export function loadFleet(): Fleet {
    const fleet = readJson<Fleet>(paths.fleet(), { machines: [] });
    return { machines: Array.isArray(fleet.machines) ? fleet.machines : [] };
}

export function fleetMachine(name: string): FleetMachine {
    const machine = loadFleet().machines.find((entry) => entry.name === name);
    if (!machine) throw new MateError(`machine "${name}" is not in config/fleet.json`);
    return machine;
}

/** Fleet machines other than this one. */
export function otherFleetMachines(): FleetMachine[] {
    const self = hasMachine() ? loadMachine().name : "";
    return loadFleet().machines.filter((entry) => entry.name !== self);
}

/** ssh argv prefix: batch mode (never prompts) with a bounded connect timeout. */
export function sshArgs(host: string, connectTimeoutSeconds = 15): string[] {
    return ["ssh", "-o", "BatchMode=yes", "-o", `ConnectTimeout=${connectTimeoutSeconds}`, host];
}
