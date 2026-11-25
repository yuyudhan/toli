// Pairing on the office network (docs/peers.md "Talking on the office network"): two tolis that reach each other
// over an open network (`peer.openNetworks`, NetBird's 100.64.0.0/10 by default) pair on first contact, with no code
// and no human step, and pin each other's key. A different key under a name already pinned is refused and raised to
// the lead (it is what stops someone passing for another machine); a removed peer stays removed; a host outside the
// open networks still goes through the code. `peer add <coordinator> --fleet` also pins every fleet box from the
// coordinator's signed roster and pairs with each box it reaches.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PERMISSIONS, type Peer } from "../src/peer/store.ts";
import { type PeerBox, peerBox, pin, sender } from "./peer-fixture.ts";
import { type Listening, serve } from "./peer-serve-fixture.ts";

const running: Listening[] = [];
afterEach(async () => {
    for (const listening of running.splice(0)) await listening.stop();
});

/** Every test machine talks over 127.0.0.1, so the loopback range stands for the office network. */
function openLoopback(...boxes: PeerBox[]): void {
    for (const box of boxes) box.box.ok(["peer", "set", "--open-networks", "127.0.0.0/8"]);
}

async function listen(box: PeerBox): Promise<string> {
    const listening = await serve(box);
    running.push(listening);
    return `127.0.0.1:${listening.port}`;
}

function peersOf(box: PeerBox): Peer[] {
    const path = join(box.box.root, "config", "peers.json");
    if (!existsSync(path)) return [];
    return (JSON.parse(readFileSync(path, "utf8")) as { peers: Peer[] }).peers;
}

function inboxText(box: PeerBox): string {
    const dir = join(box.box.root, "data", "inbox");
    if (!existsSync(dir)) return "";
    return readdirSync(dir)
        .map((file) => readFileSync(join(dir, file), "utf8"))
        .join("\n");
}

describe("pairing on an open network", () => {
    test("one peer add pins both ways with no code and every permission", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        openLoopback(alpha, beta);
        const target = await listen(beta);
        const out = alpha.box.ok(["peer", "add", target]);
        expect(out).toContain("paired with beta");
        expect(out).not.toContain("peer accept");
        const onAlpha = peersOf(alpha).find((peer) => peer.name === "beta");
        expect(onAlpha?.status).toBe("active");
        expect(onAlpha?.key).toBe(beta.key);
        expect(onAlpha?.allow).toEqual([...PERMISSIONS]);
        const onBeta = peersOf(beta).find((peer) => peer.name === "alpha");
        expect(onBeta?.status).toBe("active");
        expect(onBeta?.key).toBe(alpha.key);
        expect(onBeta?.allow).toEqual([...PERMISSIONS]);
        expect(inboxText(beta)).toContain("alpha paired with this machine on first contact");
        // Talking works at once, both ways.
        alpha.box.ok(["talk", "beta", "hello from alpha"]);
        expect(inboxText(beta)).toContain("hello from alpha");
    });

    test("adding again a peer already paired with the same key changes nothing", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        openLoopback(alpha, beta);
        const target = await listen(beta);
        alpha.box.ok(["peer", "add", target]);
        beta.box.ok(["peer", "deny", "alpha", "delegate", "--why", "test"]);
        expect(alpha.box.ok(["peer", "add", target])).toContain("already paired with beta");
        expect(peersOf(beta).find((peer) => peer.name === "alpha")?.allow).not.toContain("delegate");
    });

    test("another key under a name the host has pinned is refused and raised to its lead", async () => {
        const impostor = peerBox("alpha");
        const beta = peerBox("beta");
        const real = sender();
        openLoopback(impostor, beta);
        pin(beta.box, [{ name: "alpha", identity: real }]);
        const target = await listen(beta);
        const refused = impostor.box.toli(["peer", "add", target]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("beta has another key pinned for alpha");
        const pinned = peersOf(beta).filter((peer) => peer.name === "alpha");
        expect(pinned.map((peer) => peer.key)).toEqual([real.key]);
        expect(inboxText(beta)).toContain("someone may be passing for alpha");
        expect(peersOf(impostor).some((peer) => peer.name === "beta")).toBe(false);
    });

    test("a key already pinned under another name is refused", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        openLoopback(alpha, beta);
        pin(beta.box, [{ name: "gamma", identity: alpha }]);
        const target = await listen(beta);
        const refused = alpha.box.toli(["peer", "add", target]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("pinned here as gamma");
        expect(peersOf(beta).map((peer) => peer.name)).toEqual(["gamma"]);
    });

    test("a host whose key differs from the one pinned for its name is refused before anything is sent", async () => {
        const alpha = peerBox("alpha");
        const impostor = peerBox("beta");
        openLoopback(alpha, impostor);
        const real = sender();
        pin(alpha.box, [{ name: "beta", identity: real }]);
        const target = await listen(impostor);
        const refused = alpha.box.toli(["peer", "add", target]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("beta's key is not the one pinned here");
        expect(peersOf(alpha).find((peer) => peer.name === "beta")?.key).toBe(real.key);
        expect(inboxText(alpha)).toContain("someone may be passing for beta");
        expect(peersOf(impostor)).toEqual([]);
    });

    test("a removed peer cannot pair itself back", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        openLoopback(alpha, beta);
        const target = await listen(beta);
        alpha.box.ok(["peer", "add", target]);
        beta.box.ok(["peer", "remove", "alpha", "--why", "test"]);
        const refused = alpha.box.toli(["peer", "add", target]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("alpha was removed on beta");
        expect(peersOf(beta).find((peer) => peer.name === "alpha")?.status).toBe("revoked");
    });

    test("outside the open networks the host still asks for a code", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        const target = await listen(beta);
        const out = alpha.box.ok(["peer", "add", target]);
        expect(out).toContain("asked beta to pair");
        expect(out).toContain("peer accept");
        expect(peersOf(beta)).toEqual([]);
        expect(peersOf(alpha)).toEqual([]);
    });

    test("the open networks are configurable, and none turns pairing on first contact off", () => {
        const box = peerBox("box");
        expect(box.box.ok(["peer", "set", "--open-networks", "10.0.0.0/8,100.64.0.0/10"])).toContain(
            "open networks 10.0.0.0/8, 100.64.0.0/10",
        );
        expect(box.box.ok(["peer", "set", "--open-networks", "none"])).toContain("open networks none");
        const bad = box.box.toli(["peer", "set", "--open-networks", "10.0.0.0/33"]);
        expect(bad.code).toBe(1);
        expect(bad.stderr).toContain("not an IPv4 CIDR");
    });
});

describe("peer add <coordinator> --fleet", () => {
    test("pins every fleet box from the coordinator's signed roster and pairs with each one it reaches", async () => {
        const coord = peerBox("coord");
        const mac = peerBox("mac");
        const b1 = peerBox("b1");
        const b2 = peerBox("b2");
        openLoopback(coord, mac, b1);
        const coordAddr = await listen(coord);
        const b1Addr = await listen(b1);
        pin(coord.box, [
            { name: "b1", identity: b1, cert: b1.cert, certSig: b1.certSig, addrs: [b1Addr] },
            // b2 runs no listener: the Mac pins it through coord and cannot pair with it directly.
            { name: "b2", identity: b2, cert: b2.cert, certSig: b2.certSig, addrs: ["127.0.0.1:1"] },
        ]);
        pin(b1.box, [{ name: "coord", identity: coord, cert: coord.cert, certSig: coord.certSig, addrs: [coordAddr] }]);
        const machines = ["coord", "b1", "b2"].map((name) => ({ name, ssh: name, root: "/t" }));
        writeFileSync(join(coord.box.root, "config", "fleet.json"), JSON.stringify({ machines }));
        const out = mac.box.ok(["peer", "add", coordAddr, "--fleet"]);
        expect(out).toContain("paired with coord");
        expect(out).toMatch(/^b1: paired both ways$/m);
        expect(out).toMatch(/^b2: pinned through coord/m);
        const onMac = new Map(peersOf(mac).map((peer) => [peer.name, peer]));
        expect(onMac.get("b1")?.key).toBe(b1.key);
        expect(onMac.get("b2")?.key).toBe(b2.key);
        expect(onMac.get("b2")?.via).toBe("coord");
        expect(onMac.get("coord")?.allow).toContain("introduce");
        expect(peersOf(b1).find((peer) => peer.name === "mac")?.key).toBe(mac.key);
    });

    test("a box paired directly is the Mac's own pin; one pinned through the coordinator is renewed by it", async () => {
        const coord = peerBox("coord");
        const mac = peerBox("mac");
        const b1 = peerBox("b1");
        const b2 = peerBox("b2");
        openLoopback(coord, mac, b1);
        const coordAddr = await listen(coord);
        const b1Addr = await listen(b1);
        pin(coord.box, [
            { name: "b1", identity: b1, cert: b1.cert, certSig: b1.certSig, addrs: [b1Addr] },
            { name: "b2", identity: b2, cert: b2.cert, certSig: b2.certSig, addrs: ["127.0.0.1:1"] },
        ]);
        pin(b1.box, [{ name: "coord", identity: coord, cert: coord.cert, certSig: coord.certSig, addrs: [coordAddr] }]);
        const machines = ["coord", "b1", "b2"].map((name) => ({ name, ssh: name, root: "/t" }));
        writeFileSync(join(coord.box.root, "config", "fleet.json"), JSON.stringify({ machines }));
        mac.box.ok(["peer", "add", coordAddr, "--fleet"]);
        const onMac = new Map(peersOf(mac).map((peer) => [peer.name, peer]));
        // Paired both ways on first contact: no expiry, and no introducer can revoke it.
        expect(onMac.get("b1")?.notAfter).toBeUndefined();
        expect(onMac.get("b1")?.introducedBy).toBeUndefined();
        // Pinned only through the coordinator: it expires, so the coordinator keeps it on its books and renews it.
        expect(onMac.get("b2")?.introducedBy).toBe(coord.fingerprint);
        expect(coord.box.ok(["peer", "introduce", "--status", "mac"])).toMatch(/^b2\t/m);
        const ledgerFile = join(coord.box.root, "state", "peer", "introduced.json");
        const ledger = JSON.parse(readFileSync(ledgerFile, "utf8")) as Record<string, { notAfter: string }>;
        const entry = ledger.mac;
        if (entry === undefined) throw new Error("mac is not in the coordinator's ledger");
        entry.notAfter = new Date(Date.now() + 10 * 24 * 60 * 60_000).toISOString();
        writeFileSync(ledgerFile, JSON.stringify(ledger));
        expect(coord.box.ok(["peer", "introduce", "--sync"])).toMatch(/^mac: renewed on b2/m);
        expect(inboxText(mac)).toContain("pinned through coord");
    });

    test("a roster entry that conflicts with a pin already here is refused, the rest applied", async () => {
        const coord = peerBox("coord");
        const mac = peerBox("mac");
        const b1 = peerBox("b1");
        const b2 = peerBox("b2");
        openLoopback(coord, mac);
        const coordAddr = await listen(coord);
        pin(coord.box, [
            { name: "b1", identity: b1, cert: b1.cert, certSig: b1.certSig, addrs: ["127.0.0.1:1"] },
            { name: "b2", identity: b2, cert: b2.cert, certSig: b2.certSig, addrs: ["127.0.0.1:1"] },
        ]);
        const known = sender();
        pin(mac.box, [{ name: "b1", identity: known }]);
        const machines = ["coord", "b1", "b2"].map((name) => ({ name, ssh: name, root: "/t" }));
        writeFileSync(join(coord.box.root, "config", "fleet.json"), JSON.stringify({ machines }));
        const out = mac.box.ok(["peer", "add", coordAddr, "--fleet"]);
        expect(out).toMatch(/^b1: refused: .*another key/m);
        const onMac = new Map(peersOf(mac).map((peer) => [peer.name, peer]));
        expect(onMac.get("b1")?.key).toBe(known.key);
        expect(onMac.get("b2")?.key).toBe(b2.key);
    });
});

describe("POST /v1/roster introduces no more than the asker may do on the coordinator", () => {
    /** `asker` pinned on coord with `allow` (or revoked) asks for the roster; coord's ledger entry for it, if any. */
    async function askRoster(allow: Peer["allow"], status: Peer["status"] = "active") {
        const coord = peerBox("coord");
        const asker = peerBox("asker");
        const b1 = peerBox("b1");
        openLoopback(coord, asker, b1);
        const coordAddr = await listen(coord);
        pin(coord.box, [
            { name: "asker", identity: asker, cert: asker.cert, certSig: asker.certSig, allow, status },
            { name: "b1", identity: b1, cert: b1.cert, certSig: b1.certSig, addrs: ["127.0.0.1:1"] },
        ]);
        pin(asker.box, [
            { name: "coord", identity: coord, cert: coord.cert, certSig: coord.certSig, addrs: [coordAddr] },
        ]);
        const machines = ["coord", "b1"].map((name) => ({ name, ssh: name, root: "/t" }));
        writeFileSync(join(coord.box.root, "config", "fleet.json"), JSON.stringify({ machines }));
        const out = asker.box.toli(["peer", "add", coordAddr, "--fleet"]);
        const ledgerFile = join(coord.box.root, "state", "peer", "introduced.json");
        const ledger = existsSync(ledgerFile)
            ? (JSON.parse(readFileSync(ledgerFile, "utf8")) as Record<string, { grants: string[] }>)
            : {};
        return { out, entry: ledger.asker, onAsker: peersOf(asker) };
    }

    test("a talk-only asker is introduced with talk only", async () => {
        const { entry, onAsker } = await askRoster(["talk"]);
        expect(entry?.grants).toEqual(["talk"]);
        expect(onAsker.find((peer) => peer.name === "b1")?.key).toBeDefined();
    });

    test("an office peer with every permission is introduced with all five", async () => {
        const { entry } = await askRoster([...PERMISSIONS]);
        expect(entry?.grants).toEqual([...PERMISSIONS]);
    });

    test("an asker without talk gets the roster only, and is introduced nowhere", async () => {
        const { out, entry, onAsker } = await askRoster(["status"]);
        expect(out.code).toBe(0);
        expect(entry).toBeUndefined();
        expect(onAsker.find((peer) => peer.name === "b1")?.key).toBeDefined();
    });

    test("a revoked asker gets nothing", async () => {
        const { entry, onAsker } = await askRoster([], "revoked");
        expect(entry).toBeUndefined();
        expect(onAsker.find((peer) => peer.name === "b1")).toBeUndefined();
    });
});
