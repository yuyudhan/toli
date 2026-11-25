// T2742: when this machine's own network is down (NetBird dropped), every fleet probe fails at once with "Network is
// unreachable". That is a local outage, not each peer failing: no peer is backed off for it, so the first pass after
// the network returns probes them all again. Any toli ssh that reaches a peer (`task list --fleet`) also clears that
// peer's backoff. A peer that is really down while the others answer is still backed off (tests/fleet-fail-fast.test.ts).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENV, fleet, remoteSnapshot } from "./fleet-fixture.ts";
import { type Sandbox, SSH_STUB_ARGS } from "./helpers.ts";

const T0 = "2026-11-25T04:36:00.000Z";
const at = (seconds: number): string => new Date(Date.parse(T0) + seconds * 1000).toISOString();

type Entry = { machine: string; reachable: boolean; reasons: string[] };

function status(box: Sandbox, now: string): Map<string, Entry> {
    const entries = JSON.parse(box.ok(["fleet", "status", "--json"], { env: ENV, now })) as Entry[];
    return new Map(entries.map((entry) => [entry.machine, entry]));
}

/**
 * m2, m3 and m4 answer `resources --json` and `task list --json`, except while `.offline` exists, when every ssh fails
 * the way ssh does with no local route (`fail` is the line it prints); `.down-m4` keeps m4 alone refusing.
 */
function mesh(fail = "Network is unreachable"): Sandbox {
    const box = fleet(remoteSnapshot("m2"));
    writeFileSync(
        join(box.root, "config", "fleet.json"),
        JSON.stringify({
            machines: ["m1", "m2", "m3", "m4"].map((name, index) => ({
                name,
                ssh: `host${index + 1}`,
                root: "/srv/toli",
            })),
        }),
    );
    box.stub(
        "ssh",
        [
            `printf '%s\\n' "$*" >> "${join(box.root, ".ssh.log")}"`,
            SSH_STUB_ARGS,
            `if [ -f "${join(box.root, ".offline")}" ]; then echo "ssh: connect to host $host port 22: ${fail}" >&2; exit 255; fi`,
            `if [ "$host" = host4 ] && [ -f "${join(box.root, ".down-m4")}" ]; then echo 'ssh: connect to host host4 port 22: Connection refused' >&2; exit 255; fi`,
            'case "$cmd" in',
            `  *"resources --json"*) cat "${join(box.root, ".snap")}.$host" ;;`,
            "  *\"task list --json\"*) echo '[]' ;;",
            "  *) cat >/dev/null ;;",
            "esac",
        ].join("\n"),
    );
    for (const [index, name] of ["m2", "m3", "m4"].entries())
        writeFileSync(join(box.root, `.snap.host${index + 2}`), remoteSnapshot(name));
    return box;
}

function offline(box: Sandbox, down: boolean): void {
    const flag = join(box.root, ".offline");
    if (down) writeFileSync(flag, "");
    else rmSync(flag, { force: true });
}

function reachState(box: Sandbox): Record<string, unknown> {
    const file = join(box.root, "state", "reach.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
}

const PEERS = ["m2", "m3", "m4"];

describe("fleet probes after this machine's own network outage (T2742)", () => {
    test("every peer failing with Network is unreachable backs none off; the next pass after recovery reaches them", () => {
        const box = mesh();
        offline(box, true);
        const down = status(box, T0);
        for (const name of PEERS) expect(down.get(name)?.reachable).toBe(false);
        expect(Object.keys(reachState(box)).filter((key) => key.startsWith("fleet:"))).toEqual([]);

        offline(box, false);
        const up = status(box, at(10));
        for (const name of PEERS) {
            expect(up.get(name)?.reasons.join("; ")).not.toContain("not probed");
            expect(up.get(name)?.reachable).toBe(true);
        }
        expect(box.ok(["fleet", "queues"], { env: ENV, now: at(11) })).not.toContain("unreachable");
    });

    test("every peer failing at once with any no-route error is a local outage, not each peer's backoff", () => {
        const box = mesh("Connection timed out during banner exchange");
        offline(box, true);
        status(box, T0);
        expect(Object.keys(reachState(box)).filter((key) => key.startsWith("fleet:"))).toEqual([]);
        offline(box, false);
        const up = status(box, at(10));
        for (const name of PEERS) expect(up.get(name)?.reachable).toBe(true);
    });

    test("a peer down while the others answer is still backed off", () => {
        const box = mesh();
        writeFileSync(join(box.root, ".down-m4"), "");
        status(box, T0);
        expect(Object.keys(reachState(box))).toContain("fleet:m4");
        const held = status(box, at(10)).get("m4");
        expect(held?.reasons[0]).toContain("not probed: unreachable 1 time in a row");
    });

    test("task list --fleet reaching a backed-off peer clears its backoff, so the next probe tries it", () => {
        const box = mesh();
        writeFileSync(join(box.root, ".down-m4"), "");
        status(box, T0);
        expect(Object.keys(reachState(box))).toContain("fleet:m4");
        rmSync(join(box.root, ".down-m4"));
        box.ok(["task", "list", "--fleet"], { env: ENV, now: at(5) });
        expect(Object.keys(reachState(box))).not.toContain("fleet:m4");
        expect(status(box, at(10)).get("m4")?.reachable).toBe(true);
    });
});
