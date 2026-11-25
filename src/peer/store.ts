// Paired peers (config/peers.json, docs/peers.md): only public keys, pinned certificates, addresses and the
// permissions this machine grants each peer. No shared secret exists anywhere. A removed peer stays as `revoked`, so
// its key is refused rather than unknown. Every pairing, grant, revocation and rotation is logged to logs/peer.log
// with who did it (the owner or the Sardar) and why.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { machineSettings, type PeerSettings } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { persona, personName } from "../core/persona.ts";
import { isJsonObject, now, readJson, ToliError, withLock, writeJsonAtomic } from "../core/util.ts";
import { fingerprintOf } from "./identity.ts";

/** What a peer may do here; pairing grants all of them, and each can be revoked (`peer deny`). */
export const PERMISSIONS = ["talk", "delegate", "share", "answer", "status"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Vouching for other machines here (docs/peers.md "Introducing a machine"): kept out of PERMISSIONS, so neither
 * pairing nor an introduction ever grants it; only `peer allow <peer> introduce` by this machine's owner or Sardar.
 */
export const INTRODUCER_PERMISSION = "introduce";
export type Grant = Permission | typeof INTRODUCER_PERMISSION;
export const GRANTS: readonly Grant[] = [...PERMISSIONS, INTRODUCER_PERMISSION];

/** What an introduced peer may do unless its introduction's `--grants` says otherwise: everything but `delegate`. */
export const INTRODUCED_GRANTS: readonly Permission[] = ["talk", "share", "answer", "status"];

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
    allow: Grant[];
    pairedAt: string;
    /** Who pinned it on this side: `owner` or `sardar` (a pairing or `peer trust`), or `introduced`. */
    pairedBy: string;
    status: "active" | "revoked";
    revokedAt?: string;
    /** The key before the peer's last `peer rotate`, still accepted until `prevKeyUntil`. */
    prevKey?: string;
    prevKeyUntil?: string;
    version?: string;
    /**
     * A peer with no address that neither side can reach (both refuse inbound connections): its messages go through
     * this paired peer, sealed for it, and it pulls them there (src/peer/relay.ts). Set by `peer trust --via`.
     */
    via?: string;
    /**
     * false: the peer accepts no inbound connection (a firewall that resets them, `inbound: false` in its
     * config/machine.json), so a send to it only queues: its items wait here for its pull, and the minute tick tries
     * them once over HTTPS, backed off while it does not answer (src/jobs/pull-peer-retry.ts). Learned from its own
     * pulls and announces (both carry its configured setting); one without the flag clears it.
     */
    inbound?: boolean;
    /**
     * The first name of the peer's user, as its announce and pulls say (its config/persona.json `userFirstName`), so
     * `bin/toli talk <first name>` finds its machine. Information only: kept when it is a plain name, else dropped.
     */
    person?: string;
    /** The fingerprint of the machine whose introduction pinned (or upgraded) this peer (src/peer/introduce.ts). */
    introducedBy?: string;
    /** That introduction certificate's id. */
    introId?: string;
    /** When an introduced pin expires (ISO time), unless its introducer renews it first. */
    notAfter?: string;
};

/** Whether an introduced pin is past its `notAfter`: its messages are refused until its introducer renews it. */
export function expired(peer: Peer): boolean {
    return peer.notAfter !== undefined && Date.parse(peer.notAfter) <= now().getTime();
}

/** Whether this machine connects to `peer` itself: active, with an address, and taking inbound connections. */
export function pushable(peer: Peer): boolean {
    return peer.status === "active" && peer.addrs.length > 0 && peer.inbound !== false;
}

type PeersFile = { peers: Peer[] };

export function isPermission(value: string): value is Permission {
    return (PERMISSIONS as readonly string[]).includes(value);
}

export function isGrant(value: string): value is Grant {
    return (GRANTS as readonly string[]).includes(value);
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

/** This machine's user's first name for its peers' records: none without one, or while config/persona.json is invalid. */
export function personField(): { person?: string } {
    try {
        const first = persona().userFirstName;
        return first === "" ? {} : { person: first };
    } catch (error) {
        if (error instanceof ToliError) return {};
        throw error;
    }
}

/**
 * Record the first name `name`'s announce or pull carried (`person`): kept only when it is a plain name
 * (src/core/persona.ts `personName`), removed when absent or anything else.
 */
export function notePerson(name: string, raw: unknown): void {
    const person = personName(raw);
    if (loadPeers().find((entry) => entry.name === name)?.person === person) return;
    updatePeers((peers) => {
        const entry = peers.find((candidate) => candidate.name === name);
        if (entry === undefined) return;
        if (person === undefined) delete entry.person;
        else entry.person = person;
    });
    peerLog(`${name}'s person: ${person ?? "none"}`);
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

/** This machine's `peer` settings with their defaults (the pairing code's lifetime is read in pair.ts). */
export function peerSettings(): Required<
    Omit<PeerSettings, "bind" | "codeTtlMinutes" | "introducerCap" | "openNetworks">
> & {
    bind: "private" | string[];
} {
    const settings = machineSettings().peer ?? {};
    return {
        port: settings.port ?? DEFAULT_PORT,
        bind: settings.bind ?? "private",
        interfaces: settings.interfaces ?? [],
        listen: settings.listen ?? true,
        sshFallback: settings.sshFallback ?? true,
    };
}

/**
 * The most an introduced peer may do here (config/machine.json `peer.introducerCap`, default the five): an
 * introduction's grants are cut to it, and `introduce` is never in it.
 */
export function introducerCap(): Permission[] {
    const cap = machineSettings().peer?.introducerCap;
    return Array.isArray(cap) ? cap.filter(isPermission) : [...PERMISSIONS];
}

/** NetBird's address range: the office network unless config/machine.json `peer.openNetworks` says otherwise. */
export const DEFAULT_OPEN_NETWORKS = ["100.64.0.0/10"];

/** The networks a toli pairs from on first contact, with no code (config/machine.json `peer.openNetworks`). */
export function openNetworks(): string[] {
    const networks = machineSettings().peer?.openNetworks;
    return Array.isArray(networks) ? networks.filter((entry) => typeof entry === "string") : DEFAULT_OPEN_NETWORKS;
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
