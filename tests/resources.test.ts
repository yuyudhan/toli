import { describe, expect, test } from "bun:test";
import { rankMachines } from "../src/fleet/pick.ts";
import {
    availabilityReasons,
    capacityFor,
    type FleetEntry,
    parseMeminfo,
    parseVmStat,
    type Resources,
} from "../src/fleet/resources.ts";

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

describe("availability thresholds", () => {
    const capacity = { maxRuns: 2, maxLoadPerCpu: 0.8, minMemAvailableMB: 2048, minDiskFreeGB: 5 };
    const atLimits = { cpus: 10, load1: 8, memAvailableMB: 2048, diskFreeGB: 5, activeRuns: 1 };

    test("every value exactly at its threshold is still available", () => {
        expect(availabilityReasons(atLimits, capacity)).toEqual([]);
    });

    test("each threshold just past its boundary gives its own reason", () => {
        expect(availabilityReasons({ ...atLimits, load1: 8.01 }, capacity)).toEqual(["load 8.01/10 cpus over 0.8"]);
        expect(availabilityReasons({ ...atLimits, memAvailableMB: 2047 }, capacity)).toEqual([
            "memory 2047 MB available, under 2048 MB",
        ]);
        expect(availabilityReasons({ ...atLimits, diskFreeGB: 4.9 }, capacity)).toEqual([
            "disk 4.9 GB free, under 5 GB",
        ]);
        expect(availabilityReasons({ ...atLimits, activeRuns: 2 }, capacity)).toEqual(["2 of 2 runs active"]);
    });

    test("all breaches are reported together", () => {
        const reasons = availabilityReasons(
            { cpus: 10, load1: 9, memAvailableMB: 100, diskFreeGB: 1, activeRuns: 3 },
            capacity,
        );
        expect(reasons).toHaveLength(4);
    });

    test("default maxRuns is a quarter of the cpus, never below one; configured values win", () => {
        const machine = { name: "m1", role: "coordinator" as const };
        expect(capacityFor(machine, 8)).toEqual({
            maxRuns: 2,
            maxLoadPerCpu: 0.8,
            minMemAvailableMB: 2048,
            minDiskFreeGB: 5,
        });
        expect(capacityFor(machine, 3).maxRuns).toBe(1);
        expect(capacityFor({ ...machine, capacity: { maxRuns: 5, minDiskFreeGB: 20 } }, 8)).toEqual({
            maxRuns: 5,
            maxLoadPerCpu: 0.8,
            minMemAvailableMB: 2048,
            minDiskFreeGB: 20,
        });
    });
});

/** A reachable, available machine whose score is `1 - load1 / 10` (full memory headroom, no runs). */
function machine(name: string, load1: number, options: { local?: boolean; projects?: string[] } = {}): FleetEntry {
    const resources: Resources = {
        machine: name,
        platform: "linux",
        cpus: 10,
        load1,
        load5: load1,
        memTotalMB: 1000,
        memAvailableMB: 1000,
        diskFreeGB: 100,
        activeRuns: 0,
        maxRuns: 2,
        maxLoadPerCpu: 1,
        projects: options.projects ?? [],
        available: true,
        reasons: [],
        at: "2026-10-29T00:00:00.000Z",
    };
    return { machine: name, local: options.local ?? false, reachable: true, available: true, reasons: [], resources };
}

describe("pick ranking", () => {
    test("score is the smaller headroom minus the share of run slots in use", () => {
        const entry = machine("m", 0);
        if (!entry.resources) throw new Error("fixture");
        entry.resources = { ...entry.resources, load1: 2, cpus: 4, memAvailableMB: 750, activeRuns: 1, maxRuns: 4 };
        // cpu 1 - 2/4 = 0.5, memory 0.75 -> 0.5, minus 1/4
        expect(rankMachines([entry]).score).toBe(0.25);
    });

    test("this machine wins when within 0.1 of the best", () => {
        const pick = rankMachines([machine("remote", 4), machine("here", 4.5, { local: true })]);
        expect(pick.machine).toBe("here");
        expect(pick.local).toBe(true);
    });

    test("this machine loses when more than 0.1 behind", () => {
        const pick = rankMachines([machine("remote", 4), machine("here", 5.5, { local: true })]);
        expect(pick.machine).toBe("remote");
        expect(pick.local).toBe(false);
    });

    test("a clone holder beats a slightly better machine without the clone", () => {
        const pick = rankMachines([machine("fresh", 4), machine("holder", 4.5, { projects: ["x"] })], {
            name: "x",
            urlKnown: true,
        });
        expect(pick.machine).toBe("holder");
    });

    test("this machine is preferred over a clone holder in the band", () => {
        const pick = rankMachines([machine("holder", 4, { projects: ["x"] }), machine("here", 4.5, { local: true })], {
            name: "x",
            urlKnown: true,
        });
        expect(pick.machine).toBe("here");
    });

    test("otherwise name order decides within the band", () => {
        const pick = rankMachines([machine("beta", 4), machine("alpha", 4.5), machine("gamma", 9)]);
        expect(pick.candidates.map((candidate) => candidate.machine)).toEqual(["alpha", "beta", "gamma"]);
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

    test("no available machine yields no pick and keeps each machine's reasons", () => {
        const busy: FleetEntry = { ...machine("busy", 0), available: false, reasons: ["2 of 2 runs active"] };
        const gone: FleetEntry = {
            machine: "gone",
            local: false,
            reachable: false,
            available: false,
            reasons: ["unreachable: timeout"],
            resources: null,
        };
        const pick = rankMachines([busy, gone]);
        expect(pick.machine).toBeNull();
        expect(pick.rejected).toEqual([
            { machine: "busy", reasons: ["2 of 2 runs active"] },
            { machine: "gone", reasons: ["unreachable: timeout"] },
        ]);
    });
});
