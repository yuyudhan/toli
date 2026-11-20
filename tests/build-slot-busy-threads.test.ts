// At most `capacity.buildSlots` heavy builds run at once (T2050: on a Linux worker with one slot, a push gate's cargo
// test held slot 1 while `bin/toli build-slot` and a third cargo took slots 2 and 3 beside it, three builds at 8 jobs
// each, load 554 on 12 cores). On Linux `ps -o stat` shows a process's main thread, and rustc compiles on a thread of
// its own while its main thread sleeps on it (as a test binary's harness, mold and lld do), so a slot compiling flat
// out showed `Sl` throughout, counted as idle after a minute (src/fleet/idle-slots.ts) and every waiter built beside
// it. A process runs when any of its threads (/proc/<pid>/task/<tid>/stat) does. And a slot lent to a build beside it
// while its command really ran nothing stays lent: its command's next build waits for that one to end.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { idleSlots } from "../src/fleet/idle-slots.ts";
import { processTable } from "../src/fleet/outside-builds.ts";
import type { Resources } from "../src/fleet/resources.ts";
import { holdSlot, runs, type Started, slotBox, spinUntil, start, toliArgs, until } from "./build-slot-fixture.ts";
import { tempDir } from "./helpers.ts";

/** How long the lent-slot test waits for any one of its events before it calls it missed. */
const EVENT_MS = 60_000;

/** A process table in `ps -o pid=,ppid=,stat=,args=` format. */
const table = (rows: [number, number, string, string][]): string =>
    rows.map(([pid, ppid, stat, args]) => `${pid} ${ppid} ${stat} ${args}\n`).join("");

/** Fake /proc thread states of `pid`: `/proc/<pid>/task/<tid>/stat` for each `[tid, comm, state]`. */
function threads(proc: string, pid: number, states: [number, string, string][]): void {
    for (const [tid, comm, state] of states) {
        mkdirSync(join(proc, String(pid), "task", String(tid)), { recursive: true });
        writeFileSync(join(proc, String(pid), "task", String(tid), "stat"), `${tid} (${comm}) ${state} ${pid} 1 1 0\n`);
    }
}

/** A slot's build: its holder, cargo, and a rustc whose main thread sleeps (`Sl`, as Linux `ps` shows it). */
const compiling = (holder: number): [number, number, string, string][] => [
    [holder, 1, "Sl", "bun bin/toli build-slot -- cargo test"],
    [900_001, holder, "Sl", "cargo test -p app-backend"],
    [900_002, 900_001, "Sl", "rustc --crate-name app_backend --edition=2024 src/lib.rs"],
];

const saved: Record<string, string | undefined> = {};
function setEnv(values: Record<string, string>): void {
    for (const [key, value] of Object.entries(values)) {
        if (!(key in saved)) saved[key] = process.env[key];
        process.env[key] = value;
    }
}
afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
        delete saved[key];
    }
});

describe("at most capacity.buildSlots heavy builds at once (T2050)", () => {
    test("a second build waits for a slot whose rustc works on a thread, past every idle window", async () => {
        const { box, log } = slotBox(1, 3);
        const proc = join(box.root, ".proc");
        const tableFile = join(box.root, ".process-table");
        const started: Started[] = [await holdSlot(box, log)];
        try {
            const lock = join(box.root, "state", "build-slots", "1.lock");
            const { pid } = JSON.parse(readFileSync(lock, "utf8")) as { pid: number };
            writeFileSync(tableFile, table(compiling(pid)));
            // The rustc's main thread sleeps; its compiler thread runs.
            threads(proc, 900_002, [
                [900_002, "rustc", "S"],
                [900_003, "opt cgu.00 (x)", "R"],
            ]);
            const waiter = start(box, ["cargo", "build"], {
                STUB_LABEL: "b",
                TOLI_PROC_DIR: proc,
                TOLI_SLOT_IDLE_MS: "1000",
            });
            started.push(waiter);
            // Real slot processes and flocks, so only wall time shows the waiter staying put: three idle windows, past
            // which a build that counted the slot idle would have taken slot 2.
            await Bun.sleep(3500);
            expect(waiter.stderr.join("")).toContain("waiting for a heavy-build slot (1 busy)");
            expect((JSON.parse(box.ok(["resources", "--json"])) as Resources).buildSlotsBusy).toBe(1);
            expect(runs(log).map((run) => run.label)).toEqual(["a"]);
            writeFileSync(`${log}.done-a`, "");
            const held = await started[0]?.done;
            // The build is over: its rustc is gone from the table too, or it would count as a build outside the slots.
            writeFileSync(tableFile, "");
            const waited = await waiter.done;
            expect([held?.code, waited.code]).toEqual([0, 0]);
            expect(waited.stderr).not.toContain("has run nothing");
            expect(runs(log)[1]).toMatchObject({ label: "b", slot: "1" });
        } finally {
            for (const proc of started) proc.proc.kill("SIGKILL");
        }
    }, 40_000);

    test("a slot whose every thread sleeps still counts as idle once the window passes (T1660)", () => {
        const dir = tempDir("idle-threads");
        const proc = join(dir, "proc");
        mkdirSync(proc);
        writeFileSync(join(dir, "table"), table(compiling(900_000)));
        setEnv({ TOLI_PROCESS_TABLE: join(dir, "table"), TOLI_PROC_DIR: proc, TOLI_ROOT: dir });
        threads(proc, 900_002, [
            [900_002, "rustc", "S"],
            [900_003, "opt cgu.00 (x)", "S"],
        ]);
        const slot = { slot: 1, pid: 900_000, cwd: dir, targetDir: null, beside: [] };
        // Watched since well before the window, so this one sample decides.
        const since = Date.now() - 5000;
        const asleep = { windowMs: 1000, seen: new Map([["1:900000", { since, samples: [] }]]) };
        expect(idleSlots(asleep, [slot], processTable())).toEqual([slot]);
        threads(proc, 900_002, [[900_004, "rustc", "D"]]);
        const awake = { windowMs: 1000, seen: new Map([["1:900000", { since, samples: [] }]]) };
        expect(idleSlots(awake, [slot], processTable())).toEqual([]);
    });

    test(
        "a slot's command woken after a build was lent its slot waits for that build before it builds again",
        async () => {
            const { box, log } = slotBox(1, 3);
            const wake = join(box.root, ".wake");
            const stop = join(box.root, ".stop");
            // The real process table, so the slot's sleeping command reads as idle to the build lent its slot, over a short
            // window. The gate's own wait for that build keeps the minute's window: over a second, sampled every half
            // second, one look at the lent build's last step starting up (its shell waiting on a child) on a loaded machine
            // reads as idle and lets the gate through early, as the escape from a deadlock should after a real minute.
            const real = { TOLI_PROCESS_TABLE: "", TOLI_SLOT_IDLE_MS: "1000" };
            const started: Started[] = [];
            try {
                // A gate's recipe: a step that runs nothing for a while (a service starting, a lock), then its next cargo.
                const gate = start(
                    box,
                    toliArgs(
                        "build-slot",
                        "--",
                        "sh",
                        "-c",
                        `until [ -e "${wake}" ]; do kill -0 ${process.pid} 2>/dev/null || exit 1; sleep 0.3; done; cargo build`,
                    ),
                    { ...real, TOLI_SLOT_IDLE_MS: "60000", STUB_LABEL: "a" },
                );
                started.push(gate);
                // Events, each bounded only by the test's own limit: on a loaded machine (a full `just check` at load 25)
                // starting each `build-slot` alone can take longer than `until`'s default 15 s.
                const slotOne = join(box.root, "state", "build-slots", "1.lock");
                await until(
                    "the gate holding the slot",
                    () => existsSync(slotOne) && readFileSync(slotOne, "utf8").includes(`"pid":${gate.proc.pid},`),
                    EVENT_MS,
                );
                // A build that waits a window, takes a slot beside the idle one, and works until told to stop.
                const beside = start(box, toliArgs("build-slot", "--", "sh", "-c", `${spinUntil(stop)}; cargo build`), {
                    ...real,
                    STUB_LABEL: "b",
                });
                started.push(beside);
                await until(
                    "the build beside the idle slot",
                    () => beside.stderr.join("").includes("building beside it"),
                    EVENT_MS,
                );
                mkdirSync(wake);
                await until(
                    "the gate's cargo waiting",
                    () => gate.stderr.join("").includes("lent to a build beside it"),
                    EVENT_MS,
                );
                // Real processes: only wall time shows the gate's cargo staying put past two of the beside build's windows.
                await Bun.sleep(2500);
                expect(runs(log)).toEqual([]);
                mkdirSync(stop);
                const [ran, lent] = await Promise.all([gate.done, beside.done]);
                expect([ran.code, lent.code]).toEqual([0, 0]);
                expect(ran.stderr).not.toContain("has run nothing");
                const [first, second] = runs(log);
                expect(first).toMatchObject({ label: "b", slot: "2" });
                expect(second).toMatchObject({ label: "a", slot: "1" });
                // The lent build ended before the gate's started: its end comes before the gate's start in the log.
                expect(
                    readFileSync(log, "utf8")
                        .trim()
                        .split("\n")
                        .map((line) => line.split(" ").slice(0, 2).join(" ")),
                ).toEqual(["start b", "end b", "start a", "end a"]);
            } finally {
                for (const proc of started) proc.proc.kill("SIGKILL");
            }
        },
        3 * EVENT_MS,
    );
});
