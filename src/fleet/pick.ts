import { Args } from "../core/args.ts";
import { loadFleet, remoteToliCommand, sshArgs } from "../core/config.ts";
import { out, printJson, runAsync, ToliError } from "../core/util.ts";
import { loadProjects } from "../projects/projects.ts";
import { availabilityLine, type FleetEntry, localResources, type Resources } from "./resources.ts";

export type Candidate = { machine: string; local: boolean; hasClone: boolean; score: number };

export type Rejection = { machine: string; reasons: string[] };

export type PickResult = {
    machine: string | null;
    local: boolean;
    score: number | null;
    candidates: Candidate[];
    rejected: Rejection[];
};

/** Candidates whose score is within this of the best are ranked by preference (local, clone, name) instead. */
const TIE_BAND = 0.1;
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

/** min(cpu headroom, memory headroom) − activeRuns / maxRuns. */
export function score(r: Resources): number {
    const cpuBudget = r.cpus * r.maxLoadPerCpu;
    const cpuHeadroom = cpuBudget > 0 ? 1 - r.load1 / cpuBudget : 0;
    const memHeadroom = r.memTotalMB > 0 ? r.memAvailableMB / r.memTotalMB : 0;
    return Math.min(cpuHeadroom, memHeadroom) - r.activeRuns / Math.max(1, r.maxRuns);
}

/**
 * Rank machines for one unit of work. With a project, a machine qualifies when it holds the clone, or when the
 * project's URL is known here (it can be cloned there).
 */
export function rankMachines(entries: FleetEntry[], project?: { name: string; urlKnown: boolean }): PickResult {
    const candidates: Candidate[] = [];
    const rejected: Rejection[] = [];
    for (const entry of entries) {
        if (!entry.available || !entry.resources) {
            rejected.push({
                machine: entry.machine,
                reasons: entry.reasons.length > 0 ? entry.reasons : ["not available"],
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
        candidates.push({ machine: entry.machine, local: entry.local, hasClone, score: score(entry.resources) });
    }
    const best = Math.max(...candidates.map((candidate) => candidate.score));
    const inBand = (candidate: Candidate): boolean => candidate.score >= best - TIE_BAND;
    candidates.sort((a, b) => {
        const bandA = inBand(a);
        const bandB = inBand(b);
        if (bandA !== bandB) return bandA ? -1 : 1;
        if (bandA) {
            if (a.local !== b.local) return a.local ? -1 : 1;
            if (a.hasClone !== b.hasClone) return a.hasClone ? -1 : 1;
        } else if (a.score !== b.score) {
            return b.score - a.score;
        }
        return a.machine < b.machine ? -1 : a.machine > b.machine ? 1 : 0;
    });
    const rounded = candidates.map((candidate) => ({ ...candidate, score: Math.round(candidate.score * 1000) / 1000 }));
    const winner = rounded[0];
    return {
        machine: winner?.machine ?? null,
        local: winner?.local ?? false,
        score: winner?.score ?? null,
        candidates: rounded,
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

export function noCandidateText(pick: PickResult): string {
    return [
        "no machine available:",
        ...pick.rejected.map((entry) => `  ${entry.machine}: ${entry.reasons.join("; ")}`),
    ].join("\n");
}

export async function fleetCommand(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;
    if (sub !== "status") throw new ToliError("usage: toli fleet status [--json]");
    const args = new Args(rest, { booleans: ["json"] });
    args.maxPositional(0);
    const entries = await fleetStatus();
    if (args.bool("json")) printJson(entries);
    else for (const entry of entries) out(availabilityLine(entry));
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
