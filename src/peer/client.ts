// Reaching a paired peer over HTTPS (docs/peers.md "Delivery"): its certificate pinned as the only trusted one, its
// addresses tried in order (the last that answered first), each request timed for `bin/toli peer stats`.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { connect } from "node:tls";
import { loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { isJsonObject, now } from "../core/util.ts";
import { noteAddrs } from "./addr-health.ts";
import { splitHostPort } from "./bind.ts";
import { type ControlKind, type Envelope, sealEnvelope } from "./envelope.ts";
import { loadIdentity, TLS_NAME } from "./identity.ts";
import { DEFAULT_PORT, type Peer, peerLog, updatePeers } from "./store.ts";

const CONNECT_MS = 5_000;
const REQUEST_MS = 120_000;
/**
 * The whole budget of a send someone waits for (`talk`, `delegate`, the checks before them): a peer that does not
 * answer within it gets the item from the queue later (the minute tick, with REQUEST_MS), not by holding the caller.
 */
export const QUICK_MS = 5_000;

export type Answer = { status: number; value: Record<string, unknown>; addr: string; ms: number };

/** Why no address of a peer answered. */
export class Unreachable extends Error {}

/**
 * Whether a TLS handshake with `addr` completes against the peer's pinned certificate within `connectMs` (fetch has
 * no connect or handshake timeout of its own). A bare TCP connect proved nothing: on a mesh VPN every address opened
 * at once, and a dead peer's stalled handshake then held each fetch about 75 s, so a pull pass took 15 min (T2775).
 * The probe socket is destroyed, never just ended: `end()` only half-closes it, and against a peer that never closes
 * its side (a firewall that drops the reset) the socket sat in FIN-WAIT-2 and kept the process alive for good (T1339).
 */
async function handshakes(addr: string, cert: string, connectMs: number): Promise<string | null> {
    const { host, port } = splitHostPort(addr, DEFAULT_PORT);
    const { promise, resolve } = Promise.withResolvers<string | null>();
    const socket = connect({ host, port, ca: cert, servername: TLS_NAME });
    const timer = setTimeout(() => {
        socket.destroy();
        resolve(`no TLS handshake within ${connectMs / 1000} s`);
    }, connectMs);
    socket.once("secureConnect", () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(null);
    });
    socket.once("error", (error) => {
        clearTimeout(timer);
        socket.destroy();
        resolve(error.message);
    });
    return await promise;
}

/**
 * POST `body` to `path` on `peer`, trying each address until one answers (any HTTP status is an answer). The address
 * that answered moves first in config/peers.json. Throws Unreachable when none does. `budgetMs` bounds the whole call,
 * every address included; without it the addresses get CONNECT_MS for their TLS handshakes, all probed at once (a
 * peer with eight addresses, seven dead, once cost 40 s before the live one was tried, T2775), and REQUEST_MS to
 * answer. The first address in order whose handshake completed gets the request.
 */
export async function postPeer(peer: Peer, path: string, body: unknown, budgetMs?: number): Promise<Answer> {
    const errors: string[] = [];
    const deadline = budgetMs === undefined ? undefined : performance.now() + budgetMs;
    const started = performance.now();
    const probes = peer.addrs.map((addr) => handshakes(addr, peer.cert, Math.min(CONNECT_MS, budgetMs ?? CONNECT_MS)));
    for (const [index, addr] of peer.addrs.entries()) {
        const closed = await probes[index];
        if (closed !== null) {
            errors.push(`${addr}: ${closed}`);
            continue;
        }
        const left = deadline === undefined ? REQUEST_MS : Math.round(deadline - performance.now());
        if (left <= 0) {
            errors.push(`${addr}: not tried, ${budgetMs} ms spent`);
            continue;
        }
        const answerMs = left;
        try {
            const response = await fetch(`https://${addr}${path}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
                tls: { ca: peer.cert, serverName: TLS_NAME },
                signal: AbortSignal.timeout(answerMs),
            });
            const value: unknown = await response.json().catch(() => ({}));
            const ms = Math.round(performance.now() - started);
            if (peer.addrs[0] !== addr) preferAddr(peer.name, addr);
            // The other probes end within their handshake budget; then the addresses that keep failing are aged.
            void Promise.all(probes)
                .then((outcomes) =>
                    noteAddrs(peer.name, addr, new Map(peer.addrs.map((entry, at) => [entry, outcomes[at] ?? null]))),
                )
                .catch((error) =>
                    peerLog(
                        `${peer.name}: addresses not aged: ${error instanceof Error ? error.message : String(error)}`,
                    ),
                );
            return { status: response.status, value: isJsonObject(value) ? value : {}, addr, ms };
        } catch (error) {
            errors.push(`${addr}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    throw new Unreachable(errors.length === 0 ? `${peer.name} has no known address` : errors.join("; "));
}

function preferAddr(name: string, addr: string): void {
    updatePeers((peers) => {
        const peer = peers.find((entry) => entry.name === name);
        if (peer === undefined) return;
        peer.addrs = [addr, ...peer.addrs.filter((entry) => entry !== addr)];
    });
}

/** A signed control envelope (announce, status, pending, ack, rotate) for `peer`; `body` is its JSON. */
export function controlEnvelope(peer: Peer, kind: ControlKind, body: unknown, identity = loadIdentity()): Envelope {
    const at = now().getTime();
    return sealEnvelope(identity, {
        id: `${kind}-${at}`,
        seq: at,
        from: loadMachine().name,
        to: peer.fingerprint,
        kind,
        title: kind,
        body: JSON.stringify(body),
        queuedAt: at,
    });
}

/** One delivery attempt, for `bin/toli peer stats`: which transport carried it and how long it took. */
export type Stat = {
    at: string;
    peer: string;
    id: string;
    kind: string;
    transport: "https" | "ssh" | "relay";
    ms: number;
    outcome: string;
};

export function recordStat(stat: Omit<Stat, "at">): void {
    const path = paths.peerStats();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ at: now().toISOString(), ...stat })}\n`);
}
