import { Args } from "../core/args.ts";
import { loadFleet, remoteToliCommand, sshArgs } from "../core/config.ts";
import { out, printJson, runAsync } from "../core/util.ts";
import { loadProjects } from "../projects/projects.ts";
import { type Queue, queueText } from "./queue.ts";
import { type FleetEntry, localResources, type Resources } from "./resources.ts";

/** Line shown by `resources`, `fleet status`, `digest --fleet` and doctor. */
export function availabilityLine(entry: FleetEntry): string {
    const name = `${entry.machine}${entry.local ? " (this machine)" : ""}`;
    const state = entry.available ? "available" : `unavailable: ${entry.reasons.join("; ")}`;
    const r = entry.resources;
    if (!r) return `${name}: ${state}`;
    const detail = [
        queueText(r.queue),
        `load ${r.load1}/${r.cpus} cpus`,
        `mem ${r.memAvailableMB}/${r.memTotalMB} MB free`,
        `disk ${r.diskFreeGB} GB free`,
        `runs ${r.activeRuns}/${r.maxRuns}`,
        ...(r.buildSlots === undefined ? [] : [`builds ${r.buildSlotsBusy ?? 0}/${r.buildSlots}`]),
        `projects ${r.projects.length === 0 ? "none" : r.projects.join(",")}`,
    ].join(", ");
    return `${name}: ${state} (${detail})`;
}

/** A machine that may take the work; `depth` is its queue depth, null when its toli is too old to report one. */
export type Candidate = { machine: string; local: boolean; hasClone: boolean; depth: number | null };

export type Rejection = { machine: string; reasons: string[] };

export type PickResult = {
    machine: string | null;
    local: boolean;
    depth: number | null;
    candidates: Candidate[];
    rejected: Rejection[];
};

const PROBE_CONNECT_SECONDS = 10;
const PROBE_CAP_MS = 20_000;

function firstLine(text: string): string {
    return (
        text
            .split("\n")
            .find((line) => line.trim() !== "")
            ?.trim() ?? "no output"
    );
}

/** Parse another machine's `resources --json`, rejecting anything not shaped like a snapshot. */
export function parseResources(text: string): Resources {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not a JSON object");
    const fields = new Map(Object.entries(value));
    const num = (key: string): number => {
        const field = fields.get(key);
        if (typeof field !== "number" || !Number.isFinite(field)) throw new Error(`field ${key} is not a number`);
        return field;
    };
    const str = (key: string): string => {
        const field = fields.get(key);
        if (typeof field !== "string") throw new Error(`field ${key} is not a string`);
        return field;
    };
    const strings = (key: string): string[] => {
        const field: unknown = fields.get(key);
        if (!Array.isArray(field)) throw new Error(`field ${key} is not a string list`);
        return field.map((item: unknown) => {
            if (typeof item !== "string") throw new Error(`field ${key} is not a string list`);
            return item;
        });
    };
    const available = fields.get("available");
    if (typeof available !== "boolean") throw new Error("field available is not a boolean");
    const rawQueue: unknown = fields.get("queue");
    let queue: Queue | null = null;
    if (rawQueue !== undefined) {
        if (typeof rawQueue !== "object" || rawQueue === null || Array.isArray(rawQueue))
            throw new Error("field queue is not an object");
        const parts = new Map(Object.entries(rawQueue));
        const count = (key: keyof Queue): number => {
            const part = parts.get(key);
            if (typeof part !== "number" || !Number.isInteger(part) || part < 0)
                throw new Error(`field queue.${key} is not a count`);
            return part;
        };
        queue = {
            queued: count("queued"),
            active: count("active"),
            held: count("held"),
            jawansRunning: count("jawansRunning"),
            jawansQueued: count("jawansQueued"),
            depth: count("depth"),
        };
    }
    return {
        machine: str("machine"),
        platform: str("platform"),
        cpus: num("cpus"),
        load1: num("load1"),
        load5: num("load5"),
        memTotalMB: num("memTotalMB"),
        memAvailableMB: num("memAvailableMB"),
        diskFreeGB: num("diskFreeGB"),
        activeRuns: num("activeRuns"),
        maxRuns: num("maxRuns"),
        maxLoadPerCpu: num("maxLoadPerCpu"),
        projects: strings("projects"),
        available,
        reasons: strings("reasons"),
        at: str("at"),
        queue,
    };
}

async function probe(machine: { name: string; ssh: string; root: string }): Promise<FleetEntry> {
    const unreachable = (detail: string): FleetEntry => ({
        machine: machine.name,
        local: false,
        reachable: false,
        available: false,
        reasons: [`unreachable: ${detail}`],
        resources: null,
    });
    const result = await runAsync(
        [...sshArgs(machine.ssh, PROBE_CONNECT_SECONDS), remoteToliCommand(machine.root, "resources --json")],
        {
            timeoutMs: PROBE_CAP_MS,
        },
    );
    if (result.timedOut) return unreachable(`no answer from ${machine.ssh} within ${PROBE_CAP_MS / 1000}s`);
    if (result.code !== 0)
        return unreachable(`ssh ${machine.ssh} exited ${result.code}: ${firstLine(result.stderr || result.stdout)}`);
    try {
        const resources = parseResources(result.stdout);
        return {
            machine: machine.name,
            local: false,
            reachable: true,
            available: resources.available,
            reasons: resources.reasons,
            resources,
        };
    } catch (error) {
        return unreachable(
            `bad resources output from ${machine.ssh}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/** This machine plus every other `config/fleet.json` machine, probed in parallel. Never throws for a bad machine. */
export async function fleetStatus(): Promise<FleetEntry[]> {
    const local = localResources();
    const others = loadFleet().machines.filter((machine) => machine.name !== local.machine);
    const remote = await Promise.all(others.map(probe));
    return [
        {
            machine: local.machine,
            local: true,
            reachable: true,
            available: local.available,
            reasons: local.reasons,
            resources: local,
        },
        ...remote,
    ];
}

/**
 * Rank machines for one unit of work by queue depth, shortest first; on equal depth a machine with the project's
 * clone wins, then this machine, then name order. A machine whose toli reports no queue ranks after every known
 * queue. Load, memory, disk and `available` never pass a machine over: a machine busy with builds but with an empty
 * queue gets work first. Only an unreachable machine, or (with a project) one without the clone when the project's
 * URL is not known here, is rejected.
 */
export function rankMachines(entries: FleetEntry[], project?: { name: string; urlKnown: boolean }): PickResult {
    const candidates: Candidate[] = [];
    const rejected: Rejection[] = [];
    for (const entry of entries) {
        if (!entry.resources) {
            rejected.push({
                machine: entry.machine,
                reasons: entry.reasons.length > 0 ? entry.reasons : ["unreachable"],
            });
            continue;
        }
        const hasClone = project !== undefined && entry.resources.projects.includes(project.name);
        if (project && !hasClone && !project.urlKnown) {
            rejected.push({
                machine: entry.machine,
                reasons: [`no clone of ${project.name}, and its git URL is not registered here`],
            });
            continue;
        }
        candidates.push({
            machine: entry.machine,
            local: entry.local,
            hasClone,
            depth: entry.resources.queue?.depth ?? null,
        });
    }
    candidates.sort((a, b) => {
        if (a.depth !== b.depth) {
            if (a.depth === null) return 1;
            if (b.depth === null) return -1;
            return a.depth - b.depth;
        }
        if (a.hasClone !== b.hasClone) return a.hasClone ? -1 : 1;
        if (a.local !== b.local) return a.local ? -1 : 1;
        return a.machine < b.machine ? -1 : a.machine > b.machine ? 1 : 0;
    });
    const winner = candidates[0];
    return {
        machine: winner?.machine ?? null,
        local: winner?.local ?? false,
        depth: winner?.depth ?? null,
        candidates,
        rejected,
    };
}

/** Pick across the live fleet; `project` is checked against this machine's registry for a clonable URL. */
export async function pickMachine(projectName: string | undefined): Promise<PickResult> {
    const entries = await fleetStatus();
    if (projectName === undefined) return rankMachines(entries);
    const known = loadProjects().find((entry) => entry.name === projectName);
    return rankMachines(entries, { name: projectName, urlKnown: Boolean(known?.url) });
}

function noCandidateText(pick: PickResult): string {
    return [
        "no machine qualifies:",
        ...pick.rejected.map((entry) => `  ${entry.machine}: ${entry.reasons.join("; ")}`),
    ].join("\n");
}

/** Prints the chosen machine; exit 2 with each machine's reasons when none qualifies. */
export async function pickCommand(argv: string[]): Promise<number> {
    const args = new Args(argv, { booleans: ["json"], values: ["project"] });
    args.maxPositional(0);
    const project = args.str("project");
    const pick = await pickMachine(project);
    if (args.bool("json")) printJson(pick);
    else out(pick.machine ?? noCandidateText(pick));
    return pick.machine === null ? 2 : 0;
}
