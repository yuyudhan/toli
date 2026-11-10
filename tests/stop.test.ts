import { describe, expect, test } from "bun:test";
import { pidAlive } from "../src/core/util.ts";
import { stopTargets, stopTree } from "../src/jawans/stop.ts";

describe("stopping a run's processes", () => {
    test("targets are the root, its descendants, its own group and known orphans; never zombies", () => {
        const ps = [
            "  10     1    10 S", // root, leads group 10
            "  11    10    10 S", // child
            "  12    11    10 Z", // zombie grandchild
            "  13     1    10 S", // orphaned group member
            "  14    13    99 S", // its child in another group
            "  15     1     1 S", // unrelated
            "  16     1    16 S", // orphan from an earlier look
        ].join("\n");
        expect(stopTargets(ps, 10).sort()).toEqual([10, 11, 13, 14]);
        expect(stopTargets(ps, 10, new Set([16])).sort()).toEqual([10, 11, 13, 14, 16]);
        // A root that leads no group (a harness sharing toli's group) brings only its own tree.
        const shared = ps.replace(/^(\s*\d+\s+\d+\s+)\d+/gm, (_, head: string) => `${head}1`);
        expect(stopTargets(shared, 10).sort()).toEqual([10, 11]);
    });

    test("a child that ignores SIGTERM outlives its parent's SIGTERM but not the stop", async () => {
        const proc = Bun.spawn(["sh", "-c", '(trap "" TERM; exec sleep 300) & echo $!; wait'], {
            stdout: "pipe",
            stderr: "ignore",
        });
        const reader = proc.stdout.getReader();
        const first = await reader.read();
        const survivor = Number(new TextDecoder().decode(first.value).trim());
        try {
            expect(pidAlive(survivor)).toBe(true);
            expect(await stopTree(proc.pid, 300)).toEqual([]);
            await proc.exited;
            expect(pidAlive(survivor)).toBe(false);
        } finally {
            if (pidAlive(survivor)) process.kill(survivor, "SIGKILL");
        }
    });
});
