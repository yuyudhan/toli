// The outbox's choice of transport (docs/peers.md "Delivery"), for its synchronous callers: a target that is a paired
// peer with an address gets HTTPS, through `bin/toli peer flush` as a subprocess (the outbox runs synchronously,
// fetch does not); ssh is the fallback when HTTPS fails and `peer.sshFallback` is on; otherwise the items wait.
import { paths } from "../core/paths.ts";
import { run } from "../core/util.ts";
import type { Flush } from "./deliver.ts";
import { activePeer, type Peer, peerSettings } from "./store.ts";

const FLUSH_TIMEOUT_MS = 10 * 60_000;

/** The active paired peer named `name` that has an address to reach, if any. */
export function httpPeer(name: string | undefined): Peer | undefined {
    if (name === undefined) return undefined;
    const peer = activePeer(name);
    return peer !== undefined && peer.addrs.length > 0 ? peer : undefined;
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
