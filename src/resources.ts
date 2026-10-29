import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { Args } from "./args.ts";
import { type CapacityConfig, loadMachine, type Machine } from "./config.ts";
import { isGitRepo } from "./git.ts";
import { paths } from "./paths.ts";
import { loadProjects } from "./projects.ts";
import { MateError, now, out, pidAlive, platform, printJson, readJson, run, writeJsonAtomic } from "./util.ts";

export type Capacity = Required<CapacityConfig>;

/** One machine's self-reported snapshot (`bin/mate resources --json`). */
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

/** Free space (GB, one decimal) on the filesystem holding `dir`, from POSIX `df -Pk`; null when unreadable. */
export function parseDf(text: string): number | null {
    const lines = text.trim().split("\n");
    const columns = (lines.at(-1) ?? "").trim().split(/\s+/);
    if (lines.length < 2 || columns.length < 4) return null;
    const availableKB = Number(columns[3]);
    return Number.isFinite(availableKB) ? Math.floor((availableKB / (1024 * 1024)) * 10) / 10 : null;
}

function measureMemory(): { totalMB: number; availableMB: number } | string {
    if (platform() === "darwin") {
        const result = run(["vm_stat"], { timeoutMs: 10_000 });
        if (result.code !== 0) return `vm_stat exited ${result.code}`;
        const availableMB = parseVmStat(result.stdout);
        if (availableMB === null) return "vm_stat output not understood";
        return { totalMB: Math.floor(totalmem() / (1024 * 1024)), availableMB };
    }
    if (!existsSync("/proc/meminfo")) return "/proc/meminfo missing";
    return parseMeminfo(readFileSync("/proc/meminfo", "utf8")) ?? "/proc/meminfo not understood";
}

function measureDisk(dir: string): number | string {
    const result = run(["df", "-Pk", dir], { timeoutMs: 10_000 });
    if (result.code !== 0) return `df exited ${result.code}`;
    return parseDf(result.stdout) ?? "df output not understood";
}

const DEFAULT_CAPACITY = { maxLoadPerCpu: 0.8, minMemAvailableMB: 2048, minDiskFreeGB: 5 } as const;

/** Thresholds from `config/machine.json` `capacity`, defaults for anything unset. */
export function capacityFor(machine: Machine, cpuCount: number): Capacity {
    const configured = machine.capacity ?? {};
    const value = (key: keyof CapacityConfig, fallback: number): number => {
        const raw = configured[key];
        if (raw === undefined) return fallback;
        if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
            throw new MateError(`config/machine.json capacity.${key} must be a non-negative number`);
        }
        return raw;
    };
    return {
        maxRuns: Math.max(1, Math.floor(value("maxRuns", Math.max(1, Math.floor(cpuCount / 4))))),
        maxLoadPerCpu: value("maxLoadPerCpu", DEFAULT_CAPACITY.maxLoadPerCpu),
        minMemAvailableMB: value("minMemAvailableMB", DEFAULT_CAPACITY.minMemAvailableMB),
        minDiskFreeGB: value("minDiskFreeGB", DEFAULT_CAPACITY.minDiskFreeGB),
    };
}

export type Measured = Pick<Resources, "cpus" | "load1" | "memAvailableMB" | "diskFreeGB" | "activeRuns">;

/** One reason per breached threshold; a value exactly at its threshold is not a breach (runs: the limit is full). */
export function availabilityReasons(measured: Measured, capacity: Capacity): string[] {
    const reasons: string[] = [];
    if (measured.load1 > measured.cpus * capacity.maxLoadPerCpu) {
        reasons.push(`load ${measured.load1}/${measured.cpus} cpus over ${capacity.maxLoadPerCpu}`);
    }
    if (measured.memAvailableMB < capacity.minMemAvailableMB) {
        reasons.push(`memory ${measured.memAvailableMB} MB available, under ${capacity.minMemAvailableMB} MB`);
    }
    if (measured.diskFreeGB < capacity.minDiskFreeGB) {
        reasons.push(`disk ${measured.diskFreeGB} GB free, under ${capacity.minDiskFreeGB} GB`);
    }
    if (measured.activeRuns >= capacity.maxRuns)
        reasons.push(`${measured.activeRuns} of ${capacity.maxRuns} runs active`);
    return reasons;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** This machine's snapshot. Measurement failures make it unavailable with the failure as the reason. */
export function localResources(): Resources {
    const machine = loadMachine();
    const cpuCount = Math.max(1, cpus().length);
    const capacity = capacityFor(machine, cpuCount);
    const [load1 = 0, load5 = 0] = loadavg();
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
        ...(typeof disk === "string" ? [`disk unknown: ${disk}`] : []),
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
        projects: loadProjects()
            .map((project) => project.name)
            .filter((name) => isGitRepo(paths.projectDir(name))),
        available: reasons.length === 0,
        reasons,
        at: now().toISOString(),
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
