import { Args } from "../core/args.ts";
import { out, printJson } from "../core/util.ts";
import { loadProjects } from "../projects/projects.ts";
import type { Shape } from "../records/backlog.ts";
import { parseShape } from "../records/task-shape.ts";
import { fleetStatus } from "./fleet-probe.ts";
import { fullText } from "./full.ts";
import { outsideBuildText } from "./outside-builds.ts";
import { perSlot, queueText, slotText } from "./queue.ts";
import type { FleetEntry, Resources } from "./resources.ts";

/** One snapshot's figures, as `availabilityLine` lists them. */
function resourcesText(r: Resources): string {
    return [
        queueText(r.queue),
        ...(r.queue === null ? [] : [slotText(r.queue, r.maxRuns)]),
        `load ${r.load1}/${r.cpus} cpus`,
        `mem ${r.memAvailableMB}/${r.memTotalMB} MB free`,
        `disk ${r.diskFreeGB} GB free`,
        `runs ${r.activeRuns}/${r.maxRuns}`,
        ...(r.buildSlots === undefined ? [] : [`builds ${r.buildSlotsBusy ?? 0}/${r.buildSlots}`]),
        ...(r.buildsOutsideSlots ?? []).map((build) => `build outside the slots: ${outsideBuildText(build)}`),
        `projects ${r.projects.length === 0 ? "none" : r.projects.join(",")}`,
        ...(r.verifyOnly === undefined || r.verifyOnly.length === 0 ? [] : [`verify-only ${r.verifyOnly.join(",")}`]),
    ].join(", ");
}

/** Line shown by `resources`, `fleet status`, `digest --fleet` and doctor; an unreachable machine's last snapshot is stale. */
export function availabilityLine(entry: FleetEntry): string {
    const name = `${entry.machine}${entry.local ? " (this machine)" : ""}`;
    const state = entry.available ? "available" : `unavailable: ${entry.reasons.join("; ")}`;
    if (entry.resources) return `${name}: ${state} (${resourcesText(entry.resources)})`;
    if (entry.lastSeen)
        return `${name}: ${state} (stale, last seen ${entry.lastSeen.at}: ${resourcesText(entry.lastSeen)})`;
    return `${name}: ${state}`;
}

/**
 * A machine that may take the work; `depth` is its queue depth and `load` that depth per jawan slot (what ranks it),
 * both null when its toli is too old to report a queue.
 */
export type Candidate = {
    machine: string;
    local: boolean;
    hasClone: boolean;
    depth: number | null;
    load: number | null;
};

export type Rejection = { machine: string; reasons: string[] };

export type PickResult = {
    machine: string | null;
    local: boolean;
    depth: number | null;
    candidates: Candidate[];
    rejected: Rejection[];
};

/** What one unit of work needs from a machine: its project (and whether its git URL is known here) and its shape. */
export type Work = { name: string; urlKnown: boolean; shape?: Shape };

/** Why a machine that marked `project` verify-only gets no ship work for it (pick, delegate, the balancing offers). */
export function verifyOnlyText(project: string): string {
    return `verify-only for ${project}: it takes no ship work for it`;
}

/** Whether `resources` says its machine takes no ship work for `project` (`project set <p> --role verify-only`). */
export function refusesShip(resources: Resources, project: string): boolean {
    return resources.verifyOnly?.includes(project) === true;
}

/** Why a machine that declined `project` (`lead decline`) gets no work of it (pick, the balancing offers). */
export function declinesText(project: string): string {
    return `declines ${project}: it takes no work of ${project}`;
}

/** Whether `resources` says its machine takes no work of `project` at all (`bin/toli lead decline <p>` there). */
export function declines(resources: Resources, project: string): boolean {
    return resources.queue?.declines?.includes(project) === true;
}

/**
 * Rank machines for one unit of work by queue depth per jawan slot (queued tasks + running and waiting jawans, over
 * `capacity.maxRuns`), lightest first; on equal load a machine with the project's clone wins, then this machine, then
 * name order. A machine whose toli reports no queue ranks after every known queue. Load, memory, disk and `available`
 * never pass a machine over: a machine busy with builds but with an empty queue gets work first. Rejected: an
 * unreachable machine, one whose lead said it is full (`lead full`), and with a project, one that declined it (`lead
 * decline`, whatever the shape), one without the clone when the project's URL is not known here, or (for ship work,
 * the default shape) one that marked it verify-only.
 */
export function rankMachines(entries: FleetEntry[], project?: Work): PickResult {
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
        const full = entry.resources.queue?.full;
        if (full !== undefined) {
            rejected.push({ machine: entry.machine, reasons: [fullText(full)] });
            continue;
        }
        if (project !== undefined && declines(entry.resources, project.name)) {
            rejected.push({ machine: entry.machine, reasons: [declinesText(project.name)] });
            continue;
        }
        if (
            project !== undefined &&
            (project.shape ?? "ship") === "ship" &&
            refusesShip(entry.resources, project.name)
        ) {
            rejected.push({ machine: entry.machine, reasons: [verifyOnlyText(project.name)] });
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
        const depth = entry.resources.queue?.depth ?? null;
        candidates.push({
            machine: entry.machine,
            local: entry.local,
            hasClone,
            depth,
            load: depth === null ? null : perSlot(depth, entry.resources.maxRuns),
        });
    }
    candidates.sort((a, b) => {
        if (a.load !== b.load) {
            if (a.load === null) return 1;
            if (b.load === null) return -1;
            return a.load - b.load;
        }
        if (a.depth !== b.depth) return (a.depth ?? 0) - (b.depth ?? 0);
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

/**
 * Pick across the live fleet; `projectName` is checked against this machine's registry for a clonable URL, and
 * `shape` (ship by default) against each machine's verify-only projects.
 */
export async function pickMachine(projectName: string | undefined, shape: Shape = "ship"): Promise<PickResult> {
    const entries = await fleetStatus();
    if (projectName === undefined) return rankMachines(entries);
    const known = loadProjects().find((entry) => entry.name === projectName);
    return rankMachines(entries, { name: projectName, urlKnown: Boolean(known?.url), shape });
}

function noCandidateText(pick: PickResult): string {
    return [
        "no machine qualifies:",
        ...pick.rejected.map((entry) => `  ${entry.machine}: ${entry.reasons.join("; ")}`),
    ].join("\n");
}

/** Prints the chosen machine; exit 2 with each machine's reasons when none qualifies. */
export async function pickCommand(argv: string[]): Promise<number> {
    const args = new Args(argv, { booleans: ["json"], values: ["project", "shape"] });
    args.maxPositional(0);
    const project = args.str("project");
    const pick = await pickMachine(project, parseShape(args.str("shape"), "ship"));
    if (args.bool("json")) printJson(pick);
    else out(pick.machine ?? noCandidateText(pick));
    return pick.machine === null ? 2 : 0;
}
