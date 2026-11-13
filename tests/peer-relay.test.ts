// A relay between two peers that both refuse inbound connections, and a peer that only pulls (docs/peers.md "Relay"):
// alpha (a coordinator behind a firewall) and laptop (no inbound at all) each reach hub, whose listener runs on
// 127.0.0.1. alpha's messages reach laptop through hub sealed and signed, from alpha; hub can neither read nor forge
// them, and a changed item is dropped and sent again. A peer that says it takes no inbound connection is never pushed
// to: what waits for it stays queued until it pulls.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, signWith } from "../src/peer/identity.ts";
import { seal } from "../src/peer/seal.ts";
import { type PeerBox, peerBox, pin, sender } from "./peer-fixture.ts";
import { type Listening, serve } from "./peer-serve-fixture.ts";

const running: Listening[] = [];
afterEach(async () => {
    for (const listening of running.splice(0)) await listening.stop();
});

type Inbox = Array<{ title: string; from: string; path: string }>;

function inbox(box: PeerBox): Inbox {
    return JSON.parse(box.box.ok(["inbox", "list", "--json"])) as Inbox;
}

function bodies(box: PeerBox): string {
    return inbox(box)
        .map((item) => readFileSync(item.path, "utf8"))
        .join("\n");
}

function queued(box: PeerBox): string[] {
    const dir = join(box.box.root, "state", "outbox");
    return existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".json")) : [];
}

/** The files hub holds for `recipient`. */
function held(hub: PeerBox, recipient: PeerBox): string[] {
    const dir = join(hub.box.root, "state", "peer", "relay", "held", recipient.fingerprint);
    return existsSync(dir) ? readdirSync(dir).map((file) => join(dir, file)) : [];
}

/** hub listens; alpha and laptop are paired with it (they reach it, it never reaches them) and trust each other. */
async function relayed(): Promise<{ alpha: PeerBox; hub: PeerBox; laptop: PeerBox }> {
    const alpha = peerBox("alpha");
    const hub = peerBox("hub");
    const laptop = peerBox("laptop");
    const listening = await serve(hub);
    running.push(listening);
    const addr = `127.0.0.1:${listening.port}`;
    pin(hub.box, [
        { name: "alpha", identity: alpha, cert: alpha.cert },
        { name: "laptop", identity: laptop, cert: laptop.cert },
    ]);
    for (const box of [alpha, laptop]) pin(box.box, [{ name: "hub", identity: hub, cert: hub.cert, addrs: [addr] }]);
    expect(alpha.box.ok(["peer", "trust", "laptop", "--key", laptop.key, "--via", "hub"])).toContain(
        "its messages go through hub",
    );
    laptop.box.ok(["peer", "trust", "alpha", "--key", alpha.key, "--via", "hub"]);
    return { alpha, hub, laptop };
}

describe("a relay between two peers that both refuse inbound connections (T1331)", () => {
    test("alpha's message reaches laptop through hub, from alpha, unreadable at hub, settled by laptop's receipt", async () => {
        const { alpha, hub, laptop } = await relayed();
        expect(alpha.box.ok(["talk", "laptop", "secret words"])).toContain("through its relay hub");
        expect(queued(alpha)).toHaveLength(1);
        const files = held(hub, laptop);
        expect(files).toHaveLength(1);
        for (const file of files) expect(readFileSync(file, "utf8")).not.toContain("secret words");

        expect(laptop.box.ok(["peer", "pull"])).toBe("hub: 0 applied; through it: 1 applied");
        const arrived = inbox(laptop);
        expect(arrived.map((item) => item.from)).toEqual(["alpha"]);
        expect(bodies(laptop)).toContain("secret words");
        expect(held(hub, laptop)).toEqual([]);

        alpha.box.ok(["peer", "flush", "--all"]);
        expect(queued(alpha)).toEqual([]);
        // Laptop's answer travels back the same way.
        laptop.box.ok(["talk", "alpha", "the reply"]);
        alpha.box.ok(["peer", "pull"]);
        expect(bodies(alpha)).toContain("the reply");
        expect(inbox(alpha).map((item) => item.from)).toContain("laptop");
    });

    test("an item changed at the relay is dropped, then sent again and applied once", async () => {
        const { alpha, hub, laptop } = await relayed();
        alpha.box.ok(["talk", "laptop", "kept intact"]);
        const [file] = held(hub, laptop);
        if (file === undefined) throw new Error("hub holds nothing");
        const item = JSON.parse(readFileSync(file, "utf8")) as { ct: string };
        const ct = Buffer.from(item.ct, "base64");
        ct[0] = (ct[0] ?? 0) ^ 1;
        writeFileSync(file, JSON.stringify({ ...item, ct: ct.toString("base64") }));
        expect(laptop.box.ok(["peer", "pull"])).toContain("1 dropped");
        expect(bodies(laptop)).not.toContain("kept intact");
        expect(held(hub, laptop)).toEqual([]);

        alpha.box.ok(["peer", "flush", "--all"]);
        alpha.box.ok(["peer", "flush", "--all"]);
        expect(laptop.box.ok(["peer", "pull"])).toBe("hub: 0 applied; through it: 1 applied");
        alpha.box.ok(["peer", "flush", "--all"]);
        expect(queued(alpha)).toEqual([]);
        expect(bodies(laptop).match(/kept intact/g)).toHaveLength(1);
    });

    test("the relay cannot forge a message from alpha: a sealed item without alpha's signature is refused", async () => {
        const { alpha, hub, laptop } = await relayed();
        const forger = sender();
        const unsigned = {
            v: 1 as const,
            id: "forged-1",
            seq: 1,
            from: "alpha",
            fromKey: alpha.fingerprint,
            to: laptop.fingerprint,
            kind: "inbox" as const,
            title: "forged",
            body: "forged words",
            queuedAt: Date.now(),
            sentAt: Date.now(),
            nonce: "bm9uY2U=",
        };
        const envelope = { ...unsigned, sig: signWith(forger.privateKey, canonicalJson(unsigned)) };
        const sealed = await seal(
            { from: "alpha", fromKey: alpha.fingerprint, to: laptop.fingerprint, id: "forged-1", seq: 1 },
            laptop.key,
            JSON.stringify(envelope),
        );
        const dir = join(hub.box.root, "state", "peer", "relay", "held", laptop.fingerprint);
        alpha.box.ok(["talk", "laptop", "real words"]);
        writeFileSync(join(dir, `${alpha.fingerprint.slice(0, 16)}-forged-1.json`), JSON.stringify(sealed));
        laptop.box.ok(["peer", "pull"]);
        expect(bodies(laptop)).not.toContain("forged words");
        expect(bodies(laptop)).toContain("real words");
        expect(inbox(laptop).map((item) => item.from)).toEqual(["alpha"]);
    });
});

describe("a peer that takes no inbound connection only pulls (T1331)", () => {
    test("once it pulls with `inbound off`, its peer stops pushing and queues for its pull", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        const listening = await serve(alpha);
        running.push(listening);
        // beta paired with an address that resets every connection, as a firewalled laptop does.
        pin(alpha.box, [{ name: "beta", identity: beta, cert: beta.cert, addrs: ["127.0.0.1:1"] }]);
        pin(beta.box, [{ name: "alpha", identity: alpha, cert: alpha.cert, addrs: [`127.0.0.1:${listening.port}`] }]);
        beta.box.ok(["init", "--name", "beta", "--role", "coordinator", "--inbound", "off"]);
        beta.box.ok(["peer", "pull"]);
        const peers = JSON.parse(alpha.box.ok(["peer", "list", "--json"])) as Array<{
            name: string;
            inbound?: boolean;
        }>;
        expect(peers.find((peer) => peer.name === "beta")?.inbound).toBe(false);

        const sent = alpha.box.ok(["talk", "beta", "pulled later"]);
        expect(sent).toContain("queued for beta, which pulls its messages");
        expect(sent).not.toContain("HTTPS");
        expect(beta.box.ok(["peer", "pull"])).toBe("alpha: 1 applied");
        expect(bodies(beta)).toContain("pulled later");
        expect(queued(alpha)).toEqual([]);
    });

    test("fleet check reports a pull-only machine that answers over HTTPS as not checked, and the rest runs", async () => {
        const alpha = peerBox("alpha");
        const laptop = peerBox("laptop");
        const listening = await serve(laptop);
        running.push(listening);
        // The laptop answers its status over HTTPS, but takes no inbound ssh (as on m5, 2026-11-13 12:30Z).
        pin(alpha.box, [
            { name: "laptop", identity: laptop, cert: laptop.cert, addrs: [`127.0.0.1:${listening.port}`] },
        ]);
        pin(laptop.box, [{ name: "alpha", identity: alpha, cert: alpha.cert }]);
        writeFileSync(
            join(alpha.box.root, "config", "fleet.json"),
            JSON.stringify({
                machines: [
                    { name: "alpha", ssh: "host1", root: alpha.box.root },
                    { name: "laptop", ssh: "host2", root: laptop.box.root, inbound: false },
                ],
            }),
        );
        const result = alpha.box.toli(["fleet", "check", "--json"]);
        expect(result.stderr).not.toContain("takes no inbound ssh");
        expect(result.code).toBe(0);
        const check = JSON.parse(result.stdout) as { unchecked: Array<{ machine: string; reason: string }> };
        expect(check.unchecked).toContainEqual({ machine: "laptop", reason: "pull-only, not checked" });
    });
});
