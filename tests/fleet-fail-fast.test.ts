// Fleet probes fail fast on machines that are down (docs/fleet.md "Unreachable machines"): a short ssh connect
// timeout, a machine no route reached backed off in state/reach.json (`fleet:<name>`, the tick's schedule) and not
// probed again until then, and its row showing the last snapshot seen from it, marked stale.
import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENV, fleet, m3Answers, remoteSnapshot, sshLog } from "./fleet-fixture.ts";
import type { Sandbox } from "./helpers.ts";

const T0 = "2026-11-22T00:35:00.000Z";
const at = (seconds: number): string => new Date(Date.parse(T0) + seconds * 1000).toISOString();

type Entry = { machine: string; reachable: boolean; reasons: string[]; lastSeen?: { at: string } };

function status(box: Sandbox, now: string): Map<string, Entry> {
    const entries = JSON.parse(box.ok(["fleet", "status", "--json"], { env: ENV, now })) as Entry[];
    return new Map(entries.map((entry) => [entry.machine, entry]));
}

/** How many times m3 was asked for its resources over ssh. */
function m3Probes(box: Sandbox): number {
    return sshLog(box)
        .split("\n")
        .filter((line) => line.includes("host3") && line.includes("resources --json")).length;
}

describe("fleet probes on a machine that is down", () => {
    test("probe with a short connect timeout, then skip it until its backoff ends, doubling, and clear it on success", () => {
        const box = fleet(remoteSnapshot("m2"));
        expect(status(box, T0).get("m3")?.reasons[0]).toStartWith("unreachable: ssh host3 exited 255");
        expect(m3Probes(box)).toBe(1);
        expect(sshLog(box)).toContain("ConnectTimeout=5 host3");

        // Within the first 30 s backoff: not probed, the row says why at once.
        const held = status(box, at(10)).get("m3");
        expect(m3Probes(box)).toBe(1);
        expect(held?.reachable).toBe(false);
        expect(held?.reasons[0]).toStartWith("unreachable: ssh host3 exited 255");
        expect(held?.reasons[0]).toContain("(not probed: unreachable 1 time in a row, next probe in 20 s)");
        expect(box.ok(["fleet", "queues"], { env: ENV, now: at(10) })).toContain(
            "m3: unreachable: ssh host3 exited 255",
        );
        expect(m3Probes(box)).toBe(1);

        // Past it: probed again, fails again, backed off for 60 s.
        status(box, at(31));
        expect(m3Probes(box)).toBe(2);
        status(box, at(80));
        expect(m3Probes(box)).toBe(2);

        // Back up: the next probe after the backoff reaches it and clears the backoff.
        m3Answers(box, remoteSnapshot("m3"));
        expect(status(box, at(92)).get("m3")?.reachable).toBe(true);
        expect(status(box, at(93)).get("m3")?.reachable).toBe(true);
        expect(m3Probes(box)).toBe(4);
    });

    test("an unreachable machine's row carries its last snapshot, marked stale", () => {
        const box = fleet(remoteSnapshot("m2"));
        m3Answers(box, remoteSnapshot("m3", { at: "2026-11-21T22:00:00.000Z" }));
        expect(status(box, T0).get("m3")?.reachable).toBe(true);
        rmSync(join(box.root, ".m3.json"));

        const entry = status(box, at(60)).get("m3");
        expect(entry?.reachable).toBe(false);
        expect(entry?.lastSeen?.at).toBe("2026-11-21T22:00:00.000Z");
        const line = box
            .ok(["fleet", "status"], { env: ENV, now: at(61) })
            .split("\n")
            .find((text) => text.startsWith("m3:"));
        expect(line).toStartWith("m3: unavailable: unreachable: ssh host3 exited 255");
        expect(line).toContain("(stale, last seen 2026-11-21T22:00:00.000Z: queue 0 (0 queued");
        const queues = box
            .ok(["fleet", "queues"], { env: ENV, now: at(62) })
            .split("\n")
            .find((text) => text.startsWith("m3:"));
        expect(queues).toContain("; stale, last seen 2026-11-21T22:00:00.000Z: queue 0 (0 queued");
        // A stale snapshot is never ranked: pick does not choose m3 from it.
        const pick = JSON.parse(box.ok(["pick", "--json"], { env: ENV, now: at(63) })) as {
            candidates: { machine: string }[];
        };
        expect(pick.candidates.map((candidate) => candidate.machine)).not.toContain("m3");
    });

    test("a machine reached only by ssh is skipped while the tick's own ssh to it is backed off", () => {
        const box = fleet(remoteSnapshot("m2"));
        writeFileSync(
            join(box.root, "state", "reach.json"),
            JSON.stringify({
                host3: {
                    failures: 4,
                    retryAt: Date.parse(at(240)),
                    error: "ssh: connect to host host3 port 22: timed out",
                },
            }),
        );
        const entry = status(box, T0).get("m3");
        expect(m3Probes(box)).toBe(0);
        expect(entry?.reasons).toEqual([
            "unreachable: ssh: connect to host host3 port 22: timed out (not probed: the tick's ssh to host3 failed 4 times in a row, next probe in 240 s)",
        ]);
        // Once the tick's backoff ends it is probed again.
        status(box, at(241));
        expect(m3Probes(box)).toBe(1);
    });
});
