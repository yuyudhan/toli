import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rankMachines } from "../src/fleet/pick.ts";
import {
    availabilityReasons,
    capacityFor,
    type FleetEntry,
    parseDf,
    parseLoadavg,
    parseMeminfo,
    parseVmStat,
    type Resources,
    startReasons,
} from "../src/fleet/resources.ts";
import { sandbox } from "./helpers.ts";

const VM_STAT_APPLE_SILICON = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    20537.
Pages active:                                 486431.
Pages inactive:                               479294.
Pages speculative:                              6975.
Pages throttled:                                   0.
Pages wired down:                             237130.
Pages purgeable:                                6815.
"Translation faults":                    25550871911.
Pages copy-on-write:                      1456714537.
`;

const VM_STAT_INTEL = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                               262144.
Pages active:                             900000.
Pages inactive:                           131072.
Pages speculative:                         65536.
Pages throttled:                               0.
Pages wired down:                         400000.
Pages purgeable:                           65536.
`;

const MEMINFO = `MemTotal:       16318480 kB
MemFree:         1234567 kB
MemAvailable:    9876543 kB
Buffers:          345678 kB
Cached:          5678901 kB
`;

describe("memory parsing", () => {
    test("macOS counts free + inactive + speculative + purgeable pages at the reported page size", () => {
        // (20537 + 479294 + 6975 + 6815) pages × 16 KiB = 8025.3 MB
        expect(parseVmStat(VM_STAT_APPLE_SILICON)).toBe(8025);
        // (262144 + 131072 + 65536 + 65536) pages × 4 KiB = 2048 MB
        expect(parseVmStat(VM_STAT_INTEL)).toBe(2048);
    });

    test("macOS output missing a counted field is not guessed", () => {
        expect(parseVmStat(VM_STAT_INTEL.replace(/^Pages purgeable:.*$/m, ""))).toBeNull();
    });

    test("Linux uses MemAvailable and MemTotal from /proc/meminfo", () => {
        expect(parseMeminfo(MEMINFO)).toEqual({ totalMB: 15936, availableMB: 9645 });
    });

    test("Linux without MemAvailable is not guessed from MemFree", () => {
        expect(parseMeminfo(MEMINFO.replace(/^MemAvailable:.*$/m, ""))).toBeNull();
    });
});

const LOADAVG = "0.52 1.37 2.05 3/1234 98765\n";

/** GNU coreutils `df -Pk` (Debian/Ubuntu/Fedora/WSL2): 342637831 KiB available = 326.7 GB. */
const DF_GNU = `Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/nvme0n1p2   491134264 123456789 342637831      27% /
`;

describe("Linux measurement", () => {
    test("load comes from /proc/loadavg's first two fields", () => {
        expect(parseLoadavg(LOADAVG)).toEqual({ load1: 0.52, load5: 1.37 });
        expect(parseLoadavg("garbage")).toBeNull();
    });

    test("disk free comes from GNU df's Available column", () => {
        expect(parseDf(DF_GNU)).toBe(326.7);
    });

    test("`resources --json` reports /proc load and memory and df disk on Linux", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const proc = join(box.root, ".proc");
        mkdirSync(proc);
        writeFileSync(join(proc, "meminfo"), MEMINFO);
        writeFileSync(join(proc, "loadavg"), LOADAVG);
        box.stub("df", `cat <<'EOF'\n${DF_GNU}EOF`);
        const env = { TOLI_PLATFORM: "linux", TOLI_PROC_DIR: proc };
        const snapshot = JSON.parse(box.ok(["resources", "--json"], { env })) as Resources;
        expect(snapshot).toMatchObject({
            machine: "m1",
            platform: "linux",
            load1: 0.52,
            load5: 1.37,
            memTotalMB: 15936,
            memAvailableMB: 9645,
            diskFreeGB: 326.7,
        });
        rmSync(join(proc, "meminfo"));
        const blind = JSON.parse(box.ok(["resources", "--json"], { env })) as Resources;
        expect(blind.available).toBe(false);
        expect(blind.reasons).toContain(`memory unknown: ${join(proc, "meminfo")} missing`);
    });
});

describe("availability thresholds", () => {
    const capacity = {
        maxRuns: 2,
        maxLoadPerCpu: 0.8,
        minMemAvailableMB: 2048,
        diskKeepGB: 60,
        cargoJobs: 9,
        buildSlots: 1,
    };
    const atLimits = { cpus: 10, load1: 8, memAvailableMB: 2048, diskFreeGB: 5, activeRuns: 1 };

    test("every value exactly at its threshold is still available", () => {
        expect(availabilityReasons(atLimits, capacity)).toEqual([]);
    });

    test("each threshold just past its boundary gives its own reason", () => {
        expect(availabilityReasons({ ...atLimits, load1: 8.01 }, capacity)).toEqual(["load 8.01/10 cpus over 0.8"]);
        expect(availabilityReasons({ ...atLimits, memAvailableMB: 2047 }, capacity)).toEqual([
            "memory 2047 MB available, under 2048 MB",
        ]);
        expect(availabilityReasons({ ...atLimits, activeRuns: 2 }, capacity)).toEqual(["2 of 2 runs active"]);
    });

    test("low free disk is never a reason: the disk keeper frees build output instead", () => {
        expect(availabilityReasons({ ...atLimits, diskFreeGB: 0 }, capacity)).toEqual([]);
    });

    test("all breaches are reported together", () => {
        const reasons = availabilityReasons(
            { cpus: 10, load1: 9, memAvailableMB: 100, diskFreeGB: 1, activeRuns: 3 },
            capacity,
        );
        expect(reasons).toEqual([
            "load 9/10 cpus over 0.8",
            "memory 100 MB available, under 2048 MB",
            "3 of 2 runs active",
        ]);
    });

    test("a run started by name is refused on full slots or low memory, never on load alone", () => {
        const busyCpu = { ...atLimits, load1: 50 };
        expect(startReasons(busyCpu, capacity)).toEqual([]);
        expect(startReasons({ ...atLimits, activeRuns: 2 }, capacity)).toEqual(["2 of 2 runs active"]);
        expect(startReasons({ ...atLimits, memAvailableMB: 2047, activeRuns: 4 }, capacity)).toEqual([
            "memory 2047 MB available, under 2048 MB",
            "4 of 2 runs active",
        ]);
    });

    test("default maxRuns is a quarter of the cpus, never below one; configured values win", () => {
        const machine = { name: "m1", role: "coordinator" as const };
        expect(capacityFor(machine, 8)).toEqual({
            maxRuns: 2,
            maxLoadPerCpu: 0.8,
            minMemAvailableMB: 2048,
            diskKeepGB: 60,
            cargoJobs: 8,
            buildSlots: 1,
        });
        expect(capacityFor(machine, 3).maxRuns).toBe(1);
        expect(capacityFor({ ...machine, capacity: { maxRuns: 5, diskKeepGB: 20, cargoJobs: 12 } }, 8)).toEqual({
            maxRuns: 5,
            maxLoadPerCpu: 0.8,
            minMemAvailableMB: 2048,
            diskKeepGB: 20,
            cargoJobs: 12,
            buildSlots: 1,
        });
    });

    test("cargoJobs defaults to one build slot's share of the cpus and must be a positive integer", () => {
        const machine = { name: "m1", role: "coordinator" as const };
        expect(capacityFor(machine, 18).cargoJobs).toBe(6);
        expect(capacityFor(machine, 1).cargoJobs).toBe(1);
        expect(() => capacityFor({ ...machine, capacity: { cargoJobs: 0 } }, 8)).toThrow("positive integer");
        expect(() => capacityFor({ ...machine, capacity: { cargoJobs: 2.5 } }, 8)).toThrow("positive integer");
    });
});

/** A reachable machine with `depth` queued tasks (null: a toli too old to report its queue). */
function machine(
    name: string,
    depth: number | null,
    options: {
        local?: boolean;
        projects?: string[];
        load1?: number;
        available?: boolean;
        maxRuns?: number;
        full?: { reason: string; since: string; until: string | null };
    } = {},
): FleetEntry {
    const available = options.available ?? true;
    const reasons = available ? [] : ["load 50/10 cpus over 1"];
    const resources: Resources = {
        machine: name,
        platform: "linux",
        cpus: 10,
        load1: options.load1 ?? 0,
        load5: options.load1 ?? 0,
        memTotalMB: 1000,
        memAvailableMB: 1000,
        diskFreeGB: 100,
        activeRuns: 0,
        maxRuns: options.maxRuns ?? 2,
        maxLoadPerCpu: 1,
        projects: options.projects ?? [],
        available,
        reasons,
        at: "2026-10-29T00:00:00.000Z",
        queue:
            depth === null
                ? null
                : {
                      queued: depth,
                      active: 0,
                      held: 0,
                      jawansRunning: 0,
                      jawansQueued: 0,
                      depth,
                      ...(options.full === undefined ? {} : { full: options.full }),
                  },
    };
    return { machine: name, local: options.local ?? false, reachable: true, available, reasons, resources };
}

describe("pick ranking", () => {
    test("the shortest queue wins, whatever the load or availability", () => {
        const pick = rankMachines([
            machine("here", 2, { local: true }),
            machine("busy", 0, { load1: 50, available: false }),
        ]);
        expect(pick).toMatchObject({ machine: "busy", local: false, depth: 0 });
        expect(pick.candidates.map((candidate) => candidate.machine)).toEqual(["busy", "here"]);
    });

    test("on equal depth the clone holder wins, then this machine, then name order", () => {
        const entries = [
            machine("beta", 1),
            machine("here", 1, { local: true }),
            machine("alpha", 1),
            machine("holder", 1, { projects: ["x"] }),
        ];
        expect(rankMachines(entries, { name: "x", urlKnown: true }).candidates.map((c) => c.machine)).toEqual([
            "holder",
            "here",
            "alpha",
            "beta",
        ]);
        expect(rankMachines(entries).candidates.map((c) => c.machine)).toEqual(["here", "alpha", "beta", "holder"]);
    });

    test("a machine whose toli reports no queue ranks after every known queue but stays a candidate", () => {
        const pick = rankMachines([machine("old", null, { local: true }), machine("deep", 9)]);
        expect(pick.candidates).toEqual([
            { machine: "deep", local: false, hasClone: false, depth: 9, load: 4.5 },
            { machine: "old", local: true, hasClone: false, depth: null, load: null },
        ]);
    });

    test("without a known URL only clone holders qualify for a project", () => {
        const pick = rankMachines([machine("fresh", 0), machine("holder", 8, { projects: ["x"] })], {
            name: "x",
            urlKnown: false,
        });
        expect(pick.machine).toBe("holder");
        expect(pick.rejected).toEqual([
            { machine: "fresh", reasons: ["no clone of x, and its git URL is not registered here"] },
        ]);
    });

    test("only unreachable machines are rejected; none left yields no pick with each machine's reasons", () => {
        const gone: FleetEntry = {
            machine: "gone",
            local: false,
            reachable: false,
            available: false,
            reasons: ["unreachable: timeout"],
            resources: null,
        };
        expect(rankMachines([machine("busy", 3, { available: false }), gone]).machine).toBe("busy");
        const pick = rankMachines([gone]);
        expect(pick.machine).toBeNull();
        expect(pick.depth).toBeNull();
        expect(pick.rejected).toEqual([{ machine: "gone", reasons: ["unreachable: timeout"] }]);
    });

    test("ranks by queue per jawan slot: a high-CPU machine with an empty queue first, a big machine before a small", () => {
        const pick = rankMachines([
            machine("small", 3, { maxRuns: 2, local: true }),
            machine("big", 6, { maxRuns: 12 }),
            machine("hot", 0, { load1: 90, available: false }),
        ]);
        expect(pick.candidates.map((c) => [c.machine, c.depth, c.load])).toEqual([
            ["hot", 0, 0],
            ["big", 6, 0.5],
            ["small", 3, 1.5],
        ]);
    });

    test("a machine whose lead is full is passed over with its reason", () => {
        const full = { reason: "earlyoom kills builds", since: "2026-11-10T09:00:00.000Z", until: null };
        const pick = rankMachines([machine("idle", 0, { full }), machine("here", 4, { local: true })]);
        expect(pick.machine).toBe("here");
        expect(pick.rejected).toEqual([
            { machine: "idle", reasons: ["full: earlyoom kills builds (until lead full --clear)"] },
        ]);
    });
});
