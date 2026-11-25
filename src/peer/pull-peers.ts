// The pull (docs/peers.md "Delivery"): a machine whose listener is off, or that takes no inbound connection, asks each
// paired peer it reaches for what waits there for it, applies it, acknowledges the receipts, and opens what that peer
// holds for it as a relay (src/peer/relay-client.ts).
import { configuredPullOnly } from "../core/config.ts";
import { notePulled } from "../jobs/pull.ts";
import { controlEnvelope, postPeer } from "./client.ts";
import { applyBatch } from "./envelope.ts";
import { loadIdentity } from "./identity.ts";
import { applyRelayed, type RelayedPull } from "./relay-client.ts";
import { loadPeers, type Peer, personField } from "./store.ts";

/** What one pull from a peer did; `relayed` counts the items it held for this machine from other peers. */
export type PeerPull = { peer: string; applied: number; relayed?: RelayedPull; error?: string };

/**
 * Pull from every active peer with an address what waits there for this machine (a machine whose listener is off),
 * and what it holds for this machine as a relay (src/peer/relay.ts). A peer marked pull-only is pulled too: it holds
 * what it has for a machine it believes pull-only, and two machines that each think the other only pulls would
 * otherwise never exchange anything (T2775). The peers are pulled all at once, so one that stalls holds back no
 * other's messages; the reports keep the peers' order.
 */
export async function pullPeers(): Promise<PeerPull[]> {
    const self = loadIdentity().fingerprint;
    // Its own setting tells the peer whether to push to it at all (`inbound: false`: it only pulls), and whose machine
    // this is (its user's first name, information only). Only the configured setting (`--inbound off`) counts: a
    // listener that is off for a moment (a restart) must not make every peer stop pushing to this machine once it is
    // back, nor must the fleet list's no-inbound-ssh flag while its listener takes pushes.
    const inbound: { inbound?: false } = configuredPullOnly() ? { inbound: false } : {};
    const peers = loadPeers().filter((peer) => peer.status === "active" && peer.addrs.length > 0);
    return await Promise.all(peers.map((peer) => pullPeer(peer, self, inbound)));
}

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
