import { existsSync } from "node:fs";
import type { HarnessConfig } from "../harness/harness.ts";
import { paths } from "./paths.ts";
import { sshSharingArgs, sshSharingArgsAsync } from "./ssh.ts";
import { readJson, shellQuote, ToliError } from "./util.ts";

export type Role = "coordinator" | "worker";

/** Optional per-machine thresholds for `bin/toli resources`; any field left out uses its default. */
export type CapacityConfig = {
    maxRuns?: number;
    maxLoadPerCpu?: number;
    minMemAvailableMB?: number;
    /**
     * Free disk (GB) the disk keeper holds: below it, rebuildable build output goes (src/fleet/disk.ts; default 60).
     * Capped at 15% of the volume's size.
     */
    diskKeepGB?: number;
    /**
     * Whether toli frees disk on its own (src/fleet/disk.ts; default true): before every jawan start, in the minute
     * tick and in its fallback sweep. false: toli deletes nothing by itself and only alerts the inbox when free disk
     * runs low (src/fleet/disk-alert.ts); `bin/toli disk keep` by hand still deletes.
     */
    diskKeep?: boolean;
    /**
     * Minutes without use after which the disk keeper sweeps an artifact out of a cargo target a build holds
     * (src/fleet/stale-sweep.ts; default 180).
     */
    diskSweepStaleMinutes?: number;
    /**
     * Extra build tools (beside cargo, rustc, just, ...) whose process keeps a target in use for the disk keeper,
     * e.g. a project's build queue: each entry is a program name (`my-queue`, also matching `my-queue.ts`) or words
     * the command line holds in a row (`my-tool queue`) (src/fleet/disk-scan.ts; default none).
     */
    diskBuildTools?: string[];
    /**
     * Parallel compile jobs per cargo run (`CARGO_BUILD_JOBS` inside a build slot and for jawans, mirrored in
     * ~/.cargo/config.toml; default the cores split evenly over the build slots).
     */
    cargoJobs?: number;
    /** Heavy cargo builds that may run at once; the rest wait for a slot (src/fleet/build-slots.ts; default cpus / 6). */
    buildSlots?: number;
    /**
     * Memory cap, in MB, of each heavy build's own systemd user scope on Linux (`MemoryMax`, src/fleet/build-slots.ts;
     * default three quarters of the RAM split evenly over the build slots; 0: no cap, still its own scope).
     */
    buildMemoryMax?: number;
    /**
     * Resumes of the same session per run chain when a jawan run stalls or hits an explicit `--max-time` without a
     * report (default 3; 0 turns resuming off).
     */
    autoResume?: number;
    /**
     * Minutes a jawan run may show no progress (no output, session activity, file change or CPU use) before toli
     * stops and resumes it; runs have no wall-clock limit unless given `--max-time` (src/jawans/progress.ts; default 30).
     */
    stallMinutes?: number;
    /**
     * Minutes a gate (`bin/toli gate run`) may go without progress (new log output, a checkout change or CPU use in
     * its process tree) before it is stopped as stalled; a gate that keeps working has no time limit
     * (src/forge/gate.ts; default 30).
     */
    gateStallMinutes?: number;
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
    /** Defaults for new projects; `workspace` is the branching/worktree strategy, validated in src/projects/strategy.ts. */
    defaults?: { workspace?: string };
    /** The Needs-you queue (`bin/toli needs`): a hold unanswered for `staleDays` (default 7) is re-surfaced once. */
    needs?: { staleDays?: number };
    /**
     * Oversight of work nobody is doing (src/records/stale.ts): an active task whose recorded run ended
     * `staleTaskMinutes` ago (default 15) is raised to the lead; the coordinator's tick runs `bin/toli fleet check
     * --wake` every `fleetCheckMinutes` (default 60) to name idle machines and such tasks, away mode included.
     */
    oversight?: { staleTaskMinutes?: number; fleetCheckMinutes?: number };
    /**
     * This machine's lead service (src/fleet/lead.ts, docs/sardars.md): every `balanceMinutes` (default 30) it compares
     * queue depths across the fleet and offers or asks for work when the gap is at least `balanceGap` (default 3).
     */
    lead?: { balanceMinutes?: number; balanceGap?: number };
};

/** Optional settings from config/machine.json, readable before `init` (every field may be absent). */
export function machineSettings(): Partial<Machine> {
    return readJson<Partial<Machine>>(paths.machine(), {});
}

export type FleetMachine = {
    name: string;
    ssh: string;
    root: string;
    /**
     * false: no other machine ever ssh-es into this one (docs/fleet.md "Machines that take no inbound ssh"). What the
     * others would send it waits in their outbox, and its minute tick pulls it from them (src/jobs/pull.ts). Set on the
     * coordinator's list; workers get it with the list.
     */
    inbound?: boolean;
};

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

/** Whether a fleet machine takes no inbound ssh (`inbound: false`): nothing ssh-es into it, it pulls instead. */
export function inboundOff(machine: FleetMachine): boolean {
    return machine.inbound === false;
}

/** Why a call does not ssh into `machine`: the line callers show in place of an ssh error. */
export function inboundOffText(machine: FleetMachine): string {
    return `${machine.name} takes no inbound ssh (inbound: false in config/fleet.json); it pulls what is queued for it`;
}

/** The fleet machine reached by ssh name `host` that takes no inbound ssh, if any (a worker's coordinator included). */
export function inboundOffHost(host: string): FleetMachine | undefined {
    return loadFleet().machines.find((entry) => inboundOff(entry) && entry.ssh === host);
}

/**
 * ssh argv prefix: batch mode (never prompts) with a bounded connect timeout, sharing one connection per host
 * across calls (src/core/ssh.ts). Refuses a host that takes no inbound ssh: callers check `inboundOff` first, so this
 * only stops a call that forgot to.
 */
export function sshArgs(host: string, connectTimeoutSeconds = 15): string[] {
    refuseInboundOff(host);
    return sshArgv(host, connectTimeoutSeconds, sshSharingArgs(host));
}

/** sshArgs without blocking, so the connection checks for several hosts run at once (src/jobs/pull.ts). */
export async function sshArgsAsync(host: string, connectTimeoutSeconds = 15): Promise<string[]> {
    refuseInboundOff(host);
    return sshArgv(host, connectTimeoutSeconds, await sshSharingArgsAsync(host));
}

function refuseInboundOff(host: string): void {
    const blocked = inboundOffHost(host);
    if (blocked !== undefined) throw new ToliError(inboundOffText(blocked));
}

function sshArgv(host: string, connectTimeoutSeconds: number, sharing: string[]): string[] {
    return ["ssh", ...sharing, "-o", "BatchMode=yes", "-o", `ConnectTimeout=${connectTimeoutSeconds}`, host];
}

// ssh runs the remote command in a non-interactive shell that skips the login profile, so Homebrew and Bun's
// install directories are often missing from PATH there. bin/toli finds bun at those paths itself; the commands it
// runs (git, gh, omp) need them on PATH too.
const REMOTE_PATH = 'PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"';

/**
 * Remote shell command that runs `bin/toli <command>` from `root`, with `env` set for it; `command` must already be
 * shell-quoted.
 */
export function remoteToliCommand(root: string, command: string, env: Record<string, string> = {}): string {
    const assignments = Object.entries(env).map(([name, value]) => `${name}=${shellQuote(value)} `);
    return `export ${REMOTE_PATH} && cd ${shellQuote(root)} && ${assignments.join("")}bin/toli ${command}`;
}
