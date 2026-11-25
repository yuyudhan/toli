// Delivery between introduced peers (docs/peers.md "Introducing a machine", "Relay"): a pin with a relay (`via`, its
// introducer) whose addresses all fail goes through that relay instead of waiting; a relay that holds an item for a
// recipient it can reach nudges it to pull at once; doctor names held items nobody collects, a box with no introducer
// and introduced pins about to expire; and the introducer's tick introduces a subject to a box that joined since.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GRANTS, type Peer } from "../src/peer/store.ts";
import type { Sandbox } from "./helpers.ts";
import { type PeerBox, peerBox, pin, sender } from "./peer-fixture.ts";
import { type Listening, serve, until } from "./peer-serve-fixture.ts";

const running: Listening[] = [];
afterEach(async () => {
    for (const listening of running.splice(0)) await listening.stop();
});

function bodies(box: PeerBox): string {
    const dir = join(box.box.root, "data", "inbox");
    if (!existsSync(dir)) return "";
    return readdirSync(dir)
        .map((file) => readFileSync(join(dir, file), "utf8"))
        .join("\n");
}

function held(hub: PeerBox, recipient: PeerBox): string[] {
    const dir = join(hub.box.root, "state", "peer", "relay", "held", recipient.fingerprint);
    return existsSync(dir) ? readdirSync(dir) : [];
}

/** Add `via` (and anything else) to one pin in `box`'s config/peers.json. */
function amend(box: Sandbox, name: string, change: Partial<Peer>): void {
    const file = join(box.root, "config", "peers.json");
    const peers: { peers: Peer[] } = JSON.parse(readFileSync(file, "utf8"));
    for (const peer of peers.peers) if (peer.name === name) Object.assign(peer, change);
    writeFileSync(file, JSON.stringify(peers, null, 4));
}

describe("an introduced pin's relay", () => {
    test("carries the message when every direct address of the recipient fails", async () => {
        const alpha = peerBox("alpha");
        const hub = peerBox("hub");
        const laptop = peerBox("laptop");
        const listening = await serve(hub);
        running.push(listening);
        const hubAddr = `127.0.0.1:${listening.port}`;
        pin(hub.box, [
            { name: "alpha", identity: alpha, cert: alpha.cert },
            { name: "laptop", identity: laptop, cert: laptop.cert },
        ]);
        // laptop's address answers nobody (a listener behind a firewall): only the relay reaches it.
        pin(alpha.box, [
            { name: "hub", identity: hub, cert: hub.cert, addrs: [hubAddr] },
            { name: "laptop", identity: laptop, cert: laptop.cert, addrs: ["127.0.0.1:1"] },
        ]);
        amend(alpha.box, "laptop", { via: "hub" });
        pin(laptop.box, [
            { name: "hub", identity: hub, cert: hub.cert, addrs: [hubAddr] },
            { name: "alpha", identity: alpha, cert: alpha.cert },
        ]);
        amend(laptop.box, "alpha", { via: "hub" });
        alpha.box.toli(["talk", "laptop", "around the firewall"]);
        expect(held(hub, laptop)).toHaveLength(1);
        expect(laptop.box.ok(["peer", "pull"])).toContain("through it: 1 applied");
        expect(bodies(laptop)).toContain("around the firewall");
    });

    test("a relay that can reach the recipient nudges it to pull at once", async () => {
        const alpha = peerBox("alpha");
        const hub = peerBox("hub");
        const laptop = peerBox("laptop");
        const hubListening = await serve(hub);
        const laptopListening = await serve(laptop);
        running.push(hubListening, laptopListening);
        const hubAddr = `127.0.0.1:${hubListening.port}`;
        pin(hub.box, [
            { name: "alpha", identity: alpha, cert: alpha.cert },
            { name: "laptop", identity: laptop, cert: laptop.cert, addrs: [`127.0.0.1:${laptopListening.port}`] },
        ]);
        pin(alpha.box, [
            { name: "hub", identity: hub, cert: hub.cert, addrs: [hubAddr] },
            { name: "laptop", identity: laptop, cert: laptop.cert },
        ]);
        amend(alpha.box, "laptop", { via: "hub" });
        pin(laptop.box, [
            { name: "hub", identity: hub, cert: hub.cert, addrs: [hubAddr] },
            { name: "alpha", identity: alpha, cert: alpha.cert },
        ]);
        amend(laptop.box, "alpha", { via: "hub" });
        alpha.box.toli(["talk", "laptop", "no tick needed"]);
        await until("laptop to pull after hub's nudge", 30_000, () =>
            bodies(laptop).includes("no tick needed") ? true : null,
        );
        expect(held(hub, laptop)).toEqual([]);
    });
});

describe("doctor", () => {
    test("warns about items a relay has held over 10 minutes for a recipient it reaches", () => {
        const hub = peerBox("hub");
        const laptop = sender();
        pin(hub.box, [{ name: "laptop", identity: laptop, addrs: ["127.0.0.1:1"] }]);
        const dir = join(hub.box.root, "state", "peer", "relay", "held", laptop.fingerprint);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, "0123456789abcdef-item.json");
        writeFileSync(file, "{}");
        const old = new Date(Date.now() - 20 * 60_000);
        utimesSync(file, old, old);
        expect(hub.box.toli(["doctor"]).stdout).toMatch(/warn peer-relay-held .*laptop \(1 item, oldest 20 min\)/);
    });

    test("tells a worker with no introducer how to grant one, and names introduced pins about to expire", () => {
        const box = peerBox("box");
        box.box.ok([
            "init",
            "--name",
            "box",
            "--role",
            "worker",
            "--coordinator-ssh",
            "coord",
            "--coordinator-root",
            "/t",
        ]);
        pin(box.box, [
            { name: "coord", identity: sender() },
            { name: "mac", identity: sender() },
        ]);
        amend(box.box, "mac", { notAfter: new Date(Date.now() + 5 * 24 * 60 * 60_000).toISOString() });
        const doctor = box.box.toli(["doctor"]).stdout;
        expect(doctor).toContain("warn peer-introducer no peer may introduce machines here");
        expect(doctor).toMatch(/warn peer-expiry .*mac \(expires 20\d\d-\d\d-\d\d\)/);
        amend(box.box, "coord", { allow: [...GRANTS] });
        expect(box.box.toli(["doctor"]).stdout).toContain("ok peer-introducer coord introduces machines here");
    });
});

describe("the introducer's tick", () => {
    test("introduces a subject to a box that joined the fleet since", () => {
        const coord = peerBox("coord");
        const mac = sender();
        const b1 = sender();
        const b2 = sender();
        pin(coord.box, [
            { name: "chirags-mac", identity: mac },
            { name: "b1", identity: b1, addrs: ["127.0.0.1:1"] },
            { name: "b2", identity: b2, addrs: ["127.0.0.1:1"] },
        ]);
        const fleetFile = join(coord.box.root, "config", "fleet.json");
        const machines = [
            { name: "coord", ssh: "coord", root: "/t" },
            { name: "b1", ssh: "b1", root: "/t" },
        ];
        writeFileSync(fleetFile, JSON.stringify({ machines }));
        coord.box.ok(["peer", "introduce", "chirags-mac", "--fleet"]);
        writeFileSync(fleetFile, JSON.stringify({ machines: [...machines, { name: "b2", ssh: "b2", root: "/t" }] }));
        // The tick reaches no real host: ssh fails at once and no peer gets anything over it.
        coord.box.stub("ssh", "exit 255");
        coord.box.ok(["peer", "set", "--ssh-fallback", "off"]);
        coord.box.ok(["job", "tick"]);
        expect(coord.box.ok(["peer", "introduce", "--status", "chirags-mac"])).toMatch(/^b2\t/m);
    });
});
