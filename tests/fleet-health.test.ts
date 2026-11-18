import { describe, expect, test } from "bun:test";
import { parseClones } from "../src/fleet/clones.ts";
import {
    type HealthRow,
    healthText,
    healthTotal,
    parseDfUse,
    parseHealth,
    parseProcStatBusy,
    parseSwapusage,
} from "../src/fleet/health.ts";
import { parseSections } from "../src/fleet/machine-script.ts";
import { paneActivity, parseTasks, projectWork, runningJawans, workText } from "../src/fleet/work.ts";
import { ENV, fleet, remoteSnapshot } from "./fleet-fixture.ts";
import { AT, LINUX_HEALTH, stubFleetScripts, WORK } from "./fleet-scripts-fixture.ts";

describe("fleet health", () => {
    test("parses Linux /proc, df and a one-second CPU sample", () => {
        const health = parseHealth(parseSections(LINUX_HEALTH));
        expect(health).toEqual({
            cpus: 12,
            load1: 3.35,
            cpuBusyPercent: 60,
            memTotalMB: 32000,
            memUsedMB: 8000,
            swapTotalMB: 8000,
            swapUsedMB: 2000,
            diskTotalGB: 500,
            diskUsedGB: 125,
            diskFreeGB: 375,
        });
        expect(parseProcStatBusy("cpu  1 2 3")).toBeNull();
    });

    test("parses macOS sysctl, vm_stat and top", () => {
        const mac = parseSections(
            [
                "@@ncpu",
                "10",
                "@@loadavg",
                "{ 11.26 19.57 20.40 }",
                "@@memsize",
                String(16 * 1024 ** 3),
                "@@vmstat",
                "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
                "Pages free:                                     65536.",
                "Pages inactive:                                     0.",
                "Pages speculative:                                  0.",
                "Pages purgeable:                                    0.",
                "@@swapusage",
                "total = 3072.00M  used = 1721.38M  free = 1350.62M  (encrypted)",
                "@@top",
                "CPU usage: 67.19% user, 14.94% sys, 17.85% idle ",
                "@@df",
                "Filesystem   1024-blocks      Used Available Capacity  Mounted on",
                "/dev/disk3s1   239362496 190857948  19702868    91%    /System/Volumes/Data",
            ].join("\n"),
        );
        expect(parseHealth(mac)).toEqual({
            cpus: 10,
            load1: 11.26,
            cpuBusyPercent: 82.2,
            memTotalMB: 16384,
            memUsedMB: 15360,
            swapTotalMB: 3072,
            swapUsedMB: 1721,
            diskTotalGB: 228.3,
            diskUsedGB: 182,
            diskFreeGB: 18.8,
        });
        expect(parseSwapusage("total = 1.00G  used = 512.00M")).toEqual({ totalMB: 1024, usedMB: 512 });
        expect(parseDfUse("header only")).toBeNull();
    });

    test("the TOTAL row sums every column over the machines that report it", () => {
        const linux = parseHealth(parseSections(LINUX_HEALTH));
        if (typeof linux === "string") throw new Error(linux);
        const rows: HealthRow[] = [
            { machine: "a", local: true, via: "local", health: linux },
            {
                machine: "b",
                local: false,
                via: "https",
                health: {
                    ...linux,
                    cpus: 4,
                    cpuBusyPercent: null,
                    swapTotalMB: null,
                    swapUsedMB: null,
                    diskTotalGB: null,
                    diskUsedGB: null,
                },
            },
            { machine: "c", local: false, via: null, health: null, reason: "ssh c exited 255: refused" },
        ];
        const total = healthTotal(rows);
        expect(total.cpus).toBe(16);
        expect(total.cpuBusyPercent).toBe(60);
        expect(total.memTotalMB).toBe(64000);
        expect(total.swapTotalMB).toBe(8000);
        expect(total.diskTotalGB).toBe(500);
        const text = healthText(rows);
        expect(text).toContain("TOTAL (2/3)");
        expect(text).toMatch(/c +unreachable/);
        expect(text).toContain("c: unreachable: ssh c exited 255: refused");
        expect(text).toContain("b: read over HTTPS (status): no CPU use, swap or disk size");
    });

    test("reads every machine over ssh with plain tools, and an unreachable one is shown as such", () => {
        const box = fleet(remoteSnapshot("m2"));
        stubFleetScripts(box);
        const output = box.ok(["fleet", "health"], { env: ENV });
        const lines = output.split("\n");
        expect(lines[0]).toMatch(
            /^Machine +CPUs +CPU used +Load 1m +RAM used \/ total +Swap used \/ total +Disk used \/ total$/,
        );
        expect(lines.find((line) => line.startsWith("m1 (this)"))).toBeDefined();
        expect(lines.find((line) => line.startsWith("m2 "))).toMatch(
            /^m2 +12 +60% +3\.35 \(28%\) +7\.8 \/ 31\.3 GB \(25%\) +2 \/ 7\.8 GB \(25%\) +125 \/ 500 GB \(25%\)$/,
        );
        expect(lines.find((line) => line.startsWith("m3 "))).toMatch(/^m3 +unreachable$/);
        expect(output).toContain("TOTAL (2/3)");
        expect(output).toContain(
            "m3: unreachable: ssh host3 exited 255: ssh: connect to host host3 port 22: Connection refused",
        );
        const json = JSON.parse(box.ok(["fleet", "health", "--json"], { env: ENV })) as {
            machines: HealthRow[];
            total: { cpus: number };
        };
        expect(json.machines.map((row) => [row.machine, row.via])).toEqual([
            ["m1", "local"],
            ["m2", "ssh"],
            ["m3", null],
        ]);
        expect(json.total.cpus).toBeGreaterThan(12);
    });
});

describe("fleet work", () => {
    test("the lead's activity is the line above its status bar, without icons or right-aligned extras", () => {
        const pane = parseSections(WORK).find((entry) => entry.name === "pane");
        expect(paneActivity(pane?.body ?? "")).toBe("Waiting for 2 background jobs: A, B");
        expect(paneActivity("no bar here")).toBeNull();
    });

    test("jawans are live spawn runs and native subagents that still report; projects count open tasks", () => {
        const sections = parseSections(WORK);
        const tasks = parseTasks(sections.find((entry) => entry.name === "tasks")?.body ?? null) ?? [];
        const reports = new Map([
            ["BuildT5", { pid: 1, at: "2026-03-04T08:59:00.000Z" }],
            ["GoneT9", { pid: 1, at: "2026-03-04T07:30:00.000Z", endedAt: "2026-03-04T07:30:00.000Z" }],
        ]);
        const runs = [{ id: "j-1", task: "T10", project: "gamma", status: "running", startedAt: AT }];
        const jawans = runningJawans(tasks, runs, reports, Date.parse(AT));
        expect(jawans.map((jawan) => [jawan.kind, jawan.id, jawan.task])).toEqual([
            ["spawn", "j-1", "T10"],
            ["subagent", "BuildT5", "T5"],
        ]);
        const projects = projectWork(tasks, parseClones(sections.find((entry) => entry.name === "clones")?.body ?? ""));
        expect(
            projects.map((project) => [project.project, project.queued, project.held, project.active, project.ahead]),
        ).toEqual([
            ["alpha", 1, 0, 1, 3],
            ["beta", 0, 1, 1, null],
            ["epsilon", 0, 0, 0, 2],
        ]);
    });

    test("reads every machine over ssh: lead, jawans with task and title, open tasks and unpushed commits", () => {
        const box = fleet(remoteSnapshot("m2"));
        stubFleetScripts(box);
        const output = box.ok(["fleet", "work"], { env: ENV, now: AT });
        expect(output).toStartWith("m1 (this machine)\n  lead: ");
        expect(output).toContain(
            [
                "m2",
                "  lead: paltan:toli omp in tmux; service systemd installed, not running (/home/u/.config/systemd/user/toli-lead.service)",
                "    now: Waiting for 2 background jobs: A, B",
                "  jawans running: 2",
                "    T10 (gamma): (no task) [spawn j-1, 10 min ago]",
                "    T5 (alpha): Build the thing [subagent BuildT5, 30 min ago]",
                "  projects:",
                "    alpha: 1 queued, 0 held, 1 active; nightly: 3 ahead, pushed from here 1 h ago, upstream tip 1 h ago",
                "    beta: 0 queued, 1 held, 1 active",
                "    epsilon: 0 queued, 0 held, 0 active; main: 2 ahead",
            ].join("\n"),
        );
        expect(output).toContain(
            "m3: unreachable: ssh host3 exited 255: ssh: connect to host host3 port 22: Connection refused",
        );
    });

    test("workText says when nothing runs and nothing waits", () => {
        expect(
            workText(
                [
                    {
                        machine: "x",
                        local: false,
                        reachable: true,
                        lead: { interactivePid: null, panes: [], activity: null, service: null },
                        jawans: [],
                        projects: [],
                    },
                ],
                Date.parse(AT),
            ),
        ).toBe(
            "x\n  lead: no interactive session; service unknown\n  jawans running: none\n  projects: no open tasks, nothing unpushed",
        );
    });
});
