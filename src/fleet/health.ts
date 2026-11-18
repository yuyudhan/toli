// `bin/toli fleet health [--json]`: every fleet machine's CPUs, CPU use and load, RAM, swap and the disk holding its
// toli checkout, as one table with a TOTAL row. Read with plain system tools (src/fleet/machine-script.ts), so every
// machine answers whatever toli release it runs; a machine ssh cannot read answers its `resources --json` over HTTPS
// when paired, which has no CPU use, swap or disk size.
import { Args } from "../core/args.ts";
import { out, printJson, ToliError } from "../core/util.ts";
import { runOnFleet, type ScriptOutcome, type Section, section, statusOverHttps } from "./machine-script.ts";
import { parseLoadavg, parseVmStat, type Resources } from "./resources.ts";
import { renderTable } from "./table.ts";

/** One machine's numbers; null where the source could not tell. */
export type Health = {
    cpus: number;
    load1: number;
    /** Share of CPU time busy over a one-second sample, 0-100. */
    cpuBusyPercent: number | null;
    memTotalMB: number;
    memUsedMB: number;
    swapTotalMB: number | null;
    swapUsedMB: number | null;
    diskTotalGB: number | null;
    diskUsedGB: number | null;
    diskFreeGB: number;
};

/** One row of the table: `via` is how it was read; `health` is null when it could not be. */
export type HealthRow = {
    machine: string;
    local: boolean;
    via: "local" | "ssh" | "https" | null;
    health: Health | null;
    reason?: string;
};

/** The script every machine runs from its toli root. */
export const HEALTH_SCRIPT = `
if [ "$(uname -s)" = Darwin ]; then
  echo "@@ncpu"; sysctl -n hw.ncpu
  echo "@@loadavg"; sysctl -n vm.loadavg
  echo "@@memsize"; sysctl -n hw.memsize
  echo "@@vmstat"; vm_stat
  echo "@@swapusage"; sysctl -n vm.swapusage
  echo "@@top"; top -l 2 -n 0 -s 1 | grep 'CPU usage' | tail -n 1
else
  echo "@@ncpu"; nproc 2>/dev/null || getconf _NPROCESSORS_ONLN
  echo "@@loadavg"; cat /proc/loadavg
  echo "@@meminfo"; cat /proc/meminfo
  echo "@@stat"; head -n 1 /proc/stat; sleep 1; head -n 1 /proc/stat
fi
echo "@@df"; df -Pk .
`;

const round1 = (value: number): number => Math.round(value * 10) / 10;
const KB_PER_GB = 1024 * 1024;

/** Linux: busy share of the time between two `cpu` lines of /proc/stat (idle and iowait count as idle). */
export function parseProcStatBusy(text: string): number | null {
    const samples = text
        .split("\n")
        .filter((line) => line.startsWith("cpu "))
        .map((line) => line.trim().split(/\s+/).slice(1, 9).map(Number));
    const [first, second] = samples;
    if (first === undefined || second === undefined || first.length < 5 || second.length < 5) return null;
    if ([...first, ...second].some((value) => !Number.isFinite(value))) return null;
    const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
    const idle = (values: number[]): number => (values[3] ?? 0) + (values[4] ?? 0);
    const total = sum(second) - sum(first);
    if (total <= 0) return null;
    return round1(100 * (1 - (idle(second) - idle(first)) / total));
}

/** macOS: 100 minus the idle share of top's `CPU usage: ... % idle` line. */
export function parseTopBusy(text: string): number | null {
    const idle = /([\d.]+)% idle/.exec(text);
    return idle === null ? null : round1(100 - Number(idle[1]));
}

/** macOS `sysctl -n vm.loadavg` (`{ 1.20 1.31 1.44 }`): the 1-minute load. */
export function parseMacLoad(text: string): number | null {
    const load = Number(/\{\s*([\d.]+)/.exec(text)?.[1]);
    return Number.isFinite(load) ? load : null;
}

/** macOS `sysctl -n vm.swapusage` (`total = 7168.00M  used = 6177.50M ...`): total and used MB. */
export function parseSwapusage(text: string): { totalMB: number; usedMB: number } | null {
    const toMB = (value: string, unit: string): number =>
        Number(value) * ({ K: 1 / 1024, M: 1, G: 1024 }[unit] ?? Number.NaN);
    const total = /total = ([\d.]+)([KMG])/.exec(text);
    const used = /used = ([\d.]+)([KMG])/.exec(text);
    if (total === null || used === null) return null;
    const totalMB = toMB(total[1] ?? "", total[2] ?? "");
    const usedMB = toMB(used[1] ?? "", used[2] ?? "");
    return Number.isFinite(totalMB) && Number.isFinite(usedMB)
        ? { totalMB: Math.round(totalMB), usedMB: Math.round(usedMB) }
        : null;
}

/** One `/proc/meminfo` field in MB, or null. */
function meminfoMB(text: string, field: string): number | null {
    const kb = new RegExp(`^${field}:\\s+(\\d+) kB`, "m").exec(text);
    return kb === null ? null : Math.floor(Number(kb[1]) / 1024);
}

/** `df -Pk` of one directory: total, used and free GB (one decimal). */
export function parseDfUse(text: string): { totalGB: number; usedGB: number; freeGB: number } | null {
    const fields = text.trim().split("\n")[1]?.trim().split(/\s+/) ?? [];
    const [total, used, free] = [fields[1], fields[2], fields[3]].map(Number);
    if (total === undefined || used === undefined || free === undefined) return null;
    if (![total, used, free].every(Number.isFinite)) return null;
    return { totalGB: round1(total / KB_PER_GB), usedGB: round1(used / KB_PER_GB), freeGB: round1(free / KB_PER_GB) };
}

/** A machine's health from the sections HEALTH_SCRIPT printed, or why it is not understood. */
export function parseHealth(sections: Section[]): Health | string {
    const body = (name: string): string => section(sections, name) ?? "";
    const cpus = Number(body("ncpu").trim());
    if (!Number.isInteger(cpus) || cpus < 1) return "CPU count not understood";
    const disk = parseDfUse(body("df"));
    if (disk === null) return "df output not understood";
    const meminfo = section(sections, "meminfo");
    if (meminfo !== null) {
        const load = parseLoadavg(body("loadavg"));
        const total = meminfoMB(meminfo, "MemTotal");
        const available = meminfoMB(meminfo, "MemAvailable");
        const swapTotal = meminfoMB(meminfo, "SwapTotal");
        const swapFree = meminfoMB(meminfo, "SwapFree");
        if (load === null || total === null || available === null) return "/proc output not understood";
        return {
            cpus,
            load1: load.load1,
            cpuBusyPercent: parseProcStatBusy(body("stat")),
            memTotalMB: total,
            memUsedMB: total - available,
            swapTotalMB: swapTotal,
            swapUsedMB: swapTotal === null || swapFree === null ? null : swapTotal - swapFree,
            diskTotalGB: disk.totalGB,
            diskUsedGB: disk.usedGB,
            diskFreeGB: disk.freeGB,
        };
    }
    const load1 = parseMacLoad(body("loadavg"));
    const memBytes = Number(body("memsize").trim());
    const available = parseVmStat(body("vmstat"));
    if (load1 === null || !Number.isFinite(memBytes) || memBytes <= 0 || available === null)
        return "sysctl/vm_stat output not understood";
    const total = Math.floor(memBytes / (1024 * 1024));
    const swap = parseSwapusage(body("swapusage"));
    return {
        cpus,
        load1,
        cpuBusyPercent: parseTopBusy(body("top")),
        memTotalMB: total,
        memUsedMB: Math.max(0, total - available),
        swapTotalMB: swap?.totalMB ?? null,
        swapUsedMB: swap?.usedMB ?? null,
        diskTotalGB: disk.totalGB,
        diskUsedGB: disk.usedGB,
        diskFreeGB: disk.freeGB,
    };
}

/** What a machine's `resources --json` tells: no CPU use, swap or disk size. */
export function healthFromResources(resources: Resources): Health {
    return {
        cpus: resources.cpus,
        load1: resources.load1,
        cpuBusyPercent: null,
        memTotalMB: resources.memTotalMB,
        memUsedMB: Math.max(0, resources.memTotalMB - resources.memAvailableMB),
        swapTotalMB: null,
        swapUsedMB: null,
        diskTotalGB: null,
        diskUsedGB: null,
        diskFreeGB: resources.diskFreeGB,
    };
}

/** How long the HTTPS status fallback may take after a machine's script failed. */
const HTTPS_FALLBACK_MS = 5_000;

/** One machine's row: its script's output, else its status over HTTPS, else why neither worked. */
async function healthRow(outcome: ScriptOutcome): Promise<HealthRow> {
    const base = { machine: outcome.machine, local: outcome.local };
    if (outcome.ok) {
        const health = parseHealth(outcome.sections);
        return typeof health === "string"
            ? { ...base, via: null, health: null, reason: health }
            : { ...base, via: outcome.local ? "local" : "ssh", health };
    }
    // Bounded, so a machine that failed at the ssh cap still leaves the whole command under 30 s.
    const { promise: expired, resolve: expire } = Promise.withResolvers<string>();
    const timer = setTimeout(() => expire(`HTTPS: no answer within ${HTTPS_FALLBACK_MS / 1000}s`), HTTPS_FALLBACK_MS);
    const status = await Promise.race([statusOverHttps(outcome.machine), expired]).finally(() => clearTimeout(timer));
    if (status !== null && typeof status !== "string")
        return { ...base, via: "https", health: healthFromResources(status) };
    return {
        ...base,
        via: null,
        health: null,
        reason: status === null ? outcome.reason : `${outcome.reason}; ${status}`,
    };
}

/** Every fleet machine's health, this machine first. */
export async function fleetHealth(): Promise<HealthRow[]> {
    return await Promise.all((await runOnFleet(HEALTH_SCRIPT)).map(healthRow));
}

const percent = (used: number, total: number): string => (total > 0 ? `${Math.round((100 * used) / total)}%` : "-");

/** `used / total GB (pct)` from MB (`perGB` 1024) or GB (`perGB` 1), or `?` when either is unknown. */
function useText(used: number | null, total: number | null, perGB: number): string {
    if (used === null || total === null) return "?";
    return `${round1(used / perGB)} / ${round1(total / perGB)} GB (${percent(used, total)})`;
}

/** The sums of every column over the machines that report it; CPU use is weighted by CPUs. */
export function healthTotal(rows: HealthRow[]): Health {
    const known = rows.flatMap((row) => (row.health === null ? [] : [row.health]));
    const sum = (pick: (health: Health) => number | null): number | null => {
        const values = known.flatMap((health) => {
            const value = pick(health);
            return value === null ? [] : [value];
        });
        return values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
    };
    const busyCpus = sum((health) => (health.cpuBusyPercent === null ? null : health.cpus));
    const busyWeighted = sum((health) =>
        health.cpuBusyPercent === null ? null : (health.cpuBusyPercent * health.cpus) / 100,
    );
    const diskTotal = sum((health) => health.diskTotalGB);
    const diskUsed = sum((health) => health.diskUsedGB);
    return {
        cpus: sum((health) => health.cpus) ?? 0,
        load1: round1(sum((health) => health.load1) ?? 0),
        cpuBusyPercent: busyCpus === null || busyWeighted === null ? null : round1((100 * busyWeighted) / busyCpus),
        memTotalMB: sum((health) => health.memTotalMB) ?? 0,
        memUsedMB: sum((health) => health.memUsedMB) ?? 0,
        swapTotalMB: sum((health) => health.swapTotalMB),
        swapUsedMB: sum((health) => health.swapUsedMB),
        diskTotalGB: diskTotal === null ? null : round1(diskTotal),
        diskUsedGB: diskUsed === null ? null : round1(diskUsed),
        diskFreeGB: round1(sum((health) => health.diskFreeGB) ?? 0),
    };
}

function cells(name: string, health: Health): string[] {
    return [
        name,
        String(health.cpus),
        health.cpuBusyPercent === null ? "?" : `${Math.round(health.cpuBusyPercent)}%`,
        `${health.load1} (${percent(health.load1, health.cpus)})`,
        useText(health.memUsedMB, health.memTotalMB, 1024),
        useText(health.swapUsedMB, health.swapTotalMB, 1024),
        health.diskTotalGB === null
            ? `? (${health.diskFreeGB} GB free)`
            : useText(health.diskUsedGB, health.diskTotalGB, 1),
    ];
}

/** The table, its TOTAL row and a note per machine that was not (fully) read. */
export function healthText(rows: HealthRow[]): string {
    const header = [
        "Machine",
        "CPUs",
        "CPU used",
        "Load 1m",
        "RAM used / total",
        "Swap used / total",
        "Disk used / total",
    ];
    const body = rows.map((row) => {
        const name = `${row.machine}${row.local ? " (this)" : ""}`;
        return row.health === null ? [name, "unreachable", "", "", "", "", ""] : cells(name, row.health);
    });
    const reachable = rows.filter((row) => row.health !== null);
    const total = cells(`TOTAL (${reachable.length}/${rows.length})`, healthTotal(rows));
    const table = renderTable(header, [...body, total]);
    // A rule above the TOTAL row too, the same as the one under the header.
    table.splice(table.length - 1, 0, table[1] ?? "");
    const notes = rows.flatMap((row) => {
        if (row.health === null) return [`${row.machine}: unreachable: ${row.reason ?? "no answer"}`];
        if (row.via === "https") return [`${row.machine}: read over HTTPS (status): no CPU use, swap or disk size`];
        return [];
    });
    return [...table, ...(notes.length > 0 ? ["", ...notes] : [])].join("\n");
}

/** `toli fleet health [--json]`. */
export async function healthCommand(argv: string[]): Promise<void> {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const rows = await fleetHealth();
    if (rows.length === 0) throw new ToliError("no machines");
    if (args.bool("json")) printJson({ machines: rows, total: healthTotal(rows) });
    else out(healthText(rows));
}
