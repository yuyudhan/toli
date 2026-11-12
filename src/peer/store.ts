// Paired peers (config/peers.json, docs/peers.md): only public keys, pinned certificates, addresses and the
// permissions this machine grants each peer. No shared secret exists anywhere. A removed peer stays as `revoked`, so
// its key is refused rather than unknown. Every pairing, grant, revocation and rotation is logged to logs/peer.log
// with who did it (the owner or the Sardar) and why.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { machineSettings, type PeerSettings } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { isJsonObject, now, readJson, ToliError, withLock, writeJsonAtomic } from "../core/util.ts";
import { fingerprintOf } from "./identity.ts";

/** What a peer may do here; pairing grants all of them, and each can be revoked (`peer deny`). */
export const PERMISSIONS = ["talk", "delegate", "share", "answer", "status"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const DEFAULT_PORT = 47123;

export type Peer = {
    name: string;
    /** Raw Ed25519 public key, base64. */
    key: string;
    fingerprint: string;
    /** The pinned TLS certificate (PEM) and the key's signature over it. */
    cert: string;
    certSig: string;
    /** `host:port` addresses, the last one that answered first. */
    addrs: string[];
    allow: Permission[];
    pairedAt: string;
    /** Who accepted the pairing on this side: `owner` or `sardar`. */
    pairedBy: string;
    status: "active" | "revoked";
    revokedAt?: string;
    /** The key before the peer's last `peer rotate`, still accepted until `prevKeyUntil`. */
    prevKey?: string;
    prevKeyUntil?: string;
    version?: string;
};

type PeersFile = { peers: Peer[] };

export function isPermission(value: string): value is Permission {
    return (PERMISSIONS as readonly string[]).includes(value);
}

export function loadPeers(): Peer[] {
    const file = readJson<unknown>(paths.peers(), { peers: [] });
    const peers = isJsonObject(file) ? file.peers : undefined;
    return Array.isArray(peers) ? (peers.filter(isJsonObject) as Peer[]) : [];
}

/** Read-modify-write config/peers.json under its lock. */
export function updatePeers<T>(fn: (peers: Peer[]) => T): T {
    return withLock(paths.lock("peers"), () => {
        const peers = loadPeers();
        const result = fn(peers);
        writeJsonAtomic(paths.peers(), { peers } satisfies PeersFile);
        return result;
    });
}

export function activePeer(name: string): Peer | undefined {
    return loadPeers().find((peer) => peer.name === name && peer.status === "active");
}

export function requirePeer(name: string): Peer {
    const peer = loadPeers().find((entry) => entry.name === name);
    if (peer === undefined) throw new ToliError(`no peer named "${name}" (bin/toli peer list)`);
    return peer;
}

/** The peer whose current (or, within its rotation window, previous) key has this fingerprint. */
export function peerByFingerprint(fingerprint: string): { peer: Peer; key: string } | undefined {
    const at = now().getTime();
    for (const peer of loadPeers()) {
        if (peer.fingerprint === fingerprint) return { peer, key: peer.key };
        if (
            peer.prevKey !== undefined &&
            peer.prevKeyUntil !== undefined &&
            Date.parse(peer.prevKeyUntil) > at &&
            fingerprintOf(peer.prevKey) === fingerprint
        )
            return { peer, key: peer.prevKey };
    }
    return undefined;
}

/** This machine's `peer` settings with their defaults. */
export function peerSettings(): Required<Omit<PeerSettings, "bind">> & { bind: "private" | string[] } {
    const settings = machineSettings().peer ?? {};
    return {
        port: settings.port ?? DEFAULT_PORT,
        bind: settings.bind ?? "private",
        interfaces: settings.interfaces ?? [],
        listen: settings.listen ?? true,
        sshFallback: settings.sshFallback ?? true,
    };
}

/** Change config/machine.json `peer` (the rest of the file is kept as it is). */
export function updatePeerSettings(change: (settings: PeerSettings) => void): void {
    withLock(paths.lock("machine"), () => {
        const machine = readJson<Record<string, unknown>>(paths.machine(), {});
        const settings = (isJsonObject(machine.peer) ? machine.peer : {}) as PeerSettings;
        change(settings);
        machine.peer = settings;
        writeJsonAtomic(paths.machine(), machine);
    });
}

/** Who runs a security step: the owner at a terminal, or the Sardar in its own turn. */
export type Actor = { by: "owner" | "sardar"; why: string };

/**
 * `--by owner|sardar` and `--why "<reason>"`: either may accept a pairing or change a peer's permissions; the Sardar
 * must say why, and the line is logged. Defaults to the Sardar inside a lead turn (TOLI_LEAD_TURN), else the owner.
 */
export function actorFrom(by: string | undefined, why: string | undefined): Actor {
    const who = by ?? (process.env.TOLI_LEAD_TURN ? "sardar" : "owner");
    if (who !== "owner" && who !== "sardar") throw new ToliError("--by must be owner or sardar");
    const reason = why?.trim() ?? "";
    if (who === "sardar" && reason === "") throw new ToliError('the Sardar must say why: --why "<reason>"');
    return { by: who, why: reason === "" ? "(no reason given)" : reason };
}

/** One line in logs/peer.log. Never pass a pairing code here. */
export function peerLog(line: string): void {
    const path = paths.peerLog();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${now().toISOString()} ${line}\n`);
}
