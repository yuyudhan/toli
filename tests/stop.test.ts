import { describe, expect, test } from "bun:test";
import { pidAlive } from "../src/core/util.ts";
import { type Identities, stopTargets, stopTree } from "../src/jawans/stop.ts";

const NOW = 1_800_000_000_000;
/** The run's root, pid 10, spawned a minute before the look. */
const ROOT = { pid: 10, spawnedAtMs: NOW - 60_000 };

/** `ps -A -o pid=,ppid=,pgid=,stat=,etime=` rows. */
function ps(rows: [pid: number, ppid: number, pgid: number, stat: string, etime: string][]): string {
    return rows.map((row) => `  ${row.join("  ")}`).join("\n");
}

const pids = (targets: Identities): number[] => [...targets.keys()].sort((a, b) => a - b);

describe("stopping a run's processes", () => {
    test("targets are the root, its descendants and its own group; never zombies or unrelated processes", () => {
        const look = ps([
            [5, 1, 5, "S", "10:00"], // the root's parent (toli)
            [10, 5, 10, "S", "01:00"], // root, leads group 10
            [11, 10, 10, "S", "00:50"], // child
            [12, 11, 10, "Z", "00:40"], // zombie grandchild
            [13, 1, 10, "S", "00:30"], // group member orphaned when its parent died
            [14, 13, 99, "S", "00:20"], // its child, in a group of its own
            [15, 1, 15, "S", "05:00"], // unrelated
            [16, 5, 5, "S", "01:00"], // started alongside the root by the same parent
        ]);
        expect(pids(stopTargets(look, NOW, ROOT, new Map()))).toEqual([10, 11, 13, 14]);
        // A root that leads no group (a harness sharing toli's group) brings only its own tree.
        const shared = look.replace(/^(\s*\d+\s+\d+\s+)\d+/gm, (_, head: string) => `${head}5`);
        expect(pids(stopTargets(shared, NOW, ROOT, new Map()))).toEqual([10, 11]);
    });

    test("a pid reused by an unrelated process is never taken for the run's", () => {
        // The root's pid now belongs to a process started 55 s after the run's root: neither it nor its group is ours.
        const recycled = ps([
            [10, 1, 10, "S", "00:05"],
            [11, 10, 10, "S", "00:04"],
        ]);
        expect(pids(stopTargets(recycled, NOW, ROOT, new Map()))).toEqual([]);
        // The root is gone; a member seen by an earlier look still matches, so the group is still the run's.
        const orphans = ps([
            [13, 1, 10, "S", "00:30"],
            [17, 1, 10, "S", "00:10"],
        ]);
        const seen: Identities = new Map([[13, NOW - 30_000]]);
        expect(pids(stopTargets(orphans, NOW, ROOT, seen))).toEqual([13, 17]);
        // The earlier member's pid started again since (another process): nothing is the run's any more.
        const reused = ps([
            [13, 1, 10, "S", "00:01"],
            [17, 1, 10, "S", "00:01"],
        ]);
        expect(pids(stopTargets(reused, NOW, ROOT, seen))).toEqual([]);
    });

    test("a child that ignores SIGTERM is killed; a process started alongside the run survives", async () => {
        const alongside = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
        const proc = Bun.spawn(["sh", "-c", '(trap "" TERM; exec sleep 300) & echo $!; wait'], {
            stdout: "pipe",
            stderr: "ignore",
        });
        const spawnedAtMs = Date.now();
        const first = await proc.stdout.getReader().read();
        const survivor = Number(new TextDecoder().decode(first.value).trim());
        try {
            expect(pidAlive(survivor)).toBe(true);
            expect(await stopTree({ pid: proc.pid, spawnedAtMs }, 300)).toEqual([]);
            await proc.exited;
            expect(pidAlive(survivor)).toBe(false);
            expect(pidAlive(alongside.pid)).toBe(true);
        } finally {
            if (pidAlive(survivor)) process.kill(survivor, "SIGKILL");
            alongside.kill("SIGKILL");
        }
    });
});
