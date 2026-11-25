// Rotating this installation's key (docs/peers.md "Rotating the key"): `peer rotate` and the listener's
// `/v1/rotate` route that takes a peer's new key.
import { now } from "../core/util.ts";
import { controlEnvelope, postPeer } from "./client.ts";
import { parsed } from "./deliver.ts";
import { certSigValid, fingerprintOf, initIdentity, loadIdentity } from "./identity.ts";
import { controlRequest, json, readControl, routes } from "./server.ts";
import { loadPeers, peerLog, updatePeers } from "./store.ts";

// Rotate: a new key and certificate, announced to every peer signed by the old key; they accept the old one for a
// week more (src/peer/store.ts `prevKey`), so messages already on their way still verify.

const ROTATE_GRACE_MS = 7 * 24 * 60 * 60_000;

routes.set("POST /v1/rotate", async (request, context) => {
    const control = await readControl(request, context, "rotate");
    if (control instanceof Response) return control;
    const body = parsed(control.envelope);
    const { key, cert, certSig } = body;
    if (typeof key !== "string" || typeof cert !== "string" || typeof certSig !== "string")
        return json({ error: "expected {key, cert, certSig}" }, 400);
    if (!certSigValid(key, cert, certSig))
        return json({ error: "the new key does not vouch for the certificate" }, 400);
    updatePeers((peers) => {
        const peer = peers.find((entry) => entry.name === control.peer.name);
        if (peer === undefined) return;
        peer.prevKey = peer.key;
        peer.prevKeyUntil = new Date(now().getTime() + ROTATE_GRACE_MS).toISOString();
        peer.key = key;
        peer.fingerprint = fingerprintOf(key);
        peer.cert = cert;
        peer.certSig = certSig;
    });
    peerLog(`${control.peer.name} rotated its key to ${fingerprintOf(key)}`);
    return json({ ok: true });
});

/**
 * `peer rotate`: make a new key and certificate here, then tell every active peer, signed by the old key. Returns the
 * peers told and those that could not be (they must pair again). The listener restarts on the new certificate.
 */
export async function rotateIdentity(): Promise<{ told: string[]; missed: string[] }> {
    const old = loadIdentity();
    initIdentity({ rotate: true });
    const fresh = loadIdentity();
    const told: string[] = [];
    const missed: string[] = [];
    for (const peer of loadPeers().filter((entry) => entry.status === "active")) {
        const envelope = controlEnvelope(
            peer,
            "rotate",
            { key: fresh.key, cert: fresh.certPem, certSig: fresh.certSig },
            old,
        );
        try {
            const answer = await postPeer(peer, "/v1/rotate", envelope);
            (answer.status === 200 ? told : missed).push(peer.name);
        } catch {
            missed.push(peer.name);
        }
    }
    peerLog(`rotated this machine's key to ${fresh.fingerprint}; told ${told.join(", ") || "nobody"}`);
    await controlRequest("/stop");
    return { told, missed };
}
