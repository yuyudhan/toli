// The tick's retry for paired peers that only pull (docs/peers.md "A peer that takes no inbound connection"): a send
// to such a peer only queues for its pull, yet one with an address often answers over HTTPS all the same. Each tick
// sends what waits for it through `peer flush`, the send a hand-run flush makes, so nothing sits until its own pull,
// and only then posts the waiting alerts: an item still queued is one this retry could not deliver either.
import { flushSync, pullingPeer } from "../peer/transport.ts";
import { postWaitingAlerts } from "./outbox-admin.ts";
import { queuedItems } from "./outbox-queue.ts";
import type { Reach } from "./reach.ts";

/** The tick's last outbox step: retry the peers that pull, then post the waiting alerts. Returns the log notes. */
export function retryThenAlert(reach: Reach): string[] {
    return [...retryPullingPeers(reach), ...postWaitingAlerts()];
}

/**
 * Flush each pulling peer with an address that something waits for, once per pass. One that no address answered is
 * backed off across ticks (`reach`, keyed `peer:<name>`), and its items keep waiting for its pull. Receipts settle
 * items as in any flush, so an item the peer already has comes back `duplicate`, never applied twice.
 */
function retryPullingPeers(reach: Reach): string[] {
    const notes: string[] = [];
    const names = new Set<string>();
    for (const { item } of queuedItems()) {
        const peer = pullingPeer(item.to?.name);
        if (peer !== undefined && peer.addrs.length > 0) names.add(peer.name);
    }
    for (const name of names) {
        const key = `peer:${name}`;
        const why = reach.held(key);
        if (why !== null) {
            notes.push(`pending items for ${name} left for its pull: ${why}`);
            continue;
        }
        for (const flush of flushSync(name)) {
            if (flush.sent > 0) notes.push(`delivered ${flush.sent} to ${name}, which pulls`);
            if (flush.unreachable !== undefined) {
                reach.unreachable(key, flush.unreachable);
                notes.push(`pending items for ${name} left for its pull: ${flush.unreachable}`);
                continue;
            }
            reach.success(key);
            if (flush.error !== undefined) notes.push(`pending ${name}: ${flush.error}`);
        }
    }
    return notes;
}
