// The minute tick retries what waits for a paired peer that only pulls (docs/peers.md "Delivery", T136): alpha's
// outbox holds items for beta, which alpha records as taking no inbound connection, yet beta's listener answers on
// 127.0.0.1. The tick sends them through `peer flush` without anyone running it, backs off a beta that does not
// answer, posts the waiting alert only once its own retries failed, and never delivers an item twice.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReachState } from "../src/jobs/reach.ts";
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

/** alpha reaches beta at `addr` but records it as a peer that only pulls, as beta's `--inbound off` pull leaves it. */
function pullPeer(alpha: PeerBox, beta: PeerBox, addr: string): void {
    pin(alpha.box, [{ name: beta.name, identity: beta, cert: beta.cert, addrs: [addr] }]);
    pin(beta.box, [{ name: alpha.name, identity: alpha, cert: alpha.cert }]);
    const file = join(alpha.box.root, "config", "peers.json");
    const peers = JSON.parse(readFileSync(file, "utf8")) as { peers: Array<Record<string, unknown>> };
    for (const peer of peers.peers) peer.inbound = false;
    writeFileSync(file, JSON.stringify(peers, null, 4));
}

type Item = { title: string; body: string };

function inboxOf(box: PeerBox): Item[] {
    const dir = join(box.box.root, "data", "inbox");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .sort()
        .map((file) => {
            const text = readFileSync(join(dir, file), "utf8");
            return { title: text.split("\n")[0]?.replace(/^# /, "") ?? "", body: text };
        });
}

function talks(box: PeerBox, from: string): string[] {
    return inboxOf(box)
        .filter((item) => item.title === `message from ${from}`)
        .map((item) => /\n\n([^\n]+)\n/.exec(item.body.split("- received:")[1] ?? "")?.[1] ?? item.body);
}

function outboxFiles(box: PeerBox): string[] {
    const dir = join(box.box.root, "state", "outbox");
    return existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".json")) : [];
}

function reach(box: PeerBox): ReachState {
    const file = join(box.box.root, "state", "reach.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ReachState) : {};
}

/** The HTTPS delivery attempts alpha recorded, as `<id> <outcome>`. */
function attempts(box: PeerBox): string[] {
    const file = join(box.box.root, "state", "peer", "stats.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id: string; outcome: string })
        .map(({ id, outcome }) => `${id} ${outcome}`);
}

function waitingAlerts(box: PeerBox): string[] {
    return inboxOf(box)
        .map((item) => item.title)
        .filter((title) => /^\d+ messages? to \S+ waiting /.test(title));
}

/** Make every queued item look `minutes` old. */
function age(box: PeerBox, minutes: number): void {
    for (const file of outboxFiles(box)) {
        const path = join(box.box.root, "state", "outbox", file);
        const item = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        writeFileSync(path, JSON.stringify({ ...item, queuedAt: Date.now() - minutes * 60_000 }));
    }
}

describe("the minute tick retries a peer that only pulls (T136)", () => {
    test("(a) an item queued for a reachable pull-peer goes out on the next tick, with no flush", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        const listening = await start(beta);
        pullPeer(alpha, beta, `127.0.0.1:${listening.port}`);
        expect(alpha.box.ok(["talk", "beta", "no flush needed"])).toContain(
            "queued for beta, which pulls its messages",
        );
        expect(outboxFiles(alpha)).toHaveLength(1);
        alpha.box.ok(["job", "tick"]);
        expect(talks(beta, "alpha")).toEqual(["no flush needed"]);
        expect(outboxFiles(alpha)).toEqual([]);
        expect(reach(alpha)).toEqual({});
    });

    test("(b) a pull-peer that does not answer is backed off across ticks, not tried every tick", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        const port = freePort();
        pullPeer(alpha, beta, `127.0.0.1:${port}`);
        alpha.box.ok(["talk", "beta", "while away"]);
        const t0 = Date.now();
        const at = (ms: number) => new Date(t0 + ms).toISOString();
        alpha.box.ok(["job", "tick"], { now: at(0) });
        expect(reach(alpha)["peer:beta"]).toMatchObject({ failures: 1, retryAt: t0 + 30_000 });
        alpha.box.ok(["job", "tick"], { now: at(20_000) });
        expect(reach(alpha)["peer:beta"]).toMatchObject({ failures: 1, retryAt: t0 + 30_000 });
        alpha.box.ok(["job", "tick"], { now: at(31_000) });
        expect(reach(alpha)["peer:beta"]).toMatchObject({ failures: 2, retryAt: t0 + 91_000 });
        alpha.box.ok(["job", "tick"], { now: at(90_000) });
        expect(reach(alpha)["peer:beta"]).toMatchObject({ failures: 2, retryAt: t0 + 91_000 });
        expect(talks(beta, "alpha")).toEqual([]);
        expect(outboxFiles(alpha)).toHaveLength(1);
        await start(beta, { TOLI_PEER_PORT: String(port) });
        alpha.box.ok(["job", "tick"], { now: at(91_000) });
        expect(talks(beta, "alpha")).toEqual(["while away"]);
        expect(outboxFiles(alpha)).toEqual([]);
        expect(reach(alpha)).toEqual({});
    }, 60_000);

    test("(c) the waiting alert is held while the tick's retry delivers, and posted once its retries failed", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        const listening = await start(beta);
        pullPeer(alpha, beta, `127.0.0.1:${listening.port}`);
        alpha.box.ok(["talk", "beta", "an hour late"]);
        age(alpha, 90);
        alpha.box.ok(["job", "tick"]);
        expect(talks(beta, "alpha")).toEqual(["an hour late"]);
        expect(waitingAlerts(alpha)).toEqual([]);

        const gamma = peerBox("gamma");
        const delta = peerBox("delta");
        pullPeer(gamma, delta, `127.0.0.1:${freePort()}`);
        gamma.box.ok(["talk", "delta", "nobody home"]);
        age(gamma, 90);
        gamma.box.ok(["job", "tick"]);
        expect(reach(gamma)["peer:delta"]).toMatchObject({ failures: 1 });
        expect(waitingAlerts(gamma)).toEqual(["1 message to delta waiting 2 h"]);
    }, 60_000);

    test("(d) nothing is delivered twice: a lost receipt resends the same id, which the receiver ignores", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        const listening = await start(beta);
        pullPeer(alpha, beta, `127.0.0.1:${listening.port}`);
        alpha.box.ok(["talk", "beta", "exactly once"]);
        const [file] = outboxFiles(alpha);
        const path = join(alpha.box.root, "state", "outbox", file ?? "");
        const kept = readFileSync(path, "utf8");
        alpha.box.ok(["job", "tick"]);
        expect(outboxFiles(alpha)).toEqual([]);
        // The receipt was lost: the item is queued again under its own id, and the next tick sends it again.
        writeFileSync(path, kept);
        alpha.box.ok(["job", "tick"]);
        alpha.box.ok(["job", "tick"]);
        const id = (file ?? "").replace(/\.json$/, "");
        expect(attempts(alpha)).toEqual([`${id} applied`, `${id} duplicate`]);
        expect(talks(beta, "alpha")).toEqual(["exactly once"]);
        expect(outboxFiles(alpha)).toEqual([]);
    }, 60_000);
});
