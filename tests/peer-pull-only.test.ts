// A paired peer's pull-only flag (docs/peers.md "A peer that takes no inbound connection"): two real installations,
// the listeners on 127.0.0.1. Only a machine configured to take no inbound connection marks itself pull-only, in its
// pulls and its announces; an announce without the flag clears a stale mark (one a pull made while its listener was
// off left), and doctor warns about a peer marked pull-only that has stopped pulling (T2246).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type PeerBox, peerBox, pin } from "./peer-fixture.ts";
import { type Listening, serve } from "./peer-serve-fixture.ts";

const running: Listening[] = [];
afterEach(async () => {
    for (const listening of running.splice(0)) await listening.stop();
});

async function start(box: PeerBox, env: Record<string, string> = {}): Promise<Listening> {
    const listening = await serve(box, env);
    running.push(listening);
    return listening;
}

/** A port nothing listens on right now. */
function freePort(): number {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = server.port;
    server.stop(true);
    return port;
}

/** Pin `a` and `b` to each other: `a` reaches `b` at `bAddr`, `b` reaches `a` at `aAddr` (if any). */
function link(a: PeerBox, b: PeerBox, options: { bAddr?: string; aAddr?: string } = {}): void {
    pin(a.box, [
        { name: b.name, identity: b, cert: b.cert, addrs: options.bAddr === undefined ? [] : [options.bAddr] },
    ]);
    pin(b.box, [
        { name: a.name, identity: a, cert: a.cert, addrs: options.aAddr === undefined ? [] : [options.aAddr] },
    ]);
}

/** The words of each `talk` message from `from` in `box`'s inbox, oldest first. */
function talks(box: PeerBox, from: string): string[] {
    const dir = join(box.box.root, "data", "inbox");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .sort()
        .map((file) => readFileSync(join(dir, file), "utf8"))
        .filter((text) => text.split("\n")[0] === `# message from ${from}`)
        .map((text) => /\n\n([^\n]+)\n/.exec(text.split("- received:")[1] ?? "")?.[1] ?? text);
}

/** Poll `check` until it holds: the listeners are separate processes, so there is no in-process event to await. */
async function until(check: () => boolean, ms = 20_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("timed out waiting");
        await Bun.sleep(100);
    }
}

/** `box`'s config/peers.json record of `name`'s `inbound` flag (undefined: it takes inbound connections). */
function inboundOf(box: PeerBox, name: string): boolean | undefined {
    const file = JSON.parse(readFileSync(join(box.box.root, "config", "peers.json"), "utf8")) as {
        peers: Array<{ name: string; inbound?: boolean }>;
    };
    return file.peers.find((peer) => peer.name === name)?.inbound;
}

/** Change `box`'s config/machine.json, keeping the rest of the file. */
function editMachine(box: PeerBox, change: (machine: Record<string, unknown>) => void): void {
    const file = join(box.box.root, "config", "machine.json");
    const machine = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    change(machine);
    writeFileSync(file, JSON.stringify(machine));
}

/** Set `box`'s record of `name` to pull-only (`inbound: false`), as a pull from it during a listener restart left it. */
function markPulling(box: PeerBox, name: string): void {
    const file = join(box.box.root, "config", "peers.json");
    const peers = JSON.parse(readFileSync(file, "utf8")) as { peers: Array<{ name: string; inbound?: boolean }> };
    for (const peer of peers.peers) if (peer.name === name) peer.inbound = false;
    writeFileSync(file, JSON.stringify(peers));
}

function peerLogOf(box: PeerBox): string {
    const file = join(box.box.root, "logs", "peer.log");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
}

describe("a peer's pull-only flag (T2246)", () => {
    test("an announce clears a stale pull-only flag left by a listener restart", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        const betaPort = freePort();
        const alphaListening = await start(alpha);
        link(alpha, beta, { bAddr: `127.0.0.1:${betaPort}`, aAddr: `127.0.0.1:${alphaListening.port}` });
        markPulling(alpha, "beta");
        await start(beta, { TOLI_PEER_PORT: String(betaPort) });
        await until(() => peerLogOf(alpha).includes("beta announced"));
        expect(inboundOf(alpha, "beta")).toBeUndefined();
        expect(alpha.box.ok(["talk", "beta", "pushed again"])).not.toContain("queued");
        expect(talks(beta, "alpha")).toEqual(["pushed again"]);
    });

    test("a pull while the listener is off, not configured off, does not mark the machine pull-only", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        const alphaListening = await start(alpha);
        link(alpha, beta, { aAddr: `127.0.0.1:${alphaListening.port}` });
        editMachine(beta, (machine) => {
            machine.peer = { ...(machine.peer as Record<string, unknown> | undefined), listen: false };
        });
        expect(beta.box.ok(["peer", "pull"])).toBe("alpha: 0 applied");
        expect(inboundOf(alpha, "beta")).toBeUndefined();
    });

    test("a machine configured pull-only stays pull-only, through its pulls and its announces", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        const betaPort = freePort();
        const alphaListening = await start(alpha);
        link(alpha, beta, { bAddr: `127.0.0.1:${betaPort}`, aAddr: `127.0.0.1:${alphaListening.port}` });
        editMachine(beta, (machine) => {
            machine.inbound = false;
        });
        expect(beta.box.ok(["peer", "pull"])).toBe("alpha: 0 applied");
        expect(inboundOf(alpha, "beta")).toBe(false);
        await start(beta, { TOLI_PEER_PORT: String(betaPort) });
        await until(() => peerLogOf(alpha).includes("beta announced"));
        expect(inboundOf(alpha, "beta")).toBe(false);
        expect(alpha.box.ok(["talk", "beta", "held for its pull"])).toContain("queued for beta, which pulls");
    });

    test("doctor warns about a peer marked pull-only that has not pulled here for 10 minutes", () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        link(alpha, beta, { bAddr: `127.0.0.1:${freePort()}` });
        markPulling(alpha, "beta");
        expect(alpha.box.toli(["doctor"]).stdout).toContain(
            "warn peer-pull-only marked pull-only (a send to it only queues for its pull) but not pulling here: beta (never pulled here)",
        );
        const pullers = join(alpha.box.root, "state", "pullers.json");
        writeFileSync(pullers, JSON.stringify({ beta: Date.now() - 11 * 60_000 }));
        expect(alpha.box.toli(["doctor"]).stdout).toContain("beta (last pull 11 min ago)");
        writeFileSync(pullers, JSON.stringify({ beta: Date.now() }));
        expect(alpha.box.toli(["doctor"]).stdout).not.toContain("peer-pull-only");
    });
});
