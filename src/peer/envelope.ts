// One protocol for every transport (docs/peers.md "The envelope"): a message to a paired peer is an envelope signed
// with this installation's Ed25519 key, carried over HTTPS (src/peer/server.ts), ssh (`bin/toli peer apply`) or a
// pull. All of them end in `applyBatch` on the receiver, which verifies each envelope, checks the sender's permission
// and its claims, deduplicates by id, and runs the same `bin/toli` command a delivery always ran, as a subprocess. It
// returns one receipt per envelope. Nothing executes on arrival: every kind ends as an inbox item, a queued task or a
// share record, and this machine's lead decides what happens next.
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { paths } from "../core/paths.ts";
import { isJsonObject, now, readJson, runAsync, withLock, writeJsonAtomic } from "../core/util.ts";
import type { OutboxKind } from "../jobs/outbox.ts";
import { loadBacklog } from "../records/backlog.ts";
import { fleetId, splitFleetId } from "../records/delegation-report.ts";
import { addInboxItem, listInbox } from "../records/inbox.ts";
import { canonicalJson, type Identity, signWith, verifySignature } from "./identity.ts";
import { markReceiving } from "./receiving.ts";
import { type Peer, type Permission, peerByFingerprint } from "./store.ts";

/** Kinds that carry a message (an outbox item); the rest ask the receiving listener for something. */
export const MESSAGE_KINDS: readonly OutboxKind[] = ["inbox", "delegation", "update", "link", "share", "answer"];
export type ControlKind = "announce" | "status" | "pending" | "ack" | "rotate";
export type EnvelopeKind = OutboxKind | ControlKind;

export type Envelope = {
    v: 1;
    /** The outbox item's id (its file name without `.json`): the same on every attempt, so a resend is a duplicate. */
    id: string;
    seq: number;
    from: string;
    /** The sender's key fingerprint, and the receiver's. */
    fromKey: string;
    to: string;
    kind: EnvelopeKind;
    title: string;
    body: string;
    queuedAt: number;
    /** Fresh on every attempt, with the nonce: a captured request cannot be replayed. */
    sentAt: number;
    nonce: string;
    sig: string;
};

export type ReceiptStatus = "applied" | "duplicate" | "refused" | "deferred" | "failed";
/** `code`: for an envelope refused before it was applied, the HTTP status its check maps to (401, 403, 409, 413). */
export type Receipt = { id: string; status: ReceiptStatus; reason?: string; stdout: string; code?: number };

export const CLOCK_SKEW_MS = 5 * 60_000;
export const NONCE_KEEP_MS = 10 * 60_000;
/** A received id is remembered this long, with its receipt, so a resend is answered without applying it again. */
const RECEIVED_KEEP_MS = 30 * 24 * 60 * 60_000;
export const TITLE_MAX = 200;
const BODY_MAX: Partial<Record<EnvelopeKind, number>> = { inbox: 16 * 1024, delegation: 256 * 1024 };
const BODY_DEFAULT_MAX = 64 * 1024;
/** Unacknowledged inbox items one peer may have here; past it, its messages are deferred (kept queued there). */
export const INBOX_CAP = 200;
/** A batch longer than this gets one header item naming how many arrived and how long they waited. */
const BATCH_HEADER_OVER = 5;
const APPLY_TIMEOUT_MS = 120_000;
/** This code's CLI (the runtime snapshot's or the working tree's), as pull.ts. */
const TOLI_SCRIPT = resolve(import.meta.dir, "..", "..", "bin", "toli");

const PERMISSION_FOR: Partial<Record<EnvelopeKind, Permission>> = {
    inbox: "talk",
    delegation: "delegate",
    share: "share",
    answer: "answer",
    status: "status",
};

export type Unsigned = Omit<Envelope, "v" | "fromKey" | "sentAt" | "nonce" | "sig">;

/** Sign `fields` as `identity`, fresh `sentAt` and nonce: the sender re-signs on every attempt. */
export function sealEnvelope(identity: Identity, fields: Unsigned): Envelope {
    const unsigned = {
        v: 1 as const,
        ...fields,
        fromKey: identity.fingerprint,
        sentAt: now().getTime(),
        nonce: randomBytes(16).toString("base64"),
    };
    return { ...unsigned, sig: signWith(identity.privateKey, canonicalJson(unsigned)) };
}

export type Verified = { ok: true; peer: Peer; envelope: Envelope } | { ok: false; code: number; reason: string };

function shapeOf(value: unknown): Envelope | null {
    if (!isJsonObject(value)) return null;
    const strings = ["id", "from", "fromKey", "to", "kind", "title", "body", "nonce", "sig"];
    const numbers = ["seq", "queuedAt", "sentAt"];
    if (value.v !== 1) return null;
    if (!strings.every((field) => typeof value[field] === "string")) return null;
    if (!numbers.every((field) => typeof value[field] === "number" && Number.isFinite(value[field]))) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(String(value.id))) return null;
    return value as Envelope;
}

/** Record `nonce` of `fingerprint`; false when it was seen within NONCE_KEEP_MS (a replay). */
function freshNonce(fingerprint: string, nonce: string): boolean {
    return withLock(paths.lock("peer-nonces"), () => {
        const at = now().getTime();
        const seen = readJson<Record<string, number>>(paths.peerNonces(), {});
        for (const [key, when] of Object.entries(seen)) if (at - when > NONCE_KEEP_MS) delete seen[key];
        const key = `${fingerprint}:${nonce}`;
        if (seen[key] !== undefined) return false;
        seen[key] = at;
        writeJsonAtomic(paths.peerNonces(), seen);
        return true;
    });
}

export function bodyLimit(kind: EnvelopeKind): number {
    return BODY_MAX[kind] ?? BODY_DEFAULT_MAX;
}

/**
 * Check one envelope addressed to `self` (this machine's fingerprint), in this order: the key belongs to an active
 * peer, the signature verifies, it is addressed here, `from` is that peer's name, `sentAt` is within five minutes,
 * the nonce is new, the sizes are within limits, and the peer has the permission its kind needs. The nonce is
 * recorded only for a signed envelope, so nobody without a key can fill the cache.
 */
export function verifyEnvelope(value: unknown, self: string): Verified {
    const envelope = shapeOf(value);
    if (envelope === null) return { ok: false, code: 400, reason: "malformed envelope" };
    const found = peerByFingerprint(envelope.fromKey);
    if (found === undefined) return { ok: false, code: 401, reason: "unknown peer key" };
    const { peer, key } = found;
    if (peer.status !== "active") return { ok: false, code: 401, reason: `${peer.name} is revoked here` };
    const { sig, ...unsigned } = envelope;
    if (!verifySignature(key, canonicalJson(unsigned), sig)) return { ok: false, code: 401, reason: "bad signature" };
    if (envelope.to !== self) return { ok: false, code: 401, reason: "not addressed to this machine" };
    if (envelope.from !== peer.name)
        return { ok: false, code: 401, reason: `from "${envelope.from}" is not the key's peer (${peer.name})` };
    if (Math.abs(now().getTime() - envelope.sentAt) > CLOCK_SKEW_MS)
        return { ok: false, code: 401, reason: "sentAt outside the 5-minute window (replayed or clock skew)" };
    if (!freshNonce(envelope.fromKey, envelope.nonce)) return { ok: false, code: 409, reason: "replayed nonce" };
    if (envelope.title.length > TITLE_MAX)
        return { ok: false, code: 413, reason: `title over ${TITLE_MAX} characters` };
    if (Buffer.byteLength(envelope.body) > bodyLimit(envelope.kind))
        return { ok: false, code: 413, reason: `${envelope.kind} body over ${bodyLimit(envelope.kind)} bytes` };
    const needs = PERMISSION_FOR[envelope.kind];
    if (needs !== undefined && !peer.allow.includes(needs))
        return { ok: false, code: 403, reason: `${peer.name} lacks the ${needs} permission here` };
    return { ok: true, peer, envelope };
}

function parseBody(body: string): Record<string, unknown> | null {
    try {
        const value: unknown = JSON.parse(body);
        return isJsonObject(value) ? value : null;
    } catch {
        return null;
    }
}

/**
 * Whether `peer` may say what this message claims (null when it may, else why not): a delegation, link or share
 * speaks only for its sender; an update comes only from the task's owner and, when it names a task here, only for a
 * delegation recorded on that task; an answer goes only to a task that peer delegated here.
 */
export function senderClaimRefusal(peer: string, kind: EnvelopeKind, body: string): string | null {
    if (kind === "inbox") return null;
    const value = parseBody(body);
    if (value === null) return `${kind} body is not a JSON object`;
    if (kind === "delegation" || kind === "link")
        return value.from === peer ? null : `${kind} claims to be from ${String(value.from)}, not ${peer}`;
    if (kind === "share") {
        const share = isJsonObject(value.share) ? value.share : null;
        const claimed = value.type === "learning" ? share?.from : value.machine;
        return claimed === peer ? null : `share claims to be from ${String(claimed)}, not ${peer}`;
    }
    if (kind === "update") {
        if (value.owner !== peer) return `update for ${String(value.owner)}'s task sent by ${peer}`;
        if (typeof value.id !== "string") return "update without a task id";
        if (typeof value.forTask !== "string") return null;
        const id = fleetId(peer, value.id);
        const local = loadBacklog().tasks.find((task) => task.id === value.forTask);
        const recorded = local?.delegatedTo?.includes(id) === true || local?.slices?.includes(id) === true;
        return recorded ? null : `no delegation of ${String(value.forTask)} to ${id} is recorded here`;
    }
    if (kind === "answer") {
        if (typeof value.id !== "string" || typeof value.answer !== "string") return "answer without id and answer";
        const id = splitFleetId(value.id).id;
        const task = loadBacklog().tasks.find((entry) => entry.id === id);
        if (task === undefined) return `no task ${id} here`;
        return task.delegatedBy?.machine === peer ? null : `${id} was not delegated here by ${peer}`;
    }
    return `${kind} is not a message`;
}

/** The `bin/toli` command a verified message runs here; stdin is its body. The sender is the verified peer. */
export function applyArgv(peer: Peer, envelope: Envelope): string[] {
    const from = peer.name;
    switch (envelope.kind) {
        case "delegation":
            return ["delegation", "receive", "--from", from];
        case "update":
            return ["delegation", "update", "--from", from];
        case "link":
            return ["delegation", "link", "--from", from];
        case "share":
            return ["share", "receive"];
        case "answer": {
            const value = parseBody(envelope.body) ?? {};
            return ["task", "answer", splitFleetId(String(value.id)).id, String(value.answer), "--from", from];
        }
        default:
            return [
                "inbox",
                "add",
                "--from",
                from,
                "--title",
                envelope.title,
                "--via",
                `peer ${from} (fingerprint ${peer.fingerprint.slice(0, 16)})`,
            ];
    }
}

type Received = Record<string, { status: "applied"; stdout: string; at: number }>;

function loadReceived(peer: string): Received {
    return readJson<Received>(paths.peerReceived(peer), {});
}

function recordReceived(peer: string, id: string, stdout: string): void {
    withLock(paths.lock(`peer-received-${peer}`), () => {
        const cutoff = now().getTime() - RECEIVED_KEEP_MS;
        const received = loadReceived(peer);
        for (const [key, entry] of Object.entries(received)) if (entry.at < cutoff) delete received[key];
        received[id] = { status: "applied", stdout, at: now().getTime() };
        writeJsonAtomic(paths.peerReceived(peer), received);
    });
}

/** Apply one verified message here; never throws. */
async function applyOne(peer: Peer, envelope: Envelope): Promise<Receipt> {
    const id = envelope.id;
    const done = loadReceived(peer.name)[id];
    if (done !== undefined) return { id, status: "duplicate", stdout: done.stdout };
    if (!MESSAGE_KINDS.includes(envelope.kind as OutboxKind))
        return { id, status: "refused", reason: `${envelope.kind} is not a message`, stdout: "" };
    const claim = senderClaimRefusal(peer.name, envelope.kind, envelope.body);
    if (claim !== null) return { id, status: "refused", reason: claim, stdout: "" };
    if (
        envelope.kind === "inbox" &&
        listInbox().filter((item) => item.from === peer.name && item.unseen).length >= INBOX_CAP
    )
        return { id, status: "deferred", reason: `${INBOX_CAP} unread messages from ${peer.name} here`, stdout: "" };
    const argv = applyArgv(peer, envelope);
    markReceiving();
    const result = await runAsync([process.execPath, TOLI_SCRIPT, ...argv], {
        cwd: paths.root(),
        env: { TOLI_ROOT: paths.root() },
        stdin: envelope.body,
        timeoutMs: APPLY_TIMEOUT_MS,
    });
    markReceiving();
    if (result.code !== 0 || result.timedOut) {
        const why = result.timedOut ? "timed out" : `exited ${result.code}`;
        return {
            id,
            status: "failed",
            reason: `bin/toli ${argv.slice(0, 2).join(" ")} ${why}: ${(result.stderr || result.stdout).trim().split("\n")[0] ?? ""}`,
            stdout: "",
        };
    }
    recordReceived(peer.name, id, result.stdout);
    return { id, status: "applied", stdout: result.stdout };
}

/** A caller's limit on one verified envelope (the listener's rate limit): null admits it, else why it waits. */
export type Admit = (peer: Peer, envelope: Envelope) => string | null;

/**
 * Verify and apply a batch addressed to `self`, in order, one receipt each. A refused envelope gets its receipt and
 * the batch goes on; the first deferred or failed one stops it (the rest get no receipt and stay queued with their
 * sender, in order). `admit` may defer a verified envelope (a rate limit). More than five new items from one peer
 * also post one header item, so the lead sees one summarised wake.
 */
export async function applyBatch(values: unknown[], self: string, admit: Admit = () => null): Promise<Receipt[]> {
    const receipts: Receipt[] = [];
    const applied = new Map<string, { count: number; oldest: number }>();
    for (const value of values) {
        const verified = verifyEnvelope(value, self);
        if (!verified.ok) {
            const id = isJsonObject(value) && typeof value.id === "string" ? value.id : "";
            receipts.push({ id, status: "refused", reason: verified.reason, stdout: "", code: verified.code });
            continue;
        }
        const { peer, envelope } = verified;
        const wait = admit(peer, envelope);
        if (wait !== null) {
            receipts.push({ id: envelope.id, status: "deferred", reason: wait, stdout: "", code: 429 });
            break;
        }
        const receipt = await applyOne(peer, envelope);
        receipts.push(receipt);
        if (receipt.status === "applied") {
            const entry = applied.get(peer.name) ?? { count: 0, oldest: envelope.queuedAt };
            entry.count += 1;
            entry.oldest = Math.min(entry.oldest, envelope.queuedAt);
            applied.set(peer.name, entry);
        }
        if (receipt.status === "deferred" || receipt.status === "failed") break;
    }
    for (const [peer, { count, oldest }] of applied)
        if (count > BATCH_HEADER_OVER)
            addInboxItem(
                peer,
                `${count} queued messages from ${peer} arrived`,
                `${count} messages ${peer} queued for this machine arrived in one batch (the oldest waited ${waited(now().getTime() - oldest)}). They are the items just before this one in the inbox, in the order they were sent.`,
            );
    return receipts;
}

/** A duration in the largest whole unit: `3 min`, `5 h`, `2 d`. */
export function waited(ms: number): string {
    const minutes = Math.max(0, Math.round(ms / 60_000));
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}
