import { existsSync } from "node:fs";
import type { HarnessConfig } from "./harness.ts";
import { paths } from "./paths.ts";
import { readJson, shellQuote, ToliError } from "./util.ts";

export type Role = "coordinator" | "worker";

/** Optional per-machine thresholds for `bin/toli resources`; any field left out uses its default. */
export type CapacityConfig = {
    maxRuns?: number;
    maxLoadPerCpu?: number;
    minMemAvailableMB?: number;
    minDiskFreeGB?: number;
};

/** Retention for `bin/toli prune`, in days unless named otherwise; any field left out uses its default. */
export type RetentionConfig = {
    jobResultsDays?: number;
    jobResultsKeep?: number;
    tasksDays?: number;
    logsDays?: number;
    inboxDays?: number;
};

export type Machine = {
    name: string;
    role: Role;
    coordinator?: { ssh: string; root: string };
    capacity?: CapacityConfig;
    /** Token budget for the always-loaded memory files (data/preferences.md + data/learnings.md). */
    memoryBudgetTokens?: number;
    retention?: RetentionConfig;
    /** Which harness runs jawans (`bin/toli spawn`): default, per-work-type overrides, models. See docs/harnesses.md. */
    harness?: HarnessConfig;
    /** Defaults for new projects; `workspace` is the branching/worktree strategy, validated in src/project-strategy.ts. */
    defaults?: { workspace?: string };
    /** The Needs-you queue (`bin/toli needs`): a hold unanswered for `staleDays` (default 7) is re-surfaced once. */
    needs?: { staleDays?: number };
};

/** Optional settings from config/machine.json, readable before `init` (every field may be absent). */
export function machineSettings(): Partial<Machine> {
    return readJson<Partial<Machine>>(paths.machine(), {});
}

export type FleetMachine = { name: string; ssh: string; root: string };

export type Fleet = { machines: FleetMachine[] };

export function hasMachine(): boolean {
    return existsSync(paths.machine());
}

export function loadMachine(): Machine {
    if (!hasMachine())
        throw new ToliError(
            "config/machine.json missing: run `bin/toli init --name <machine> --role coordinator|worker`",
        );
    const machine = readJson<Machine>(paths.machine(), { name: "", role: "coordinator" });
    if (!machine.name) throw new ToliError("config/machine.json has no name");
    return machine;
}

export function loadFleet(): Fleet {
    const fleet = readJson<Fleet>(paths.fleet(), { machines: [] });
    return { machines: Array.isArray(fleet.machines) ? fleet.machines : [] };
}

export function fleetMachine(name: string): FleetMachine {
    const machine = loadFleet().machines.find((entry) => entry.name === name);
    if (!machine) throw new ToliError(`machine "${name}" is not in config/fleet.json`);
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

// ssh runs the remote command in a non-interactive shell that skips the login profile, so Homebrew and Bun's
// install directories are often missing from PATH there and `bin/toli` (a `#!/usr/bin/env bun` script) fails.
const REMOTE_PATH = 'PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"';

/** Remote shell command that runs `bin/toli <command>` from `root`; `command` must already be shell-quoted. */
export function remoteToliCommand(root: string, command: string): string {
    return `export ${REMOTE_PATH} && cd ${shellQuote(root)} && bin/toli ${command}`;
}
