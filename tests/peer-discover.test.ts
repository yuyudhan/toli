// Discovery (docs/peers.md "Finding peers"): candidates from `netbird status --json`, `tailscale status --json` and a
// small subnet, each asked for its hello; the scan prints what answered and never pairs or writes config/peers.json.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { netbirdCandidates, subnetCandidates, tailscaleCandidates } from "../src/peer/discover.ts";
import { peerBox } from "./peer-fixture.ts";
import { type Listening, serve } from "./peer-serve-fixture.ts";

const NETBIRD = {
    peers: {
        total: 2,
        connected: 1,
        details: [
            { fqdn: "alpha-laptop.nb.example", netbirdIp: "100.64.0.191", status: "Connected" },
            { fqdn: "beta-box.nb.example", netbirdIp: "100.64.4.7/16", status: "Idle" },
        ],
    },
    netbirdIp: "100.64.1.1/16",
    fqdn: "self.nb.example",
};

const TAILSCALE = {
    Self: { DNSName: "self.tail1234.ts.net.", TailscaleIPs: ["100.101.1.1", "fd7a:115c:a1e0::1"] },
    Peer: {
        "nodekey:abc": { DNSName: "gamma.tail1234.ts.net.", TailscaleIPs: ["100.101.2.2", "fd7a:115c:a1e0::2"] },
        "nodekey:def": { DNSName: "delta.tail1234.ts.net.", TailscaleIPs: ["100.101.3.3"] },
    },
};

const running: Listening[] = [];
afterEach(async () => {
    for (const listening of running.splice(0)) await listening.stop();
});

describe("peer discovery", () => {
    test("reads NetBird's peers (address without its prefix length, and name), never itself", () => {
        expect(netbirdCandidates(NETBIRD)).toEqual([
            { address: "100.64.0.191", name: "alpha-laptop.nb.example", source: "netbird" },
            { address: "100.64.4.7", name: "beta-box.nb.example", source: "netbird" },
        ]);
        expect(netbirdCandidates({})).toEqual([]);
    });

    test("reads Tailscale's peers (every address, the name without its trailing dot), never itself", () => {
        expect(tailscaleCandidates(TAILSCALE)).toEqual([
            { address: "100.101.2.2", name: "gamma.tail1234.ts.net", source: "tailscale" },
            { address: "fd7a:115c:a1e0::2", name: "gamma.tail1234.ts.net", source: "tailscale" },
            { address: "100.101.3.3", name: "delta.tail1234.ts.net", source: "tailscale" },
        ]);
    });

    test("a subnet is at most a /22 and must be private", () => {
        expect(subnetCandidates("10.1.2.0/30").map((candidate) => candidate.address)).toEqual(["10.1.2.1", "10.1.2.2"]);
        expect(subnetCandidates("192.168.4.0/22")).toHaveLength(1022);
        expect(() => subnetCandidates("10.0.0.0/21")).toThrow("at most a /22");
        expect(() => subnetCandidates("8.8.8.0/24")).toThrow("not a private range");
        expect(() => subnetCandidates("10.0.0.0")).toThrow("CIDR");
    });

    test("scan prints each listener that answers, with its fingerprint, and pairs nothing", async () => {
        const scanner = peerBox("alpha");
        const target = peerBox("beta");
        const listening = await serve(target);
        running.push(listening);
        writeFileSync(
            join(scanner.box.stubs, "netbird"),
            '#!/bin/sh\necho \'{"peers":{"details":[{"fqdn":"beta.nb","netbirdIp":"127.0.0.1"},{"fqdn":"gone.nb","netbirdIp":"127.0.0.2"}]}}\'\n',
            { mode: 0o755 },
        );
        const found = JSON.parse(
            scanner.box.ok(["peer", "scan", "--netbird", "--port", String(listening.port), "--json"]),
        ) as Array<{ address: string; name: string; fingerprint: string; source: string }>;
        expect(found).toEqual([
            expect.objectContaining({
                address: `127.0.0.1:${listening.port}`,
                name: "beta",
                fingerprint: target.fingerprint,
                source: "netbird (beta.nb)",
            }),
        ]);
        expect(existsSync(join(scanner.box.root, "config", "peers.json"))).toBe(false);
    });
});
