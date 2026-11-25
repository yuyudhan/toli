// `bin/toli peer introduce` on the introducer (docs/peers.md "Introducing a machine"): one approval fans out an
// introduction to every fleet box and a roster back to the subject, gated on each box's toli version; `--status`
// reads where each one is; `--sync` covers boxes added since; `peer remove --fleet` revokes; and the one-paste
// `peer trust` fallback for a box on an old toli.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, type Identity, verifySignature } from "../src/peer/identity.ts";
import type { Introduction } from "../src/peer/introduce.ts";
import { GRANTS, type Peer } from "../src/peer/store.ts";
import type { Sandbox } from "./helpers.ts";
import { type PeerBox, peerBox, sender } from "./peer-fixture.ts";

type Item = { kind?: string; title: string; body: string; to?: { name: string } };

const BOXES = ["b1", "b2", "b3", "b4"];

/** coord with the boxes and Chirag's Mac pinned: b3 runs a toli from before introductions, b4 is not in the fleet. */
function introducer(): { coord: PeerBox; mac: Identity; boxes: Map<string, Identity> } {
    const coord = peerBox("coord");
    const boxes = new Map(BOXES.map((name) => [name, sender()]));
    const mac = sender();
    const pinOf = (name: string, identity: Identity, extra: Partial<Peer> = {}): Peer => ({
        name,
        key: identity.key,
        fingerprint: identity.fingerprint,
        cert: "",
        certSig: "",
        addrs: [`10.0.0.${BOXES.indexOf(name) + 2}:47123`],
        allow: [...GRANTS],
        pairedAt: new Date().toISOString(),
        pairedBy: "owner",
        status: "active",
        version: name === "b3" ? "0.7.3" : "0.7.4",
        ...extra,
    });
    const peers = [...boxes].map(([name, identity]) => pinOf(name, identity));
    peers.push(pinOf("chirags-mac", mac, { addrs: [], inbound: false, person: "Chirag" }));
    writeFileSync(join(coord.box.root, "config", "peers.json"), JSON.stringify({ peers }, null, 4));
    const fleet = ["coord", "b1", "b2", "b3"].map((name) => ({ name, ssh: name, root: "/srv/toli" }));
    writeFileSync(join(coord.box.root, "config", "fleet.json"), JSON.stringify({ machines: fleet }, null, 4));
    return { coord, mac, boxes };
}

function outbox(box: Sandbox): Array<{ id: string; item: Item }> {
    const dir = join(box.root, "state", "outbox");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((file) => file.endsWith(".json"))
        .map((file) => {
            const item: Item = JSON.parse(readFileSync(join(dir, file), "utf8"));
            return { id: file.replace(/\.json$/, ""), item };
        });
}

function certificates(box: Sandbox, to: string): Introduction[] {
    return outbox(box)
        .filter(({ item }) => item.kind === "introduction" && item.to?.name === to)
        .map(({ item }) => {
            const cert: Introduction = JSON.parse(item.body);
            return cert;
        });
}

describe("peer introduce --fleet", () => {
    test("queues one introduction per fleet box and a roster to the subject; an old toli needs an upgrade", () => {
        const { coord, mac, boxes } = introducer();
        const printed = coord.box.ok(["peer", "introduce", "chirags-mac", "--fleet", "--why", "Chirag joins"]);
        expect(printed).toContain("b3: needs upgrade");
        for (const name of ["b1", "b2"]) {
            const [cert] = certificates(coord.box, name);
            expect(cert?.subject.fingerprint).toBe(mac.fingerprint);
            expect(cert?.audience).toBe(boxes.get(name)?.fingerprint ?? "");
            expect(cert?.grants).toEqual(["talk", "share", "answer", "status"]);
            expect(cert?.approval.why).toBe("Chirag joins");
            if (cert === undefined) throw new Error(`no certificate for ${name}`);
            const { sig, ...unsigned } = cert;
            expect(verifySignature(coord.key, canonicalJson(unsigned), sig)).toBe(true);
        }
        expect(certificates(coord.box, "b3")).toHaveLength(0);
        expect(certificates(coord.box, "b4")).toHaveLength(0);
        const roster = certificates(coord.box, "chirags-mac");
        expect(roster.map((cert) => cert.subject.name).sort()).toEqual(["b1", "b2"]);
        expect(roster.every((cert) => cert.audience === mac.fingerprint)).toBe(true);
    });

    test("--to names the boxes; --grants widens what the subject gets", () => {
        const { coord } = introducer();
        coord.box.ok(["peer", "introduce", "chirags-mac", "--to", "b4", "--grants", "talk,delegate"]);
        expect(certificates(coord.box, "b4")[0]?.grants).toEqual(["talk", "delegate"]);
        expect(certificates(coord.box, "b1")).toHaveLength(0);
    });

    test("refuses a subject that is not pinned, and introduce as a grant", () => {
        const { coord } = introducer();
        expect(coord.box.toli(["peer", "introduce", "nobody", "--fleet"]).stderr).toContain('no paired peer "nobody"');
        const widened = coord.box.toli(["peer", "introduce", "chirags-mac", "--fleet", "--grants", "talk,introduce"]);
        expect(widened.code).toBe(1);
        expect(widened.stderr).toContain("--grants takes talk, delegate, share, answer, status");
    });

    test("--status shows each box: pinned once delivered, queued while waiting, refused with the reason", () => {
        const { coord } = introducer();
        coord.box.ok(["peer", "introduce", "chirags-mac", "--fleet"]);
        const dir = join(coord.box.root, "state", "outbox");
        const [b1] = outbox(coord.box).filter(({ item }) => item.to?.name === "b1");
        const [b2] = outbox(coord.box).filter(({ item }) => item.to?.name === "b2");
        // b1 applied it (the item is gone); b2 refused it (moved to cancelled/ with the reason).
        renameSync(join(dir, `${b1?.id}.json`), join(dir, "..", "gone.json"));
        mkdirSync(join(dir, "cancelled"), { recursive: true });
        writeFileSync(
            join(dir, "cancelled", `${b2?.id}.json`),
            JSON.stringify({ ...b2?.item, reason: "chirags-mac is pinned here with another key; that one stays" }),
        );
        renameSync(join(dir, `${b2?.id}.json`), join(dir, "..", "gone2.json"));
        const status = coord.box.ok(["peer", "introduce", "--status", "chirags-mac"]);
        expect(status).toContain("b1\tpinned");
        expect(status).toContain("b2\trefused: chirags-mac is pinned here with another key; that one stays");
        expect(status).toContain("b3\tneeds upgrade");
    });

    test("--sync introduces the subject to a box that joined the fleet since", () => {
        const { coord } = introducer();
        coord.box.ok(["peer", "introduce", "chirags-mac", "--fleet"]);
        const fleetFile = join(coord.box.root, "config", "fleet.json");
        const fleet: { machines: unknown[] } = JSON.parse(readFileSync(fleetFile, "utf8"));
        fleet.machines.push({ name: "b4", ssh: "b4", root: "/srv/toli" });
        writeFileSync(fleetFile, JSON.stringify(fleet));
        expect(coord.box.ok(["peer", "introduce", "--sync"])).toContain("chirags-mac: introduced to b4");
        expect(certificates(coord.box, "b4")).toHaveLength(1);
        expect(certificates(coord.box, "chirags-mac").map((cert) => cert.subject.name)).toContain("b4");
        // Nothing new the second time.
        expect(coord.box.ok(["peer", "introduce", "--sync"])).toContain("nothing to send");
    });

    test("peer remove --fleet revokes the subject here and on every box it was introduced to", () => {
        const { coord, mac } = introducer();
        coord.box.ok(["peer", "introduce", "chirags-mac", "--fleet"]);
        coord.box.ok(["peer", "remove", "chirags-mac", "--fleet", "--why", "Chirag left"]);
        const revokes = ["b1", "b2"].flatMap((name) => certificates(coord.box, name)).filter((c) => c.op === "revoke");
        expect(revokes).toHaveLength(2);
        expect(revokes.every((cert) => cert.subject.fingerprint === mac.fingerprint)).toBe(true);
        const peers: { peers: Peer[] } = JSON.parse(readFileSync(join(coord.box.root, "config", "peers.json"), "utf8"));
        expect(peers.peers.find((peer) => peer.name === "chirags-mac")?.status).toBe("revoked");
    });

    test("--emit-trust-script prints the peer trust lines for both directions", () => {
        const { coord, mac, boxes } = introducer();
        const script = coord.box.ok(["peer", "introduce", "--emit-trust-script", "chirags-mac"]);
        expect(script).toContain(`bin/toli peer trust chirags-mac --key ${mac.key} --via coord`);
        expect(script).toContain(`bin/toli peer trust b3 --key ${boxes.get("b3")?.key} --via coord`);
    });
});

describe("peer list and remove --introduced-by", () => {
    test("list and drop the pins one introducer made", () => {
        const { coord, boxes } = introducer();
        const file = join(coord.box.root, "config", "peers.json");
        const peers: { peers: Peer[] } = JSON.parse(readFileSync(file, "utf8"));
        for (const peer of peers.peers)
            if (peer.name === "b2" || peer.name === "b4") peer.introducedBy = boxes.get("b1")?.fingerprint ?? "";
        writeFileSync(file, JSON.stringify(peers));
        const listed = coord.box.ok(["peer", "list", "--introduced-by", "b1"]);
        expect(listed.split("\n").map((line) => line.split("\t")[0])).toEqual(["b2", "b4"]);
        expect(coord.box.ok(["peer", "remove", "--introduced-by", "b1", "--why", "b1 retired"])).toContain(
            "removed b2, b4",
        );
        const after: { peers: Peer[] } = JSON.parse(readFileSync(file, "utf8"));
        expect(after.peers.filter((peer) => peer.status === "revoked").map((peer) => peer.name)).toEqual(["b2", "b4"]);
    });
});
