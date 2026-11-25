// Introducing machines (docs/peers.md "Introducing a machine"): the `introduce` permission, granted only by hand and
// never by pairing; the cap a machine puts on what an introduced peer may do; and every receiver rule of
// `applyIntroduction` (src/peer/introduce.ts), each accept and each refusal.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, type Identity, signWith } from "../src/peer/identity.ts";
import {
    type Applied,
    applyIntroduction,
    type Introduction,
    introId,
    pinExpiry,
    type Subject,
    signIntroduction,
} from "../src/peer/introduce.ts";
import { newPeer } from "../src/peer/pair.ts";
import { GRANTS, INTRODUCED_GRANTS, INTRODUCER_PERMISSION, PERMISSIONS, type Peer } from "../src/peer/store.ts";
import { inProcess, type Sandbox } from "./helpers.ts";
import { type PeerBox, peerBox, pin, sender } from "./peer-fixture.ts";

/** The sandbox's config/peers.json, as the tests wrote it or toli rewrote it. */
function peersIn(box: Sandbox): Peer[] {
    const file: { peers: Peer[] } = JSON.parse(readFileSync(join(box.root, "config", "peers.json"), "utf8"));
    return file.peers;
}

function changePeer(box: Sandbox, name: string, change: (peer: Peer) => void): void {
    const peers = peersIn(box);
    const peer = peers.find((entry) => entry.name === name);
    if (peer === undefined) throw new Error(`no ${name} in the sandbox`);
    change(peer);
    writeFileSync(join(box.root, "config", "peers.json"), JSON.stringify({ peers }, null, 4));
}

describe("the introduce permission", () => {
    test("is granted and revoked by hand, logged with who and why", () => {
        const recv = peerBox("box");
        pin(recv.box, [{ name: "coord", identity: sender() }]);
        expect(recv.box.ok(["peer", "allow", "coord", "introduce", "--why", "fleet introducer"])).toContain(
            "coord may now: talk, delegate, share, answer, status, introduce",
        );
        expect(peersIn(recv.box)[0]?.allow).toContain(INTRODUCER_PERMISSION);
        const log = readFileSync(join(recv.box.root, "logs", "peer.log"), "utf8");
        expect(log).toContain("allowed coord introduce by the owner: fleet introducer");
        expect(recv.box.ok(["peer", "deny", "coord", "introduce"])).toContain(
            "coord may now: talk, delegate, share, answer, status",
        );
        expect(peersIn(recv.box)[0]?.allow).not.toContain(INTRODUCER_PERMISSION);
    });

    test("pairing grants the five permissions and never introduce", () => {
        expect(PERMISSIONS as readonly string[]).not.toContain(INTRODUCER_PERMISSION);
        const identity = sender();
        const peer = newPeer({ name: "a", key: identity.key, cert: "", certSig: "", addrs: [], version: "1" }, "owner");
        expect(peer.allow).toEqual([...PERMISSIONS]);
    });

    test("a peer that was itself introduced here cannot be made an introducer", () => {
        const recv = peerBox("box");
        pin(recv.box, [{ name: "mac", identity: sender() }]);
        changePeer(recv.box, "mac", (peer) => {
            peer.introducedBy = "f".repeat(64);
        });
        const refused = recv.box.toli(["peer", "allow", "mac", "introduce"]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("an introduced peer cannot introduce");
        expect(peersIn(recv.box)[0]?.allow).not.toContain(INTRODUCER_PERMISSION);
    });

    test("an unknown permission is refused with the list that exists", () => {
        const recv = peerBox("box");
        pin(recv.box, [{ name: "coord", identity: sender() }]);
        const refused = recv.box.toli(["peer", "allow", "coord", "everything"]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("talk, delegate, share, answer, status, introduce");
    });
});

describe("peer.introducerCap", () => {
    test("peer set --introducer-cap keeps what an introduced peer may at most do", () => {
        const recv = peerBox("box");
        expect(recv.box.ok(["peer", "set", "--introducer-cap", "talk,status"])).toContain(
            "introducer cap talk, status",
        );
        const machine = JSON.parse(readFileSync(join(recv.box.root, "config", "machine.json"), "utf8")) as {
            peer?: { introducerCap?: string[] };
        };
        expect(machine.peer?.introducerCap).toEqual(["talk", "status"]);
    });

    test("the cap takes only the five permissions: introduce is never grantable through an introduction", () => {
        const recv = peerBox("box");
        for (const cap of ["talk,introduce", "talk,everything"]) {
            const refused = recv.box.toli(["peer", "set", "--introducer-cap", cap]);
            expect(refused.code).toBe(1);
            expect(refused.stderr).toContain("--introducer-cap takes talk, delegate, share, answer, status");
        }
    });

    test("defaults to the five", () => {
        const recv = peerBox("box");
        expect(recv.box.ok(["peer", "set", "--ssh-fallback", "on"])).toContain(
            "introducer cap talk, delegate, share, answer, status",
        );
    });
});

/** A subject with no certificate (a pin made by `peer trust`), or `box`'s own key and certificate. */
function subjectOf(identity: { key: string; fingerprint: string }, name: string, box?: PeerBox): Subject {
    return {
        name,
        key: identity.key,
        fingerprint: identity.fingerprint,
        cert: box?.cert ?? "",
        certSig: box?.certSig ?? "",
        addrs: [],
    };
}

type Fields = Partial<Omit<Introduction, "v" | "introducer" | "sig">>;

function certificate(introducer: Identity, audience: string, subject: Subject, fields: Fields = {}): Introduction {
    return signIntroduction(introducer, {
        id: introId(),
        op: "introduce",
        audience,
        subject,
        grants: [...INTRODUCED_GRANTS],
        notAfter: pinExpiry(),
        replaces: null,
        approval: { by: "owner", why: "Chirag joins", at: new Date().toISOString() },
        ...fields,
    });
}

/** applyIntroduction in `box`'s checkout, in this process. */
function apply(box: Sandbox, cert: unknown, from = "coord"): Applied {
    let applied: Applied | undefined;
    inProcess(box.root, () => {
        applied = applyIntroduction(cert, from);
    });
    if (applied === undefined) throw new Error("applyIntroduction returned nothing");
    return applied;
}

/** A box that pins `coord` (allowed to introduce) and the coord identity that signs. */
function fleetBox(): { recv: PeerBox; coord: Identity } {
    const recv = peerBox("box");
    const coord = sender();
    pin(recv.box, [{ name: "coord", identity: coord, allow: [...GRANTS], addrs: ["127.0.0.1:1"] }]);
    return { recv, coord };
}

/** Add one pin beside the ones the box has, as `peer trust` or a pairing would have written it. */
function addPin(box: Sandbox, peer: Partial<Peer> & { name: string; key: string; fingerprint: string }): void {
    const peers = peersIn(box);
    peers.push({
        cert: "",
        certSig: "",
        addrs: [],
        allow: [...PERMISSIONS],
        pairedAt: new Date().toISOString(),
        pairedBy: "owner",
        status: "active",
        ...peer,
    });
    writeFileSync(join(box.root, "config", "peers.json"), JSON.stringify({ peers }));
}

const peerNamed = (box: Sandbox, name: string) => peersIn(box).find((entry) => entry.name === name);
const peersFile = (box: Sandbox) => readFileSync(join(box.root, "config", "peers.json"), "utf8");

describe("applyIntroduction accepts", () => {
    test("a valid introduction pins the subject with capped grants, relayed through its introducer", () => {
        const { recv, coord } = fleetBox();
        const cert = certificate(coord, recv.fingerprint, subjectOf(sender(), "chirags-mac"), {
            grants: [...PERMISSIONS],
        });
        const machine = join(recv.box.root, "config", "machine.json");
        const settings: Record<string, unknown> = JSON.parse(readFileSync(machine, "utf8"));
        writeFileSync(machine, JSON.stringify({ ...settings, peer: { introducerCap: ["talk", "share", "status"] } }));
        expect(apply(recv.box, cert).status).toBe("pinned");
        const pinned = peerNamed(recv.box, "chirags-mac");
        expect(pinned?.allow).toEqual(["talk", "share", "status"]);
        expect(pinned?.via).toBe("coord");
        expect(pinned?.introducedBy).toBe(coord.fingerprint);
        expect(pinned?.introId).toBe(cert.id);
        expect(pinned?.pairedBy).toBe("introduced");
        expect(pinned?.notAfter).toBe(cert.notAfter ?? "");
        expect(readFileSync(join(recv.box.root, "logs", "peer.log"), "utf8")).toContain(
            `introduction ${cert.id} from coord: pinned chirags-mac`,
        );
    });

    test("a subject with no TLS certificate is pinned relay-only: no addresses, so never reached directly", () => {
        const { recv, coord } = fleetBox();
        const subject = { ...subjectOf(sender(), "mac"), addrs: ["127.0.0.1:47123"] };
        expect(apply(recv.box, certificate(coord, recv.fingerprint, subject)).status).toBe("pinned");
        const pinned = peerNamed(recv.box, "mac");
        expect(pinned?.cert).toBe("");
        expect(pinned?.addrs).toEqual([]);
        expect(pinned?.via).toBe("coord");
    });

    test("by default an introduced peer gets everything but delegate", () => {
        const { recv, coord } = fleetBox();
        apply(recv.box, certificate(coord, recv.fingerprint, subjectOf(sender(), "mac")));
        expect(peerNamed(recv.box, "mac")?.allow).toEqual(["talk", "share", "answer", "status"]);
    });

    test("a replayed certificate id is a duplicate and changes nothing", () => {
        const { recv, coord } = fleetBox();
        const cert = certificate(coord, recv.fingerprint, subjectOf(sender(), "mac"));
        expect(apply(recv.box, cert).status).toBe("pinned");
        const before = peersFile(recv.box);
        expect(apply(recv.box, cert).status).toBe("duplicate");
        expect(peersFile(recv.box)).toBe(before);
    });

    test("a same-key pin made by hand is upgraded in place; its permissions stay the owner's", () => {
        const { recv, coord } = fleetBox();
        const mac = peerBox("mac");
        addPin(recv.box, { name: "mac", key: mac.key, fingerprint: mac.fingerprint, allow: ["talk"], via: "coord" });
        const applied = apply(recv.box, certificate(coord, recv.fingerprint, subjectOf(mac, "mac", mac)));
        expect(applied.status).toBe("upgraded");
        const upgraded = peerNamed(recv.box, "mac");
        expect(upgraded?.allow).toEqual(["talk"]);
        expect(upgraded?.cert).toBe(mac.cert);
        expect(upgraded?.introducedBy).toBe(coord.fingerprint);
    });

    test("a pin this machine paired itself is filled in but never handed to the introducer", () => {
        const { recv, coord } = fleetBox();
        const mac = peerBox("mac");
        addPin(recv.box, {
            name: "mac",
            key: mac.key,
            fingerprint: mac.fingerprint,
            cert: mac.cert,
            certSig: mac.certSig,
        });
        expect(apply(recv.box, certificate(coord, recv.fingerprint, subjectOf(mac, "mac", mac))).status).toBe(
            "upgraded",
        );
        expect(peerNamed(recv.box, "mac")?.introducedBy).toBeUndefined();
        expect(peerNamed(recv.box, "mac")?.allow).toEqual([...PERMISSIONS]);
        const revoke = certificate(coord, recv.fingerprint, subjectOf(mac, "mac"), { op: "revoke" });
        expect(() => apply(recv.box, revoke)).toThrow("not mine to revoke");
        expect(peerNamed(recv.box, "mac")?.status).toBe("active");
    });

    test("refresh with the pinned fingerprint in `replaces` takes the rotated key; without it, refused", () => {
        const { recv, coord } = fleetBox();
        const old = sender();
        apply(recv.box, certificate(coord, recv.fingerprint, subjectOf(old, "mac")));
        const fresh = sender();
        const unbound = certificate(coord, recv.fingerprint, subjectOf(fresh, "mac"), { op: "refresh" });
        expect(() => apply(recv.box, unbound)).toThrow("pinned here with another key");
        const bound = certificate(coord, recv.fingerprint, subjectOf(fresh, "mac"), {
            op: "refresh",
            replaces: old.fingerprint,
        });
        expect(apply(recv.box, bound).status).toBe("rotated");
        expect(peerNamed(recv.box, "mac")?.fingerprint).toBe(fresh.fingerprint);
    });

    test("refresh of the same key renews the pin's expiry", () => {
        const { recv, coord } = fleetBox();
        const mac = sender();
        const first = { notAfter: "2030-01-01T00:00:00.000Z" };
        apply(recv.box, certificate(coord, recv.fingerprint, subjectOf(mac, "mac"), first));
        const later: Fields = { op: "refresh", notAfter: "2031-01-01T00:00:00.000Z" };
        expect(apply(recv.box, certificate(coord, recv.fingerprint, subjectOf(mac, "mac"), later)).status).toBe(
            "renewed",
        );
        expect(peerNamed(recv.box, "mac")?.notAfter).toBe("2031-01-01T00:00:00.000Z");
    });

    test("revoke drops a pin its introducer made", () => {
        const { recv, coord } = fleetBox();
        const mac = sender();
        apply(recv.box, certificate(coord, recv.fingerprint, subjectOf(mac, "mac")));
        const revoke = certificate(coord, recv.fingerprint, subjectOf(mac, "mac"), { op: "revoke" });
        expect(apply(recv.box, revoke).status).toBe("revoked");
        expect(peerNamed(recv.box, "mac")?.status).toBe("revoked");
        expect(peerNamed(recv.box, "mac")?.allow).toEqual([]);
    });
});

describe("applyIntroduction refuses", () => {
    test("a wrong signature, or another key's", () => {
        const { recv, coord } = fleetBox();
        const cert = certificate(coord, recv.fingerprint, subjectOf(sender(), "mac"));
        expect(() => apply(recv.box, { ...cert, grants: [...PERMISSIONS] })).toThrow("bad introduction signature");
        const forged = certificate(sender(), recv.fingerprint, subjectOf(sender(), "mac"));
        expect(() => apply(recv.box, forged)).toThrow("introducer is not coord");
        expect(peerNamed(recv.box, "mac")).toBeUndefined();
    });

    test("a certificate for another machine (cross-box replay)", () => {
        const { recv, coord } = fleetBox();
        const elsewhere = certificate(coord, "a".repeat(64), subjectOf(sender(), "mac"));
        expect(() => apply(recv.box, elsewhere)).toThrow("for another machine");
    });

    test("an expired notAfter", () => {
        const { recv, coord } = fleetBox();
        const past = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
        const stale = certificate(coord, recv.fingerprint, subjectOf(sender(), "mac"), { notAfter: past });
        expect(() => apply(recv.box, stale)).toThrow("expired");
    });

    test("a sender without introduce, or not active", () => {
        const { recv, coord } = fleetBox();
        const cert = certificate(coord, recv.fingerprint, subjectOf(sender(), "mac"));
        pin(recv.box, [{ name: "coord", identity: coord }]);
        expect(() => apply(recv.box, cert)).toThrow("may not introduce machines here");
        pin(recv.box, [{ name: "coord", identity: coord, status: "revoked", allow: [...GRANTS] }]);
        expect(() => apply(recv.box, cert)).toThrow("not an active peer here");
    });

    test("an invalid certificate, name or key, or this machine itself", () => {
        const { recv, coord } = fleetBox();
        const mac = peerBox("mac");
        const badCert = { ...subjectOf(mac, "mac", mac), certSig: recv.certSig };
        expect(() => apply(recv.box, certificate(coord, recv.fingerprint, badCert))).toThrow("does not vouch");
        const badName = certificate(coord, recv.fingerprint, subjectOf(sender(), "Bad Name!"));
        expect(() => apply(recv.box, badName)).toThrow("not a valid machine name");
        const wrongFingerprint = { ...subjectOf(sender(), "mac"), fingerprint: "b".repeat(64) };
        expect(() => apply(recv.box, certificate(coord, recv.fingerprint, wrongFingerprint))).toThrow("not its key's");
        const itself = certificate(coord, recv.fingerprint, subjectOf(recv, "box"));
        expect(() => apply(recv.box, itself)).toThrow("that is this machine");
    });

    test("a conflicting name or key: nothing is overwritten", () => {
        const { recv, coord } = fleetBox();
        const mine = sender();
        addPin(recv.box, { name: "mac", key: mine.key, fingerprint: mine.fingerprint });
        const before = peersFile(recv.box);
        const otherKey = certificate(coord, recv.fingerprint, subjectOf(sender(), "mac"));
        expect(() => apply(recv.box, otherKey)).toThrow("pinned here with another key");
        const otherName = certificate(coord, recv.fingerprint, subjectOf(mine, "other-name"));
        expect(() => apply(recv.box, otherName)).toThrow("that key is mac's here");
        expect(peersFile(recv.box)).toBe(before);
    });

    test("an introduced peer cannot introduce, and introduce is never a grant", () => {
        const { recv, coord } = fleetBox();
        const mac = sender();
        apply(recv.box, certificate(coord, recv.fingerprint, subjectOf(mac, "mac")));
        const fromMac = certificate(mac, recv.fingerprint, subjectOf(sender(), "stranger"));
        expect(() => apply(recv.box, fromMac, "mac")).toThrow("may not introduce machines here");
        const { sig: _sig, ...unsigned } = certificate(coord, recv.fingerprint, subjectOf(sender(), "other"));
        const widened = { ...unsigned, grants: ["talk", INTRODUCER_PERMISSION] };
        const signed = { ...widened, sig: signWith(coord.privateKey, canonicalJson(widened)) };
        expect(() => apply(recv.box, signed)).toThrow("unknown grant introduce");
    });
});
