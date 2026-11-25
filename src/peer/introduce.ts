// Introductions (docs/peers.md "Introducing a machine"): a peer this machine allowed `introduce` (the fleet's
// trusted introducer, granted once per box with `bin/toli peer allow <it> introduce`) vouches for another machine's
// key in a certificate signed by its own identity key, and this machine pins that key with no pairing code. The
// certificate names one audience (the machine that applies it), so one machine's certificate is useless on another;
// its id is remembered 30 days, so a replay is a duplicate; and what it grants is cut to `peer.introducerCap`. An
// introduced peer is never itself an introducer, and its pin expires at `notAfter` unless the introducer renews it.
//
//   introduce   pin the subject, or upgrade a pin of the same key (fills an empty certificate, addresses, relay)
//   refresh     the same, and with `replaces` equal to the pinned fingerprint, take the subject's rotated key
//   revoke      revoke a pin this introducer made; a peer this machine paired itself is never touched
import { randomBytes } from "node:crypto";
import { loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { personName } from "../core/persona.ts";
import { isJsonObject, isValidName, now, readJson, ToliError, withLock, writeJsonAtomic } from "../core/util.ts";
import { cancelItems, itemsFor } from "../jobs/outbox-admin.ts";
import {
    canonicalJson,
    certSigValid,
    fingerprintOf,
    type Identity,
    loadIdentity,
    publicKeyFromRaw,
    signWith,
    verifySignature,
} from "./identity.ts";
import {
    expired,
    INTRODUCER_PERMISSION,
    introducerCap,
    isPermission,
    PERMISSIONS,
    type Peer,
    type Permission,
    peerLog,
    updatePeers,
} from "./store.ts";

export type IntroOp = "introduce" | "refresh" | "revoke";

/** The machine an introduction is about: what pinning it needs, as the introducer has it pinned. */
export type Subject = {
    name: string;
    person?: string;
    key: string;
    fingerprint: string;
    cert: string;
    certSig: string;
    addrs: string[];
    inbound?: boolean;
};

export type Introduction = {
    v: 1;
    id: string;
    op: IntroOp;
    /** The introducer's key fingerprint. */
    introducer: string;
    /** The fingerprint of the one machine that may apply it. */
    audience: string;
    subject: Subject;
    grants: Permission[];
    /** When the pin it makes expires (ISO time); null: never. */
    notAfter: string | null;
    /** On a refresh: the subject's previous key fingerprint, which the new key replaces. */
    replaces: string | null;
    /** Who approved it on the introducer, why, and when. */
    approval: { by: string; why: string; at: string };
    sig: string;
};

/** How long an introduced pin lasts unless renewed (`peer introduce --sync` renews it). */
export const PIN_DAYS = 180;
const DAY_MS = 24 * 60 * 60_000;
/** `notAfter` is read with a day's slack for a clock that runs ahead. */
const SKEW_SLACK_MS = DAY_MS;
/** An applied certificate id is remembered this long; the same id again is a duplicate. */
export const INTRO_KEEP_MS = 30 * DAY_MS;

/** A fresh certificate id. */
export function introId(): string {
    return `intro-${randomBytes(12).toString("hex")}`;
}

/** `PIN_DAYS` from now, as an ISO time. */
export function pinExpiry(): string {
    return new Date(now().getTime() + PIN_DAYS * DAY_MS).toISOString();
}

/** Sign `fields` as `identity`, the introducer. */
export function signIntroduction(
    identity: Identity,
    fields: Omit<Introduction, "v" | "introducer" | "sig">,
): Introduction {
    const unsigned = { v: 1 as const, introducer: identity.fingerprint, ...fields };
    return { ...unsigned, sig: signWith(identity.privateKey, canonicalJson(unsigned)) };
}

/** A pinned peer as a certificate's subject. */
export function subjectOf(peer: Peer): Subject {
    return {
        name: peer.name,
        ...(peer.person === undefined ? {} : { person: peer.person }),
        key: peer.key,
        fingerprint: peer.fingerprint,
        cert: peer.cert,
        certSig: peer.certSig,
        addrs: peer.addrs,
        ...(peer.inbound === undefined ? {} : { inbound: peer.inbound }),
    };
}

const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string");

function parseSubject(value: unknown): Subject | null {
    if (!isJsonObject(value)) return null;
    const { name, person, key, fingerprint, cert, certSig, addrs, inbound } = value;
    if (
        typeof name !== "string" ||
        typeof key !== "string" ||
        typeof fingerprint !== "string" ||
        typeof cert !== "string" ||
        typeof certSig !== "string" ||
        !strings(addrs) ||
        (inbound !== undefined && typeof inbound !== "boolean")
    )
        return null;
    return {
        name,
        ...(person === undefined ? {} : { person: String(person) }),
        key,
        fingerprint,
        cert,
        certSig,
        addrs: addrs.slice(0, 8),
        ...(inbound === undefined ? {} : { inbound }),
    };
}

/** The certificate in `value`, or null when it is not one. Its signature is checked by `applyIntroduction`. */
export function parseIntroduction(value: unknown): Introduction | null {
    if (!isJsonObject(value) || value.v !== 1) return null;
    const { id, op, introducer, audience, grants, notAfter, replaces, approval, sig } = value;
    const subject = parseSubject(value.subject);
    if (
        typeof id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id) ||
        (op !== "introduce" && op !== "refresh" && op !== "revoke") ||
        typeof introducer !== "string" ||
        typeof audience !== "string" ||
        subject === null ||
        !strings(grants) ||
        (notAfter !== null && typeof notAfter !== "string") ||
        (replaces !== null && typeof replaces !== "string") ||
        !isJsonObject(approval) ||
        typeof approval.by !== "string" ||
        typeof approval.why !== "string" ||
        typeof approval.at !== "string" ||
        typeof sig !== "string"
    )
        return null;
    // Every field is kept as sent, so the signature covers exactly what arrived.
    return value as Introduction;
}

/** What applying one certificate did here. */
export type Applied = {
    status: "pinned" | "upgraded" | "renewed" | "rotated" | "revoked" | "duplicate";
    peer: string;
    /** One line for the log and the inbox: who now trusts whom, through whom. */
    note: string;
};

type Seen = Record<string, number>;

/** Whether `id` was applied within INTRO_KEEP_MS; ids older than that are forgotten here. */
function seenBefore(id: string): boolean {
    const cutoff = now().getTime() - INTRO_KEEP_MS;
    const seen = readJson<Seen>(paths.peerIntroductions(), {});
    return (seen[id] ?? 0) >= cutoff;
}

function remember(id: string): void {
    withLock(paths.lock("peer-introductions"), () => {
        const cutoff = now().getTime() - INTRO_KEEP_MS;
        const seen = readJson<Seen>(paths.peerIntroductions(), {});
        for (const [key, at] of Object.entries(seen)) if (at < cutoff) delete seen[key];
        seen[id] = now().getTime();
        writeJsonAtomic(paths.peerIntroductions(), seen);
    });
}

/** The introducer named `from` as this machine pins it, refusing one that may not introduce here. */
function introducerPeer(from: string, peers: Peer[], cert: Introduction): Peer {
    const sender = peers.find((entry) => entry.name === from && entry.status === "active");
    if (sender === undefined) throw new ToliError(`${from} is not an active peer here`);
    if (!sender.allow.includes(INTRODUCER_PERMISSION))
        throw new ToliError(`${from} may not introduce machines here (bin/toli peer allow ${from} introduce)`);
    if (expired(sender)) throw new ToliError(`${from}'s own pin expired here`);
    if (sender.fingerprint !== cert.introducer) throw new ToliError(`the certificate's introducer is not ${from}`);
    const { sig, ...unsigned } = cert;
    if (!verifySignature(sender.key, canonicalJson(unsigned), sig))
        throw new ToliError(`bad introduction signature from ${from}`);
    return sender;
}

/** Refuse a subject that cannot be pinned: a bad key, certificate, name or person, or this machine itself. */
function checkSubject(subject: Subject, self: Identity): void {
    publicKeyFromRaw(subject.key);
    if (fingerprintOf(subject.key) !== subject.fingerprint)
        throw new ToliError("the subject's fingerprint is not its key's");
    if ((subject.cert !== "" || subject.certSig !== "") && !certSigValid(subject.key, subject.cert, subject.certSig))
        throw new ToliError("the subject's key does not vouch for its certificate");
    if (!isValidName(subject.name)) throw new ToliError(`"${subject.name}" is not a valid machine name`);
    if (subject.person !== undefined && personName(subject.person) === undefined)
        throw new ToliError(`"${subject.person}" is not a plain first name`);
    if (subject.key === self.key || subject.name === loadMachine().name) throw new ToliError("that is this machine");
}

/** The certificate's grants cut to this machine's cap, in the usual order; never `introduce`. */
function cappedGrants(grants: string[]): Permission[] {
    const unknown = grants.filter((grant) => !isPermission(grant));
    if (unknown.length > 0) throw new ToliError(`unknown grant ${unknown.join(", ")}`);
    const cap = introducerCap();
    return PERMISSIONS.filter((permission) => grants.includes(permission) && cap.includes(permission));
}

/** Revoke the subject's pin, only when this introducer made it. */
function revoke(cert: Introduction, sender: Peer, peers: Peer[]): Applied {
    const peer = peers.find((entry) => entry.fingerprint === cert.subject.fingerprint && entry.status === "active");
    if (peer === undefined) return { status: "revoked", peer: cert.subject.name, note: "it was not pinned here" };
    if (peer.introducedBy !== sender.fingerprint)
        throw new ToliError(
            `${peer.name} was not introduced here by ${sender.name}: its pin stays (not mine to revoke)`,
        );
    peer.status = "revoked";
    peer.revokedAt = now().toISOString();
    peer.allow = [];
    return { status: "revoked", peer: peer.name, note: `${sender.name} revoked ${peer.name}` };
}

/**
 * The subject's addresses, or none when it names no TLS certificate: a pin with addresses is reached over HTTPS with
 * its certificate as the only trusted one, so one without a certificate is reached through its introducer only.
 */
function reachable(subject: Subject): string[] {
    return subject.cert === "" ? [] : subject.addrs;
}

/** Introduce or refresh: pin the subject, or upgrade, renew or rotate its pin. */
function pinSubject(cert: Introduction, sender: Peer, peers: Peer[]): Applied {
    const { subject } = cert;
    const holder = peers.find((entry) => entry.fingerprint === subject.fingerprint && entry.name !== subject.name);
    if (holder !== undefined) throw new ToliError(`that key is ${holder.name}'s here; nothing was changed`);
    const index = peers.findIndex((entry) => entry.name === subject.name);
    const existing = peers[index];
    const notAfter = cert.notAfter === null ? {} : { notAfter: cert.notAfter };
    const stamp = { introducedBy: sender.fingerprint, introId: cert.id, ...notAfter };
    const through = `through ${sender.name} (${sender.fingerprint.slice(0, 16)}), approved by its ${cert.approval.by}: ${cert.approval.why}`;
    if (existing?.status === "active") {
        const mine = existing.introducedBy === sender.fingerprint;
        if (existing.fingerprint !== subject.fingerprint) {
            if (cert.op !== "refresh" || cert.replaces !== existing.fingerprint || !mine)
                throw new ToliError(`${subject.name} is pinned here with another key; that one stays`);
            Object.assign(existing, {
                key: subject.key,
                fingerprint: subject.fingerprint,
                cert: subject.cert,
                certSig: subject.certSig,
                addrs: subject.cert === "" ? [] : subject.addrs.length > 0 ? subject.addrs : existing.addrs,
                ...stamp,
            });
            return { status: "rotated", peer: subject.name, note: `${subject.name}'s new key pinned ${through}` };
        }
        // The same key: fill what is missing; its permissions stay what this machine's owner set. A pin this machine
        // made by pairing (a certificate it checked itself) stays its own: never stamped, so the introducer can
        // neither expire nor revoke it. A hand-made `peer trust` pin (no certificate) is taken over.
        const handMade = existing.cert === "" && existing.introducedBy === undefined;
        if (existing.cert === "" && subject.cert !== "") {
            existing.cert = subject.cert;
            existing.certSig = subject.certSig;
        }
        if (existing.addrs.length === 0 && existing.cert !== "") existing.addrs = reachable(subject);
        existing.via ??= sender.name;
        if (mine || handMade) Object.assign(existing, stamp);
        const status = mine ? "renewed" : "upgraded";
        return { status, peer: subject.name, note: `${subject.name} (already pinned here) ${status} ${through}` };
    }
    if (
        existing !== undefined &&
        existing.fingerprint === subject.fingerprint &&
        existing.introducedBy !== sender.fingerprint
    )
        throw new ToliError(`${subject.name} was removed here; only this machine's owner pairs it again`);
    const peer: Peer = {
        name: subject.name,
        key: subject.key,
        fingerprint: subject.fingerprint,
        cert: subject.cert,
        certSig: subject.certSig,
        addrs: reachable(subject),
        allow: cappedGrants(cert.grants),
        pairedAt: now().toISOString(),
        pairedBy: "introduced",
        status: "active",
        via: sender.name,
        ...(subject.inbound === false ? { inbound: false } : {}),
        ...(subject.person === undefined ? {} : { person: subject.person }),
        ...stamp,
    };
    if (index >= 0) peers[index] = peer;
    else peers.push(peer);
    return {
        status: "pinned",
        peer: subject.name,
        note: `${subject.name} (${subject.fingerprint.slice(0, 16)}) pinned ${through}; it may: ${peer.allow.join(", ") || "nothing"}`,
    };
}

/**
 * Apply one introduction certificate that the peer named `from` sent here (its envelope already verified), under
 * the receiver rules: `from` holds `introduce` and signed it; it is for this machine; its subject is a valid key,
 * certificate and name that conflicts with no other pin; it has not expired. Throws ToliError with the reason when
 * refused; nothing is changed then.
 */
export function applyIntroduction(raw: unknown, from: string): Applied {
    const cert = parseIntroduction(raw);
    if (cert === null) throw new ToliError("not an introduction certificate");
    const identity = loadIdentity();
    if (cert.audience !== identity.fingerprint) throw new ToliError("this introduction is for another machine");
    if (seenBefore(cert.id))
        return { status: "duplicate", peer: cert.subject.name, note: `${cert.id} already applied` };
    if (cert.notAfter !== null) {
        const until = Date.parse(cert.notAfter);
        if (!Number.isFinite(until) || until + SKEW_SLACK_MS <= now().getTime())
            throw new ToliError(`the introduction expired at ${cert.notAfter}`);
    }
    checkSubject(cert.subject, identity);
    const applied = updatePeers((peers) => {
        const sender = introducerPeer(from, peers, cert);
        return cert.op === "revoke" ? revoke(cert, sender, peers) : pinSubject(cert, sender, peers);
    });
    remember(cert.id);
    if (applied.status === "revoked") {
        const files = itemsFor(applied.peer).map(({ file }) => file);
        if (files.length > 0) cancelItems(files, `${applied.peer} was revoked by its introducer ${from}`);
    }
    peerLog(`introduction ${cert.id} from ${from}: ${applied.status} ${applied.peer}: ${applied.note}`);
    return applied;
}
