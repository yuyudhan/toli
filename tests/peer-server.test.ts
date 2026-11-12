// The HTTPS listener (docs/peers.md "The listener"): a real `bin/toli peer serve` bound to 127.0.0.1 through the
// TOLI_PEER_BIND override, reached with its certificate pinned.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import { bindAddresses, isPrivateAddress, privateAddresses } from "../src/peer/bind.ts";
import { envelope, type PeerBox, peerBox, pin, sender } from "./peer-fixture.ts";
import { type Listening, serve } from "./peer-serve-fixture.ts";

const running: Listening[] = [];

afterEach(async () => {
    for (const listener of running.splice(0)) await listener.stop();
});

async function listen(recv: PeerBox, env: Record<string, string> = {}): Promise<Listening> {
    const listener = await serve(recv, env);
    running.push(listener);
    return listener;
}

describe("the listener", () => {
    test("hello exposes only the name, version, keys and fingerprints", async () => {
        const recv = peerBox("recv");
        const listener = await listen(recv);
        const hello = (await (await listener.fetch("/v1/hello")).json()) as Record<string, unknown>;
        expect(Object.keys(hello).sort()).toEqual([
            "certFingerprint",
            "certSig",
            "fingerprint",
            "key",
            "name",
            "version",
        ]);
        expect(hello.name).toBe("recv");
        expect(hello.fingerprint).toBe(recv.fingerprint);
    });

    test("an unsigned or unknown POST gets 401 and applies nothing", async () => {
        const recv = peerBox("recv");
        const listener = await listen(recv);
        const unsigned = { ...envelope(sender(), "x", recv.fingerprint), sig: "" };
        const response = await listener.post("/v1/messages", { envelopes: [unsigned] });
        expect(response.status).toBe(401);
        expect((await listener.post("/v1/messages", "not json")).status).toBe(400);
        expect(existsSync(join(recv.box.root, "data", "inbox"))).toBe(false);
    });

    test("an oversized request gets 413", async () => {
        const recv = peerBox("recv");
        const listener = await listen(recv);
        const response = await listener.post("/v1/messages", { envelopes: [], pad: "x".repeat(600 * 1024) });
        expect(response.status).toBe(413);
    });

    test("a flood past the per-peer rate gets 429 with the rest deferred, nothing lost", async () => {
        const recv = peerBox("recv");
        const alice = sender();
        pin(recv.box, [{ name: "alice", identity: alice }]);
        const listener = await listen(recv, { TOLI_PEER_RATE_PER_MIN: "3" });
        const batch = Array.from({ length: 5 }, () => envelope(alice, "alice", recv.fingerprint));
        const response = await listener.post("/v1/messages", { envelopes: batch });
        expect(response.status).toBe(429);
        const { receipts } = (await response.json()) as { receipts: Array<{ status: string }> };
        expect(receipts.map((receipt) => receipt.status)).toEqual(["applied", "applied", "applied", "deferred"]);
    });

    test("a signed batch from a paired peer is applied in order with receipts", async () => {
        const recv = peerBox("recv");
        const alice = sender();
        pin(recv.box, [{ name: "alice", identity: alice }]);
        const listener = await listen(recv);
        const batch = [1, 2, 3].map((n) =>
            envelope(alice, "alice", recv.fingerprint, { title: `n${n}`, body: `b${n}` }),
        );
        const response = await listener.post("/v1/messages", { envelopes: batch });
        expect(response.status).toBe(200);
        const { receipts } = (await response.json()) as { receipts: Array<{ id: string; status: string }> };
        expect(receipts.map((receipt) => receipt.status)).toEqual(["applied", "applied", "applied"]);
        expect(receipts.map((receipt) => receipt.id)).toEqual(batch.map((entry) => entry.id));
    });

    test("listen off stops a running listener", async () => {
        const recv = peerBox("recv");
        const listener = await listen(recv);
        recv.box.ok(["peer", "listen", "off"]);
        await listener.exited;
        expect(existsSync(join(recv.box.root, "state", "peer", "listener.json"))).toBe(false);
    });
});

describe("the bind", () => {
    test("only private ranges: never public, wildcard, loopback or link-local", () => {
        for (const ip of [
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.1",
            "192.168.1.9",
            "100.64.0.1",
            "100.127.9.9",
            "fd12::1",
        ])
            expect(isPrivateAddress(ip)).toBe(true);
        for (const ip of [
            "8.8.8.8",
            "0.0.0.0",
            "::",
            "127.0.0.1",
            "::1",
            "169.254.1.1",
            "172.32.0.1",
            "100.128.0.1",
            "fe80::1",
            "2001:db8::1",
        ])
            expect(isPrivateAddress(ip)).toBe(false);
        const entry = (address: string, internal = false): NetworkInterfaceInfo =>
            address.includes(":")
                ? { address, internal, netmask: "", family: "IPv6", mac: "", cidr: null, scopeid: 0 }
                : { address, internal, netmask: "", family: "IPv4", mac: "", cidr: null };
        const interfaces = {
            lo0: [entry("127.0.0.1", true)],
            en0: [entry("203.0.113.5"), entry("192.168.1.20"), entry("fe80::1")],
            wt0: [entry("100.90.1.7"), entry("fd00::7")],
        };
        expect(privateAddresses(interfaces)).toEqual(["100.90.1.7", "192.168.1.20", "fd00::7"]);
    });

    test("an explicit bind list is used as given and must be IP addresses", () => {
        expect(bindAddresses(["0.0.0.0"])).toEqual(["0.0.0.0"]);
        expect(() => bindAddresses(["example.com"])).toThrow('peer.bind: "example.com" is not an IP address');
    });
});
