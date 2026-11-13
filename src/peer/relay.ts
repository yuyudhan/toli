// Relay (docs/peers.md "Relay"): two paired machines that both refuse inbound connections (a laptop that takes no
// inbound ssh and runs no listener, a coordinator behind a firewall) exchange messages through a third peer both can
// reach. Each item travels as the signed envelope HTTPS delivery would send, sealed for its recipient
// (src/peer/seal.ts), so the relay routes it without reading or changing it:
//
//   sender    POST /v1/relay/hold   its sealed items for one recipient; the answer says which the relay holds and
//                                   carries the sealed receipts recipients left for this sender
//   recipient POST /v1/outbox/pending  the relay adds `relayed`: the sealed items held for it (src/peer/deliver.ts)
//   recipient POST /v1/relay/ack    which held items it settled, and one sealed receipt bundle per sender
//
// The recipient opens each item, checks the signature against the sender's pinned key (`peer trust`), and applies it
// as a message from that sender; the relay's word counts for nothing. The sender drops an item only on a receipt its
// recipient signed. An item is held at most once per sender and id; a relay that drops one only delays it (the sender
// holds it again once the relay no longer lists it), and a replayed one is a duplicate.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../core/paths.ts";
import { isJsonObject, writeJsonAtomic } from "../core/util.ts";
import { type ControlKind, type Envelope, verifyEnvelope } from "./envelope.ts";
import { canonicalJson, sha256Hex } from "./identity.ts";
import { type Sealed, sealedShape } from "./seal.ts";
import { json, type ListenerContext, MAX_BATCH, readBody, routes } from "./server.ts";
import { type Peer, peerByFingerprint, peerLog } from "./store.ts";

/** Items a relay holds for one recipient, and their bytes; past either, it refuses more until that one pulls. */
const HELD_MAX = 500;
const HELD_MAX_BYTES = 64 * 1024 * 1024;
/** What one pull takes from a relay at most (at least one item). */
const PENDING_BYTES = 4 * 1024 * 1024;

/** What a relay request carries: a signed control envelope whose body is the payload's digest, and the payload. */
export type RelayRequest = { envelope: Envelope; payload: unknown };

/** A held item's key in a recipient's queue: its sender's fingerprint and its id. */
export type HeldKey = { fromKey: string; id: string };

function heldDir(recipient: string): string {
    return join(paths.peerRelayDir(), "held", recipient);
}

function receiptsDir(sender: string): string {
    return join(paths.peerRelayDir(), "receipts", sender);
}

function heldFile(key: HeldKey): string {
    return `${key.fromKey.slice(0, 16)}-${key.id}.json`;
}

export function digestOf(payload: unknown): string {
    return sha256Hex(canonicalJson(payload));
}

/** Verify a relay request from a peer: its signed envelope of `kind`, and the payload that digest names. */
async function readRelayRequest(
    request: Request,
    context: ListenerContext,
    kind: ControlKind,
): Promise<{ peer: Peer; payload: Record<string, unknown> } | Response> {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    if (!isJsonObject(body) || !isJsonObject(body.payload)) return json({ error: "expected {envelope, payload}" }, 400);
    const verified = verifyEnvelope(body.envelope, context.identity.fingerprint);
    if (!verified.ok) return json({ error: verified.reason }, verified.code);
    if (verified.envelope.kind !== kind) return json({ error: `expected a ${kind} envelope` }, 400);
    let signed: unknown;
    try {
        signed = JSON.parse(verified.envelope.body);
    } catch {
        signed = null;
    }
    if (!isJsonObject(signed) || signed.digest !== digestOf(body.payload))
        return json({ error: "the payload does not match the signed digest" }, 400);
    return { peer: verified.peer, payload: body.payload };
}

function sealedList(value: unknown): Sealed[] | null {
    if (!Array.isArray(value)) return null;
    const sealed = value.map(sealedShape);
    return sealed.every((entry) => entry !== null) ? (sealed as Sealed[]) : null;
}

function filesIn(dir: string): string[] {
    return existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".json")) : [];
}

function readSealed(file: string): Sealed | null {
    try {
        return sealedShape(JSON.parse(readFileSync(file, "utf8")));
    } catch {
        return null;
    }
}

// The relay's side.

/** Why the relay will not hold `item` from `sender` (null: it holds it). */
function holdRefusal(sender: Peer, item: Sealed, recipient: string): string | null {
    if (item.fromKey !== sender.fingerprint || item.from !== sender.name) return "a sender holds only its own items";
    if (item.to !== recipient) return "every item in one request goes to the same recipient";
    if (peerByFingerprint(item.to)?.peer.status !== "active") return "the recipient is not a paired peer of this relay";
    const dir = heldDir(item.to);
    const files = filesIn(dir);
    if (files.includes(heldFile(item))) return null;
    const bytes = files.reduce((sum, file) => sum + statSync(join(dir, file)).size, 0);
    if (files.length >= HELD_MAX || bytes >= HELD_MAX_BYTES) return "the relay holds too much for that recipient";
    return null;
}

/** The ids of `sender`'s items held here for `recipient`. */
function heldFrom(sender: string, recipient: string): string[] {
    const dir = heldDir(recipient);
    return filesIn(dir).flatMap((file) => {
        const sealed = readSealed(join(dir, file));
        return sealed !== null && sealed.fromKey === sender ? [sealed.id] : [];
    });
}

routes.set("POST /v1/relay/hold", async (request, context) => {
    const read = await readRelayRequest(request, context, "relay");
    if (read instanceof Response) return read;
    const { peer, payload } = read;
    const items = sealedList(payload.items);
    if (items === null || typeof payload.to !== "string") return json({ error: "expected {to, items}" }, 400);
    const refused: Array<{ id: string; reason: string }> = [];
    for (const item of items) {
        const why = holdRefusal(peer, item, payload.to);
        if (why !== null) {
            refused.push({ id: item.id, reason: why });
            continue;
        }
        mkdirSync(heldDir(item.to), { recursive: true });
        writeJsonAtomic(join(heldDir(item.to), heldFile(item)), item);
    }
    if (items.length > refused.length)
        peerLog(
            `relay: holding ${items.length - refused.length} item(s) from ${peer.name} for ${payload.to.slice(0, 16)}`,
        );
    // The receipts recipients left for this sender go back now; one lost on the way costs only a re-hold, which its
    // recipient answers as a duplicate with the same receipt.
    const dir = receiptsDir(peer.fingerprint);
    const receipts = filesIn(dir).flatMap((file) => {
        const sealed = readSealed(join(dir, file));
        rmSync(join(dir, file), { force: true });
        return sealed === null ? [] : [sealed];
    });
    return json({ held: heldFrom(peer.fingerprint, payload.to), refused, receipts });
});

/** What waits here for `recipient` (its fingerprint), oldest first by each sender's order, up to PENDING_BYTES. */
export function heldFor(recipient: string): Sealed[] {
    const dir = heldDir(recipient);
    const held = filesIn(dir)
        .map((file) => ({ file, sealed: readSealed(join(dir, file)) }))
        .filter((entry): entry is { file: string; sealed: Sealed } => entry.sealed !== null)
        .sort((a, b) => a.sealed.seq - b.sealed.seq || a.file.localeCompare(b.file));
    const taken: Sealed[] = [];
    let bytes = 0;
    for (const { file, sealed } of held) {
        const size = statSync(join(dir, file)).size;
        if (taken.length > 0 && (bytes + size > PENDING_BYTES || taken.length >= MAX_BATCH)) break;
        taken.push(sealed);
        bytes += size;
    }
    return taken;
}

function heldKeys(value: unknown): HeldKey[] | null {
    if (!Array.isArray(value)) return null;
    const keys = value.filter(
        (entry): entry is HeldKey =>
            isJsonObject(entry) &&
            typeof entry.fromKey === "string" &&
            /^[0-9a-f]{64}$/.test(entry.fromKey) &&
            typeof entry.id === "string" &&
            /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(entry.id),
    );
    return keys.length === value.length ? keys : null;
}

routes.set("POST /v1/relay/ack", async (request, context) => {
    const read = await readRelayRequest(request, context, "relay-ack");
    if (read instanceof Response) return read;
    const { peer, payload } = read;
    const done = heldKeys(payload.done);
    const receipts = sealedList(payload.receipts);
    if (done === null || receipts === null) return json({ error: "expected {done, receipts}" }, 400);
    // Only the recipient settles its own queue.
    for (const key of done) rmSync(join(heldDir(peer.fingerprint), heldFile(key)), { force: true });
    let stored = 0;
    for (const receipt of receipts) {
        if (receipt.fromKey !== peer.fingerprint || receipt.from !== peer.name) continue;
        if (peerByFingerprint(receipt.to)?.peer.status !== "active") continue;
        mkdirSync(receiptsDir(receipt.to), { recursive: true });
        writeJsonAtomic(join(receiptsDir(receipt.to), heldFile(receipt)), receipt);
        stored += 1;
    }
    return json({ removed: done.length, stored });
});
