import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { Args } from "../core/args.ts";
import { type CapacityConfig, loadMachine, type Machine } from "../core/config.ts";
import { isGitRepo } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { now, out, pidAlive, platform, printJson, readJson, run, ToliError, writeJsonAtomic } from "../core/util.ts";
import { type ModelTotal, modelTotalsToday } from "../jawans/runs.ts";
import { loadProjects } from "../projects/projects.ts";
import { busyBuildSlots } from "./build-slots.ts";

/**
 * The machine's load thresholds; `autoResume`, `stallMinutes`, `diskKeep`, `diskSweepStaleMinutes`, `diskBuildTools`
 * and `gateStallMinutes` are not ones (see their readers below, in src/fleet/disk-alert.ts and src/forge/gate.ts).
 */
export type Capacity = Required<
    Omit<
        CapacityConfig,
        "autoResume" | "stallMinutes" | "diskKeep" | "diskSweepStaleMinutes" | "diskBuildTools" | "gateStallMinutes"
    >
>;

const DEFAULT_AUTO_RESUME = 3;
/** Default minutes without progress after which a jawan run counts as stalled. */
export const DEFAULT_STALL_MINUTES = 30;
/** Default age (minutes without use) past which the disk keeper sweeps an artifact out of a busy cargo target. */
export const DEFAULT_DISK_SWEEP_STALE_MINUTES = 180;

/** `capacity.autoResume`: resumes per run chain of stalled, limited or rate-limited runs (0 turns resuming off). */
export function autoResumeLimit(machine: Machine): number {
    const raw = machine.capacity?.autoResume;
    if (raw === undefined) return DEFAULT_AUTO_RESUME;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0)
        throw new ToliError("config/machine.json capacity.autoResume must be a non-negative whole number");
    return raw;
}

/** `capacity.stallMinutes`: minutes without progress after which a jawan run is stopped and resumed. */
export function stallMinutes(machine: Machine): number {
    const raw = machine.capacity?.stallMinutes;
    if (raw === undefined) return DEFAULT_STALL_MINUTES;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)
        throw new ToliError("config/machine.json capacity.stallMinutes must be a positive number");
    return raw;
}

/** `capacity.diskSweepStaleMinutes`: how long an artifact in a busy cargo target must go unused before it is swept. */
export function diskSweepStaleMinutes(machine: Machine): number {
    const raw = machine.capacity?.diskSweepStaleMinutes;
    if (raw === undefined) return DEFAULT_DISK_SWEEP_STALE_MINUTES;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)
        throw new ToliError("config/machine.json capacity.diskSweepStaleMinutes must be a positive number");
    return raw;
}

/** `capacity.diskBuildTools`: the machine's own build tools whose process keeps a target in use (none by default). */
export function diskBuildTools(machine: Machine): string[] {
    const raw: unknown = machine.capacity?.diskBuildTools;
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || !raw.every((tool) => typeof tool === "string" && tool.trim() !== ""))
        throw new ToliError("config/machine.json capacity.diskBuildTools must be a list of non-empty strings");
    return raw;
}

/** One machine's self-reported snapshot (`bin/toli resources --json`). */
export type Resources = {
    machine: string;
    platform: string;
    cpus: number;
    load1: number;
    load5: number;
    memTotalMB: number;
    memAvailableMB: number;
    diskFreeGB: number;
    activeRuns: number;
    maxRuns: number;
    maxLoadPerCpu: number;
    projects: string[];
    available: boolean;
    reasons: string[];
    at: string;
    /** Today's jawan runs per harness and model; absent from machines on an older toli. */
    models?: ModelTotal[];
    /** Heavy-build slots (src/fleet/build-slots.ts) and how many are held now; absent from machines on an older toli. */
    buildSlots?: number;
    buildSlotsBusy?: number;
};

/** A unit of work counted as load on this machine: `state/runs/<runId>.json`. */
export type RunRecord = {
    runId: string;
    pid: number;
    from: string;
    task: string | null;
    startedAt: string;
    title: string;
};

/** One fleet machine as seen from here; `resources` is null when it could not be probed. */
export type FleetEntry = {
    machine: string;
    local: boolean;
    reachable: boolean;
    available: boolean;
    reasons: string[];
    resources: Resources | null;
};

// ---------------------------------------------------------------- measurement

/** macOS: (free + inactive + speculative + purgeable) pages × page size, in MB; null when unparseable. */
export function parseVmStat(text: string): number | null {
    const pageSize = /page size of (\d+) bytes/.exec(text);
    if (!pageSize) return null;
    let pages = 0;
    for (const label of ["free", "inactive", "speculative", "purgeable"]) {
        const match = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.?\\s*$`, "m").exec(text);
        if (!match) return null;
        pages += Number(match[1]);
    }
    return Math.floor((pages * Number(pageSize[1])) / (1024 * 1024));
}

/** Linux: MemTotal and MemAvailable from /proc/meminfo, in MB; null when either is missing. */
export function parseMeminfo(text: string): { totalMB: number; availableMB: number } | null {
    const field = (name: string): number | null => {
        const match = new RegExp(`^${name}:\\s+(\\d+)\\s*kB\\s*$`, "m").exec(text);
        return match ? Math.floor(Number(match[1]) / 1024) : null;
    };
    const totalMB = field("MemTotal");
    const availableMB = field("MemAvailable");
    return totalMB === null || availableMB === null ? null : { totalMB, availableMB };
}

/** Linux: the 1- and 5-minute load averages, the first two fields of /proc/loadavg; null when unparseable. */
export function parseLoadavg(text: string): { load1: number; load5: number } | null {
    const match = /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s/.exec(text);
    return match ? { load1: Number(match[1]), load5: Number(match[2]) } : null;
}

/** Free space (GB, one decimal) on the filesystem holding `dir`, from POSIX `df -Pk`; null when unreadable. */
export function parseDf(text: string): number | null {
    return parseDfVolume(text)?.freeGB ?? null;
}

/** Free and total size (GB, one decimal, rounded down) of the filesystem in `df -Pk` output; null when unreadable. */
export function parseDfVolume(text: string): { freeGB: number; totalGB: number } | null {
    const lines = text.trim().split("\n");
    const columns = (lines.at(-1) ?? "").trim().split(/\s+/);
    if (lines.length < 2 || columns.length < 4) return null;
    const totalKB = Number(columns[1]);
    const availableKB = Number(columns[3]);
    if (!Number.isFinite(totalKB) || !Number.isFinite(availableKB)) return null;
    const toGB = (kb: number): number => Math.floor((kb / (1024 * 1024)) * 10) / 10;
    return { freeGB: toGB(availableKB), totalGB: toGB(totalKB) };
}

/** Linux's /proc; `TOLI_PROC_DIR` overrides it for tests. */
export function procFile(name: string): string {
    return join(process.env.TOLI_PROC_DIR ?? "/proc", name);
}

function measureMemory(): { totalMB: number; availableMB: number } | string {
    if (platform() === "darwin") {
        const result = run(["vm_stat"], { timeoutMs: 10_000 });
        if (result.code !== 0) return `vm_stat exited ${result.code}`;
        const availableMB = parseVmStat(result.stdout);
        if (availableMB === null) return "vm_stat output not understood";
        return { totalMB: Math.floor(totalmem() / (1024 * 1024)), availableMB };
    }
    const meminfo = procFile("meminfo");
    if (!existsSync(meminfo)) return `${meminfo} missing`;
    return parseMeminfo(readFileSync(meminfo, "utf8")) ?? `${meminfo} not understood`;
}

/** macOS: os.loadavg(). Linux: /proc/loadavg, falling back to os.loadavg() (the same kernel numbers) when unreadable. */
function measureLoad(): { load1: number; load5: number } {
    const [load1 = 0, load5 = 0] = loadavg();
    if (platform() === "darwin") return { load1, load5 };
    const file = procFile("loadavg");
    return (existsSync(file) ? parseLoadavg(readFileSync(file, "utf8")) : null) ?? { load1, load5 };
}

/** Free GB on the filesystem holding `dir`, or why it could not be read. */
export function measureDisk(dir: string): number | string {
    const volume = measureVolume(dir);
    return typeof volume === "string" ? volume : volume.freeGB;
}

/** Free and total GB of the filesystem holding `dir`, or why they could not be read. */
export function measureVolume(dir: string): { freeGB: number; totalGB: number } | string {
    const result = run(["df", "-Pk", dir], { timeoutMs: 10_000 });
    if (result.code !== 0) return `df exited ${result.code}`;
    return parseDfVolume(result.stdout) ?? "df output not understood";
}

const DEFAULT_CAPACITY = { maxLoadPerCpu: 0.8, minMemAvailableMB: 2048, diskKeepGB: 60 } as const;

/** The share of the volume's size the disk keeper's floor never goes above, so a small disk is never emptied. */
export const DISK_FLOOR_SHARE = 0.15;

/**
 * The disk keeper's floor: capacity.diskKeepGB, capped at 15% of the volume's size (GB, one decimal, rounded down).
 * `note` says why when the cap applies.
 */
export function diskKeepFloor(configuredGB: number, totalGB: number): { floorGB: number; note?: string } {
    const capGB = Math.floor(totalGB * DISK_FLOOR_SHARE * 10) / 10;
    if (configuredGB <= capGB) return { floorGB: configuredGB };
    const share = `${Math.round(DISK_FLOOR_SHARE * 100)}%`;
    return {
        floorGB: capGB,
        note: `${share} of ${totalGB.toFixed(1)} GB disk; capacity.diskKeepGB ${configuredGB} is above it`,
    };
}

/**
 * The free disk under which the keeper also deletes build output in use (its last resort): max(5 GB, 3% of the
 * volume, GB to one decimal rounded down), never above the floor. Between the floor and it only idle output goes.
 */
export function diskEmergencyGB(floorGB: number, totalGB: number): number {
    return Math.min(floorGB, Math.max(5, Math.floor(totalGB * 0.03 * 10) / 10));
}

/** Thresholds from `config/machine.json` `capacity`, defaults for anything unset. */
export function capacityFor(machine: Machine, cpuCount: number): Capacity {
    const configured = machine.capacity ?? {};
    const value = (key: keyof CapacityConfig, fallback: number): number => {
        const raw = configured[key];
        if (raw === undefined) return fallback;
        if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
            throw new ToliError(`config/machine.json capacity.${key} must be a non-negative number`);
        }
        return raw;
    };
    // One heavy-build slot per six cores, each compiling with its even share of the cores, so all slots busy ≈ cores.
    const buildSlots = value("buildSlots", Math.max(1, Math.floor(cpuCount / 6)));
    if (!Number.isInteger(buildSlots) || buildSlots < 1) {
        throw new ToliError("config/machine.json capacity.buildSlots must be a positive integer");
    }
    const cargoJobs = value("cargoJobs", Math.max(1, Math.floor(cpuCount / buildSlots)));
    if (!Number.isInteger(cargoJobs) || cargoJobs < 1) {
        throw new ToliError("config/machine.json capacity.cargoJobs must be a positive integer");
    }
    return {
        maxRuns: Math.max(1, Math.floor(value("maxRuns", Math.max(1, Math.floor(cpuCount / 4))))),
        maxLoadPerCpu: value("maxLoadPerCpu", DEFAULT_CAPACITY.maxLoadPerCpu),
        minMemAvailableMB: value("minMemAvailableMB", DEFAULT_CAPACITY.minMemAvailableMB),
        diskKeepGB: value("diskKeepGB", DEFAULT_CAPACITY.diskKeepGB),
        cargoJobs,
        buildSlots,
    };
}

export type Measured = Pick<Resources, "cpus" | "load1" | "memAvailableMB" | "diskFreeGB" | "activeRuns">;

/**
 * One reason per breached threshold; a value exactly at its threshold is not a breach (runs: the limit is full). Free
 * disk is never a reason: the disk keeper (src/fleet/disk.ts) frees build output before work starts instead.
 */
export function availabilityReasons(measured: Measured, capacity: Capacity): string[] {
    const reasons: string[] = [];
    if (measured.load1 > measured.cpus * capacity.maxLoadPerCpu) {
        reasons.push(`load ${measured.load1}/${measured.cpus} cpus over ${capacity.maxLoadPerCpu}`);
    }
    return [...reasons, ...startReasons(measured, capacity)];
}

/**
 * The thresholds that stop a run from starting even on a machine picked by name: full run slots or free memory under
 * the floor. Load alone does not, since it swings with the builds already running.
 */
export function startReasons(measured: Pick<Measured, "memAvailableMB" | "activeRuns">, capacity: Capacity): string[] {
    const reasons: string[] = [];
    if (measured.memAvailableMB < capacity.minMemAvailableMB) {
        reasons.push(`memory ${measured.memAvailableMB} MB available, under ${capacity.minMemAvailableMB} MB`);
    }
    if (measured.activeRuns >= capacity.maxRuns)
        reasons.push(`${measured.activeRuns} of ${capacity.maxRuns} runs active`);
    return reasons;
}

/** Why this machine must not start another run now (see startReasons); empty when it may. */
export function localStartRefusal(): string[] {
    const capacity = capacityFor(loadMachine(), Math.max(1, cpus().length));
    const memory = measureMemory();
    if (typeof memory === "string") return [`memory unknown: ${memory}`];
    return startReasons({ memAvailableMB: memory.availableMB, activeRuns: countActiveRuns() }, capacity);
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** This machine's snapshot. Memory measurement failures make it unavailable with the failure as the reason. */
export function localResources(): Resources {
    const machine = loadMachine();
    const cpuCount = Math.max(1, cpus().length);
    const capacity = capacityFor(machine, cpuCount);
    const { load1, load5 } = measureLoad();
    const memory = measureMemory();
    const disk = measureDisk(paths.root());
    const measured: Measured = {
        cpus: cpuCount,
        load1: round2(load1),
        memAvailableMB: typeof memory === "string" ? 0 : memory.availableMB,
        diskFreeGB: typeof disk === "string" ? 0 : disk,
        activeRuns: countActiveRuns(),
    };
    const reasons = [
        ...(typeof memory === "string" ? [`memory unknown: ${memory}`] : []),
        ...availabilityReasons(measured, capacity),
    ];
    return {
        machine: machine.name,
        platform: platform(),
        ...measured,
        load5: round2(load5),
        memTotalMB: typeof memory === "string" ? 0 : memory.totalMB,
        maxRuns: capacity.maxRuns,
        maxLoadPerCpu: capacity.maxLoadPerCpu,
        buildSlots: capacity.buildSlots,
        buildSlotsBusy: busyBuildSlots(capacity.buildSlots),
        projects: loadProjects()
            .map((project) => project.name)
            .filter((name) => isGitRepo(paths.projectDir(name))),
        available: reasons.length === 0,
        reasons,
        at: now().toISOString(),
        models: modelTotalsToday(),
    };
}

// ---------------------------------------------------------------- run records

export function registerRun(record: RunRecord): void {
    writeJsonAtomic(paths.runRecord(record.runId), record);
}

export function removeRun(runId: string): void {
    rmSync(paths.runRecord(runId), { force: true });
}

/** Run records whose pid is alive; records of dead (or unreadable) runs are deleted as they are counted. */
export function countActiveRuns(): number {
    const dir = paths.runsDir();
    if (!existsSync(dir)) return 0;
    let active = 0;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
        const path = join(dir, file);
        let pid = 0;
        try {
            pid = readJson<Partial<RunRecord>>(path, {}).pid ?? 0;
        } catch {
            pid = 0;
        }
        if (pidAlive(pid)) active += 1;
        else rmSync(path, { force: true });
    }
    return active;
}

// ---------------------------------------------------------------- fleet

/** Line shown by `fleet status`, `digest --fleet` and doctor. */
export function availabilityLine(entry: FleetEntry): string {
    const name = `${entry.machine}${entry.local ? " (this machine)" : ""}`;
    const state = entry.available ? "available" : `unavailable: ${entry.reasons.join("; ")}`;
    const r = entry.resources;
    if (!r) return `${name}: ${state}`;
    const detail = [
        `load ${r.load1}/${r.cpus} cpus`,
        `mem ${r.memAvailableMB}/${r.memTotalMB} MB free`,
        `disk ${r.diskFreeGB} GB free`,
        `runs ${r.activeRuns}/${r.maxRuns}`,
        ...(r.buildSlots === undefined ? [] : [`builds ${r.buildSlotsBusy ?? 0}/${r.buildSlots}`]),
        `projects ${r.projects.length === 0 ? "none" : r.projects.join(",")}`,
    ].join(", ");
    return `${name}: ${state} (${detail})`;
}

// ---------------------------------------------------------------- commands

export function resourcesCommand(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const resources = localResources();
    if (args.bool("json")) printJson(resources);
    else
        out(
            availabilityLine({
                machine: resources.machine,
                local: true,
                reachable: true,
                available: resources.available,
                reasons: resources.reasons,
                resources,
            }),
        );
}
