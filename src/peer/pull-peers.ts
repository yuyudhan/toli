// The pull (docs/peers.md "Delivery"): a machine whose listener is off, or that takes no inbound connection, asks each
// paired peer it reaches for what waits there for it, applies it, acknowledges the receipts, and opens what that peer
// holds for it as a relay (src/peer/relay-client.ts). A relay that took items for this machine nudges it
// (`POST /v1/nudge`), and the listener pulls that peer at once instead of at the next minute tick.
import { configuredPullOnly } from "../core/config.ts";
import { notePulled } from "../jobs/pull.ts";
import { controlEnvelope, postPeer } from "./client.ts";
import { applyBatch } from "./envelope.ts";
import { loadIdentity } from "./identity.ts";
import { applyRelayed, type RelayedPull } from "./relay-client.ts";
import { json, readControl, routes } from "./server.ts";
import { loadPeers, type Peer, peerLog, personField } from "./store.ts";

/** What one pull from a peer did; `relayed` counts the items it held for this machine from other peers. */
export type PeerPull = { peer: string; applied: number; relayed?: RelayedPull; error?: string };

/** Its own setting tells a peer whether to push to this machine at all (`inbound: false`: it only pulls). */
function inboundField(): { inbound?: false } {
    // Only the configured setting (`--inbound off`) counts: a listener that is off for a moment (a restart) must not
    // make every peer stop pushing to this machine once it is back, nor must the fleet list's no-inbound-ssh flag
    // while its listener takes pushes.
    return configuredPullOnly() ? { inbound: false } : {};
}

/**
 * Pull from every active peer with an address what waits there for this machine (a machine whose listener is off),
 * and what it holds for this machine as a relay (src/peer/relay.ts). A peer marked pull-only is pulled too: it holds
 * what it has for a machine it believes pull-only, and two machines that each think the other only pulls would
 * otherwise never exchange anything (T2775). The peers are pulled all at once, so one that stalls holds back no
 * other's messages; the reports keep the peers' order.
 */
export async function pullPeers(): Promise<PeerPull[]> {
    const self = loadIdentity().fingerprint;
    const inbound = inboundField();
    const peers = loadPeers().filter((peer) => peer.status === "active" && peer.addrs.length > 0);
    return await Promise.all(peers.map((peer) => pullPeer(peer, self, inbound)));
}

/** Peers a nudge is pulling from right now: a second nudge while one runs adds nothing, that pull takes it all. */
const nudged = new Set<string>();

routes.set("POST /v1/nudge", async (request, context) => {
    const control = await readControl(request, context, "nudge");
    if (control instanceof Response) return control;
    const peer = control.peer;
    if (peer.addrs.length === 0) return json({ error: "this machine has no address for you to pull from" }, 409);
    if (!nudged.has(peer.name)) {
        nudged.add(peer.name);
        void pullPeer(peer, context.identity.fingerprint, inboundField())
            .then((report) => peerLog(`after ${peer.name}'s nudge: ${report.error ?? `${report.applied} applied`}`))
            .finally(() => nudged.delete(peer.name));
    }
    return json({ ok: true });
});

/** One peer's pull: what waits there for this machine, applied and acknowledged, and what it holds as a relay. */
async function pullPeer(peer: Peer, self: string, inbound: { inbound?: false }): Promise<PeerPull> {
    try {
        const pending = await postPeer(
            peer,
            "/v1/outbox/pending",
            controlEnvelope(peer, "pending", { ...inbound, ...personField() }),
        );
        if (pending.status !== 200) return { peer: peer.name, applied: 0, error: `pending: ${pending.status}` };
        notePulled(peer.name);
        const envelopes = Array.isArray(pending.value.envelopes) ? pending.value.envelopes : [];
        const held = Array.isArray(pending.value.relayed) ? pending.value.relayed : [];
        const report: PeerPull = { peer: peer.name, applied: 0 };
        if (envelopes.length > 0) {
            const receipts = await applyBatch(envelopes, self);
            await postPeer(peer, "/v1/outbox/ack", controlEnvelope(peer, "ack", { receipts }));
            report.applied = receipts.filter((receipt) => receipt.status === "applied").length;
        }
        if (held.length > 0) report.relayed = await applyRelayed(peer, held);
        return report;
    } catch (error) {
        return { peer: peer.name, applied: 0, error: error instanceof Error ? error.message : String(error) };
    }
}
