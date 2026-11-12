// Shared setup for the peer tests: a sandbox with a peer identity, in-process senders with their own Ed25519 keys,
// and a way to pin a sender into a sandbox's config/peers.json without pairing.
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Envelope, type Receipt, sealEnvelope, type Unsigned } from "../src/peer/envelope.ts";
import { canonicalJson, fingerprintOf, type Identity, signWith } from "../src/peer/identity.ts";
import type { Peer, Permission } from "../src/peer/store.ts";
import { type Sandbox, sandbox } from "./helpers.ts";

export type PeerBox = { box: Sandbox; name: string; fingerprint: string; key: string; cert: string; certSig: string };

/** A sandbox initialised as machine `name` with its peer identity made (`peer init`). */
export function peerBox(name: string): PeerBox {
    const box = sandbox();
    box.ok(["init", "--name", name, "--role", "coordinator"]);
    box.ok(["peer", "init"]);
    const status = JSON.parse(box.ok(["peer", "status", "--json"])) as {
        fingerprint: string;
        key: string;
        cert: string;
        certSig: string;
    };
    return { box, name, ...status };
}

/** An in-process sender identity (no certificate: envelopes need only the key). */
export function sender(): Identity {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" });
    const key = Buffer.from(String(jwk.x), "base64url").toString("base64");
    return {
        key,
        fingerprint: fingerprintOf(key),
        privateKey,
        certPem: "",
        certFingerprint: "",
        certSig: "",
        tlsKeyPem: "",
    };
}

/** Write `peers` into the sandbox's config/peers.json, as pairing would. */
export function pin(
    box: Sandbox,
    peers: Array<{
        name: string;
        identity: { key: string; fingerprint: string };
        allow?: Permission[];
        status?: Peer["status"];
        addrs?: string[];
        cert?: string;
    }>,
): void {
    const file: { peers: Peer[] } = {
        peers: peers.map(({ name, identity, allow, status, addrs, cert }) => ({
            name,
            key: identity.key,
            fingerprint: identity.fingerprint,
            cert: cert ?? "",
            certSig: "",
            addrs: addrs ?? [],
            allow: allow ?? ["talk", "delegate", "share", "answer", "status"],
            pairedAt: new Date().toISOString(),
            pairedBy: "owner",
            status: status ?? "active",
        })),
    };
    writeFileSync(join(box.root, "config", "peers.json"), JSON.stringify(file, null, 4));
}

let counter = 0;

/** A signed `inbox` (or other kind) envelope from `identity` named `from` to the fingerprint `to`. */
export function envelope(identity: Identity, from: string, to: string, fields: Partial<Unsigned> = {}): Envelope {
    counter += 1;
    return sealEnvelope(identity, {
        id: `msg-${process.pid}-${counter}`,
        seq: counter,
        from,
        to,
        kind: "inbox",
        title: `hello ${counter}`,
        body: `words ${counter}`,
        queuedAt: Date.now(),
        ...fields,
    });
}

/** Re-sign an envelope after changing fields (a forged `sentAt`, a different `from`). */
export function resign(identity: Identity, value: Envelope, change: Partial<Envelope>): Envelope {
    const { sig: _sig, ...unsigned } = { ...value, ...change };
    return { ...unsigned, sig: signWith(identity.privateKey, canonicalJson(unsigned)) };
}

/** Run `bin/toli peer apply` in `box` with `envelopes` on stdin; returns the receipts. */
export function applyIn(box: Sandbox, envelopes: unknown[]): Receipt[] {
    const result = box.toli(["peer", "apply"], { stdin: JSON.stringify({ envelopes }) });
    if (result.code !== 0) throw new Error(`peer apply exited ${result.code}: ${result.stderr}${result.stdout}`);
    return (JSON.parse(result.stdout) as { receipts: Receipt[] }).receipts;
}
