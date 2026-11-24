// A slot's command woken while its slot is lent waits only for the builds already lent beside it (T2620: on a Linux
// worker a verifier's nested cargo waited an hour in `waitForLentBuilds`). While it waited, its slot's whole process
// tree looked idle (src/fleet/idle-slots.ts), so each time the lent build ended the next waiter in line was lent the
// same slot, and the woken command waited on that one in turn. Its wait now marks the slot woken: no waiter builds
// beside it, so the lent set only drains.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runs, type Started, slotBox, spinUntil, start, toliArgs, until } from "./build-slot-fixture.ts";

/** How long the test waits for any one of its events before it calls it missed. */
const EVENT_MS = 60_000;

/** Every process below `root` (not `root` itself), from the real process table. */
function descendants(root: number): number[] {
    const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="], { stdout: "pipe" });
    const children = new Map<number, number[]>();
    for (const line of ps.stdout.toString().trim().split("\n")) {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        if (pid === undefined || ppid === undefined) continue;
        children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    }
    const found: number[] = [];
    const queue = [...(children.get(root) ?? [])];
    for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
        found.push(pid);
        queue.push(...(children.get(pid) ?? []));
    }
    return found;
}

/** Send `signal` to each of `pids` still running. */
function signalAll(pids: number[], signal: NodeJS.Signals): void {
    for (const pid of pids) {
        try {
            process.kill(pid, signal);
        } catch {
            // Gone already.
        }
    }
}

describe("a woken slot's command is never starved by builds lent its slot (T2620)", () => {
    test(
        "a waiter arriving while the slot's command waits for a lent build is not lent the slot again",
        async () => {
            const { box, log } = slotBox(1, 3);
            const wake = join(box.root, ".wake");
            const stopFirst = join(box.root, ".stop-first");
            const stopSecond = join(box.root, ".stop-second");
            // The real process table over a one-second idle window for the lenders; the holder's own wait for a lent
            // build keeps the minute's window, as in tests/build-slot-busy-threads.test.ts.
            const real = { TOLI_PROCESS_TABLE: "", TOLI_SLOT_IDLE_MS: "1000" };
            const started: Started[] = [];
            let frozen: number[] = [];
            try {
                // H: a step that runs nothing for a while, then its nested cargo.
                const holder = start(
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
                started.push(holder);
                const slotOne = join(box.root, "state", "build-slots", "1.lock");
                await until(
                    "the holder in slot 1",
                    () => existsSync(slotOne) && readFileSync(slotOne, "utf8").includes(`"pid":${holder.proc.pid},`),
                    EVENT_MS,
                );
                // L1: lent slot 1 once it has run nothing for the window, working until told to stop.
                const first = start(
                    box,
                    toliArgs("build-slot", "--", "sh", "-c", `${spinUntil(stopFirst)}; cargo build`),
                    {
                        ...real,
                        STUB_LABEL: "b",
                    },
                );
                started.push(first);
                await until("L1 beside slot 1", () => first.stderr.join("").includes("building beside it"), EVENT_MS);
                // H wakes: its nested cargo waits for L1.
                mkdirSync(wake);
                await until(
                    "H's nested cargo waiting for L1",
                    () => holder.stderr.join("").includes("lent to a build beside it"),
                    EVENT_MS,
                );
                // L2: waits in line, watching slot 1 for longer than its window.
                const second = start(
                    box,
                    toliArgs("build-slot", "--", "sh", "-c", `${spinUntil(stopSecond)}; cargo build`),
                    { ...real, STUB_LABEL: "c" },
                );
                started.push(second);
                await until(
                    "L2 waiting in line",
                    () => second.stderr.join("").includes("waiting for a heavy-build slot"),
                    EVENT_MS,
                );
                // Real processes: only wall time lets L2 watch slot 1 past its one-second window.
                await Bun.sleep(2000);
                // Hold H's waiting cargo still while L1 ends, so L2 always looks at slot 1 first: the race a stream of
                // waiters always wins.
                frozen = descendants(holder.proc.pid);
                signalAll(frozen, "SIGSTOP");
                mkdirSync(stopFirst);
                expect((await first.done).code).toBe(0);
                // Real processes: only wall time shows L2 staying put over several of its polls and windows.
                await Bun.sleep(3000);
                expect(second.stderr.join("")).not.toContain("building beside it");
                signalAll(frozen, "SIGCONT");
                frozen = [];
                // H's nested cargo runs shortly after L1 ended, while L2 still waits.
                await until("H's nested cargo running", () => runs(log).some((run) => run.label === "a"), EVENT_MS);
                expect(runs(log).some((run) => run.label === "c")).toBe(false);
                mkdirSync(stopSecond);
                const [held, waited] = await Promise.all([holder.done, second.done]);
                expect([held.code, waited.code]).toEqual([0, 0]);
                expect(waited.stderr).not.toContain("building beside it");
                expect(runs(log).map((run) => [run.label, run.slot])).toEqual([
                    ["b", "2"],
                    ["a", "1"],
                    ["c", "1"],
                ]);
            } finally {
                signalAll(frozen, "SIGCONT");
                for (const proc of started) proc.proc.kill("SIGKILL");
            }
        },
        4 * EVENT_MS,
    );
});
