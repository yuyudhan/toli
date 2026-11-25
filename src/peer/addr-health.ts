// A paired peer's addresses over time (docs/peers.md "Delivery"): a laptop's announces leave every Wi-Fi and office
// address it ever had in config/peers.json, up to eight. Each request probes them all (src/peer/client.ts); an address
// that has completed no TLS handshake for STALE_ADDR_MS while another address of the same peer answers is dropped, and
// peer.log and the inbox say so (the user sees which address moved). A peer no address of which answers keeps them
// all: it is away, not moved. Its next announce brings back an address it uses again (T2775).
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, readJson, withLock, writeJsonAtomic } from "../core/util.ts";
import { addInboxItem } from "../records/inbox.ts";
import { peerLog, updatePeers } from "./store.ts";

/** How long an address may fail every handshake, while another one answers, before it is dropped. */
export const STALE_ADDR_MS = 24 * 60 * 60 * 1000;

/** state/peer/addr-failures.json: per peer, per address, when it first failed since it last answered (ms). */
type Failures = Record<string, Record<string, number>>;

/**
 * Record one request's probes: `answered` is the address that took the request, `probed` each address's handshake
 * outcome (null: it completed). Drops the addresses failing since STALE_ADDR_MS ago and logs each change.
 */
export function noteAddrs(peer: string, answered: string, probed: ReadonlyMap<string, string | null>): void {
    const at = now().getTime();
    const stale: Array<{ addr: string; since: number; why: string }> = [];
    const file = paths.peerAddrFailures();
    mkdirSync(dirname(file), { recursive: true });
    withLock(paths.lock("peer-addr-failures"), () => {
        const failures = readJson<Failures>(file, {});
        const mine = { ...(failures[peer] ?? {}) };
        for (const [addr, failed] of probed) {
            if (addr === answered || failed === null) {
                delete mine[addr];
                continue;
            }
            const since = mine[addr] ?? at;
            mine[addr] = since;
            if (at - since >= STALE_ADDR_MS) {
                stale.push({ addr, since, why: failed });
                delete mine[addr];
            }
        }
        if (Object.keys(mine).length === 0) delete failures[peer];
        else failures[peer] = mine;
        writeJsonAtomic(file, failures);
    });
    if (stale.length === 0) return;
    const dropped = new Set(stale.map((entry) => entry.addr));
    updatePeers((peers) => {
        const entry = peers.find((candidate) => candidate.name === peer);
        if (entry !== undefined) entry.addrs = entry.addrs.filter((addr) => !dropped.has(addr));
    });
    const lines = stale.map(
        ({ addr, since, why }) =>
            `address for ${peer} changed: dropped ${addr} (no TLS handshake since ${new Date(since).toISOString()}: ${why}); it answers at ${answered}`,
    );
    for (const line of lines) peerLog(line);
    addInboxItem(
        loadMachine().name,
        `address for ${peer} changed`,
        `${lines.join("\n")}\n\n\`bin/toli peer list\` shows the addresses kept; its next announce adds back one it uses again.`,
    );
}
