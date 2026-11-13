// The outbox's choice of transport (docs/peers.md "Delivery"), for its synchronous callers: a target that is a paired
// peer with an address gets HTTPS, through `bin/toli peer flush` as a subprocess (the outbox runs synchronously,
// fetch does not); ssh is the fallback when HTTPS fails and `peer.sshFallback` is on; otherwise the items wait.
import { paths } from "../core/paths.ts";
import { run, writeJsonAtomic } from "../core/util.ts";
import type { OutboxItem, SendResult } from "../jobs/outbox.ts";
import type { Flush } from "./deliver.ts";
import { activePeer, type Peer, peerSettings, pushable } from "./store.ts";

const FLUSH_TIMEOUT_MS = 10 * 60_000;

/** The active paired peer named `name` that this machine connects to (an address, inbound taken), if any. */
export function httpPeer(name: string | undefined): Peer | undefined {
    if (name === undefined) return undefined;
    const peer = activePeer(name);
    return peer !== undefined && pushable(peer) ? peer : undefined;
}

/** The active paired peer named `name` this machine cannot connect to, reached through a relay (`via`), if any. */
export function relayedPeer(name: string | undefined): Peer | undefined {
    if (name === undefined) return undefined;
    const peer = activePeer(name);
    return peer !== undefined && !pushable(peer) && peer.via !== undefined ? peer : undefined;
}

/**
 * The active paired peer named `name` that accepts no inbound connection and has no relay: what is queued for it
 * waits here until it pulls (`/v1/outbox/pending`), never pushed.
 */
export function pullingPeer(name: string | undefined): Peer | undefined {
    if (name === undefined) return undefined;
    const peer = activePeer(name);
    return peer !== undefined && peer.inbound === false && peer.via === undefined ? peer : undefined;
}

/** Whether a peer HTTPS could not reach may still get its messages over ssh. */
export function sshFallback(): boolean {
    return peerSettings().sshFallback;
}

/**
 * Flush `target` (a peer's name, or every peer) over HTTPS in a subprocess and return what it did. `own` names an item
 * whose sender records its answer itself (`sendNow`'s caller), so the delegation hook skips it.
 */
export function flushSync(target: string | null, own?: string): Flush[] {
    const argv = [process.execPath, paths.codeBin(), "peer", "flush", ...(target === null ? ["--all"] : [target])];
    if (own !== undefined) argv.push("--own", own);
    const result = run([...argv, "--json"], {
        cwd: paths.root(),
        env: { TOLI_ROOT: paths.root() },
        timeoutMs: FLUSH_TIMEOUT_MS,
    });
    if (result.code !== 0) {
        const why = (result.stderr || result.stdout).trim() || `exited ${result.code}`;
        return [{ peer: target ?? "peers", sent: 0, receipts: [], error: `peer flush: ${why}` }];
    }
    try {
        return JSON.parse(result.stdout) as Flush[];
    } catch {
        return [{ peer: target ?? "peers", sent: 0, receipts: [], error: "peer flush printed no JSON" }];
    }
}

/**
 * Send one item to a peer reached only through its relay (src/peer/relay.ts): queue it and hand it to the relay now.
 * It is delivered when the relay already had it and its recipient's receipt came back; otherwise its recipient pulls
 * it there, and the minute tick settles it by that receipt (`pulled`, `relayed`).
 */
export function sendRelayed(peer: Peer, item: OutboxItem, queued: string, id: string): SendResult {
    writeJsonAtomic(queued, item);
    const relay = peer.via ?? "";
    const flushed = flushSync(peer.name, id)[0];
    const receipt = flushed?.receipts.find((entry) => entry.id === id);
    if (receipt?.status === "applied" || receipt?.status === "duplicate")
        return { delivered: true, stdout: receipt.stdout };
    if (receipt?.status === "refused")
        return {
            delivered: false,
            pulled: false,
            refused: receipt.reason ?? "no reason",
            error: `${peer.name} refused it: ${receipt.reason ?? "no reason"} (kept in state/outbox/cancelled/)`,
        };
    return {
        delivered: false,
        pulled: true,
        relayed: relay,
        error: flushed?.unreachable ?? flushed?.error ?? `held at ${relay} for ${peer.name} to pull`,
    };
}
