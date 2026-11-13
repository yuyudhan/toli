// The pull (docs/peers.md "Delivery"): a machine whose listener is off, or that takes no inbound connection, asks each
// paired peer it reaches for what waits there for it, applies it, acknowledges the receipts, and opens what that peer
// holds for it as a relay (src/peer/relay-client.ts).
import { pullsItsMessages } from "../core/config.ts";
import { notePulled } from "../jobs/pull.ts";
import { controlEnvelope, postPeer } from "./client.ts";
import { applyBatch } from "./envelope.ts";
import { loadIdentity } from "./identity.ts";
import { applyRelayed, type RelayedPull } from "./relay-client.ts";
import { loadPeers, peerSettings, pushable } from "./store.ts";

/** What one pull from a peer did; `relayed` counts the items it held for this machine from other peers. */
export type PeerPull = { peer: string; applied: number; relayed?: RelayedPull; error?: string };

/**
 * Pull from every active peer what waits there for this machine (a machine whose listener is off), and what it holds
 * for this machine as a relay (src/peer/relay.ts).
 */
export async function pullPeers(): Promise<PeerPull[]> {
    const self = loadIdentity().fingerprint;
    const reports: PeerPull[] = [];
    for (const peer of loadPeers().filter(pushable)) {
        try {
            // Its own setting tells the peer whether to push to it at all (`inbound: false`: it only pulls).
            const inbound = peerSettings().listen && !pullsItsMessages() ? {} : { inbound: false };
            const pending = await postPeer(peer, "/v1/outbox/pending", controlEnvelope(peer, "pending", inbound));
            if (pending.status !== 200) {
                reports.push({ peer: peer.name, applied: 0, error: `pending: ${pending.status}` });
                continue;
            }
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
            reports.push(report);
        } catch (error) {
            reports.push({
                peer: peer.name,
                applied: 0,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return reports;
}
