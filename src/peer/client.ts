// Reaching a paired peer over HTTPS (docs/peers.md "Delivery"): its certificate pinned as the only trusted one, its
// addresses tried in order (the last that answered first), each request timed for `bin/toli peer stats`.
import { appendFileSync, mkdirSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";
import { loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { isJsonObject, now } from "../core/util.ts";
import { splitHostPort } from "./bind.ts";
import { type ControlKind, type Envelope, sealEnvelope } from "./envelope.ts";
import { loadIdentity, TLS_NAME } from "./identity.ts";
import { DEFAULT_PORT, type Peer, updatePeers } from "./store.ts";

const CONNECT_MS = 5_000;
const REQUEST_MS = 120_000;

export type Answer = { status: number; value: Record<string, unknown>; addr: string; ms: number };

/** Why no address of a peer answered. */
export class Unreachable extends Error {}

/** Whether a TCP connection to `addr` opens within CONNECT_MS (fetch itself has no connect timeout). */
async function opens(addr: string): Promise<string | null> {
    const { host, port } = splitHostPort(addr, DEFAULT_PORT);
    const { promise, resolve } = Promise.withResolvers<string | null>();
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
        socket.destroy();
        resolve(`no answer within ${CONNECT_MS / 1000} s`);
    }, CONNECT_MS);
    socket.once("connect", () => {
        clearTimeout(timer);
        socket.end();
        resolve(null);
    });
    socket.once("error", (error) => {
        clearTimeout(timer);
        resolve(error.message);
    });
    return await promise;
}

/**
 * POST `body` to `path` on `peer`, trying each address until one answers (any HTTP status is an answer). The address
 * that answered moves first in config/peers.json. Throws Unreachable when none does.
 */
export async function postPeer(peer: Peer, path: string, body: unknown): Promise<Answer> {
    const errors: string[] = [];
    for (const addr of peer.addrs) {
        const started = performance.now();
        const closed = await opens(addr);
        if (closed !== null) {
            errors.push(`${addr}: ${closed}`);
            continue;
        }
        try {
            const response = await fetch(`https://${addr}${path}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
                tls: { ca: peer.cert, serverName: TLS_NAME },
                signal: AbortSignal.timeout(REQUEST_MS),
            });
            const value: unknown = await response.json().catch(() => ({}));
            const ms = Math.round(performance.now() - started);
            if (peer.addrs[0] !== addr) preferAddr(peer.name, addr);
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
