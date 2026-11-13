// The two ends of a relay (docs/peers.md "Relay"; the relay's own routes are src/peer/relay.ts): the sender hands its
// sealed items to the relay and settles them by the receipts its recipient signed; the recipient opens what the relay
// holds for it, applies each item as a message from its signer, and leaves each sender a sealed receipt bundle.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { isJsonObject, readJson, writeJsonAtomic } from "../core/util.ts";
import { cancelItems, itemsFor } from "../jobs/outbox-admin.ts";
import { type Answer, controlEnvelope, postPeer, recordStat, Unreachable } from "./client.ts";
import { type Flush, itemEnvelope, type OnDelivered } from "./deliver.ts";
import { applyBatch, type ControlKind, type Receipt, verifyEnvelope } from "./envelope.ts";
import { type Identity, loadIdentity } from "./identity.ts";
import { digestOf, type HeldKey, type RelayRequest } from "./relay.ts";
import { type Sealed, seal, sealedShape, unseal } from "./seal.ts";
import { MAX_BATCH } from "./server.ts";
import { activePeer, type Peer, peerByFingerprint, peerLog, pushable } from "./store.ts";

/** A sender's hold request stays under the listener's 512 KiB, with room for the signed wrapper. */
const HOLD_REQUEST_BYTES = 400 * 1024;

function sentFile(): string {
    return join(paths.peerRelayDir(), "sent.json");
}

/** The request body a relay route takes: `payload` with a control envelope of `kind` signed over its digest. */
function relayRequest(peer: Peer, kind: ControlKind, payload: unknown, identity: Identity): RelayRequest {
    return { envelope: controlEnvelope(peer, kind, { digest: digestOf(payload) }, identity), payload };
}

// The sender's side.

/** state/peer/relay/sent.json: per recipient, the ids its relay last said it holds (they are not sent again). */
type Sent = Record<string, string[]>;

/** Open a sealed receipt bundle a recipient left for this machine: the recipient and its receipts, or null. */
async function openReceipts(identity: Identity, sealed: Sealed): Promise<{ peer: Peer; receipts: Receipt[] } | null> {
    const plain = await unseal(identity, sealed);
    if (plain === null) return null;
    let value: unknown;
    try {
        value = JSON.parse(plain);
    } catch {
        return null;
    }
    const verified = verifyEnvelope(value, identity.fingerprint, true);
    if (!verified.ok || verified.envelope.kind !== "ack" || verified.peer.fingerprint !== sealed.fromKey) return null;
    let body: unknown;
    try {
        body = JSON.parse(verified.envelope.body);
    } catch {
        return null;
    }
    const receipts = isJsonObject(body) && Array.isArray(body.receipts) ? body.receipts : [];
    return { peer: verified.peer, receipts: receipts.filter(isJsonObject) as Receipt[] };
}

/** Settle this machine's items for `recipient` by the receipts it signed, as a direct delivery's receipts would. */
function settle(recipient: Peer, receipts: Receipt[], flush: Flush, onDelivered?: OnDelivered): void {
    const queued = new Map(itemsFor(recipient.name).map((entry) => [entry.file.replace(/\.json$/, ""), entry]));
    for (const receipt of receipts) {
        const entry = queued.get(String(receipt.id));
        if (entry === undefined) continue;
        if (recipient.name === flush.peer) flush.receipts.push(receipt);
        recordStat({
            peer: recipient.name,
            id: receipt.id,
            kind: entry.item.kind ?? "inbox",
            transport: "relay",
            ms: 0,
            outcome: receipt.status,
        });
        if (receipt.status === "refused") {
            cancelItems([entry.file], `${recipient.name} refused it: ${receipt.reason ?? "no reason"}`);
            continue;
        }
        if (receipt.status !== "applied" && receipt.status !== "duplicate") continue;
        rmSync(join(paths.outboxDir(), entry.file), { force: true });
        if (recipient.name === flush.peer) flush.sent += 1;
        try {
            onDelivered?.(entry.item, String(receipt.stdout ?? ""), entry.file);
        } catch (error) {
            flush.error = `${entry.file}: delivered, then ${error instanceof Error ? error.message : String(error)}`;
        }
    }
}

/**
 * Send what waits for `peer` (reached only through its relay, `peer.via`) to that relay, sealed for it, and settle
 * every item whose signed receipt the relay hands back. Items the relay already holds are not sent again.
 */
export async function flushRelayed(peer: Peer, onDelivered?: OnDelivered): Promise<Flush> {
    const flush: Flush = { peer: peer.name, sent: 0, receipts: [] };
    const relayName = peer.via ?? "";
    const relay = activePeer(relayName);
    if (relay === undefined || !pushable(relay)) {
        flush.unreachable = `its relay ${relayName} is not a paired peer this machine reaches`;
        return flush;
    }
    const identity = loadIdentity();
    const sent = readJson<Sent>(sentFile(), {});
    const known = new Set(sent[peer.name] ?? []);
    const items: Sealed[] = [];
    let bytes = 0;
    for (const { file, item } of itemsFor(peer.name)) {
        const id = file.replace(/\.json$/, "");
        if (known.has(id)) continue;
        const inner = itemEnvelope(peer, file, item);
        const sealed = await seal(
            { from: inner.from, fromKey: identity.fingerprint, to: peer.fingerprint, id, seq: inner.seq },
            peer.key,
            JSON.stringify(inner),
        );
        const size = Buffer.byteLength(JSON.stringify(sealed));
        if (items.length > 0 && (bytes + size > HOLD_REQUEST_BYTES || items.length >= MAX_BATCH)) break;
        items.push(sealed);
        bytes += size;
    }
    let answer: Answer;
    try {
        answer = await postPeer(
            relay,
            "/v1/relay/hold",
            relayRequest(relay, "relay", { to: peer.fingerprint, items }, identity),
        );
    } catch (error) {
        if (!(error instanceof Unreachable)) throw error;
        flush.unreachable = `relay ${relay.name}: ${error.message}`;
        return flush;
    }
    if (answer.status !== 200) {
        flush.error = `relay ${relay.name} answered ${answer.status}: ${String(answer.value.error ?? "")}`;
        return flush;
    }
    const refused = Array.isArray(answer.value.refused) ? answer.value.refused.filter(isJsonObject) : [];
    if (refused.length > 0)
        flush.error = `relay ${relay.name} refused ${refused.length}: ${refused.map((entry) => String(entry.reason)).join("; ")}`;
    for (const raw of Array.isArray(answer.value.receipts) ? answer.value.receipts : []) {
        const sealed = sealedShape(raw);
        const opened = sealed === null ? null : await openReceipts(identity, sealed);
        if (opened === null) {
            peerLog(`relay ${relay.name}: a receipt bundle did not open or verify; ignored`);
            continue;
        }
        settle(opened.peer, opened.receipts, flush, onDelivered);
    }
    const held = Array.isArray(answer.value.held) ? answer.value.held.filter((id) => typeof id === "string") : [];
    writeJsonAtomic(sentFile(), { ...readJson<Sent>(sentFile(), {}), [peer.name]: held } satisfies Sent);
    return flush;
}

// The recipient's side.

/** What one pull through a relay did. */
export type RelayedPull = { applied: number; waiting: number; dropped: number };

/** One opened item: its sender and the signed envelope inside, or why it is dropped. */
async function openItem(identity: Identity, sealed: Sealed): Promise<{ peer: Peer; envelope: unknown } | string> {
    if (sealed.to !== identity.fingerprint) return "not addressed to this machine";
    const plain = await unseal(identity, sealed);
    if (plain === null) return "it does not open (changed on the way, or not sealed for this key)";
    let value: unknown;
    try {
        value = JSON.parse(plain);
    } catch {
        return "its envelope is not JSON";
    }
    if (
        !isJsonObject(value) ||
        value.fromKey !== sealed.fromKey ||
        value.id !== sealed.id ||
        value.from !== sealed.from
    )
        return "its envelope does not match its header";
    const found = peerByFingerprint(sealed.fromKey);
    if (found === undefined || found.peer.status !== "active") return "";
    return { peer: found.peer, envelope: value };
}

/**
 * Apply what `relay` held for this machine, each sender's items in their order, as messages from their sender (its
 * signature checked against the key pinned here), then tell the relay which are settled and leave each sender one
 * signed receipt bundle, sealed for it. An item from a key not paired here stays held until `peer trust`; one that
 * does not open or verify is dropped.
 */
export async function applyRelayed(relay: Peer, values: unknown[]): Promise<RelayedPull> {
    const identity = loadIdentity();
    const result: RelayedPull = { applied: 0, waiting: 0, dropped: 0 };
    const done: HeldKey[] = [];
    const bySender = new Map<string, { peer: Peer; items: Array<{ key: HeldKey; envelope: unknown }> }>();
    for (const raw of values) {
        const sealed = sealedShape(raw);
        if (sealed === null) continue;
        const key = { fromKey: sealed.fromKey, id: sealed.id };
        const opened = await openItem(identity, sealed);
        if (opened === "") {
            result.waiting += 1;
            continue;
        }
        if (typeof opened === "string") {
            peerLog(`relay ${relay.name}: dropped ${sealed.id} said to be from ${sealed.from}: ${opened}`);
            done.push(key);
            result.dropped += 1;
            continue;
        }
        const group = bySender.get(opened.peer.name) ?? { peer: opened.peer, items: [] };
        group.items.push({ key, envelope: opened.envelope });
        bySender.set(opened.peer.name, group);
    }
    const bundles: Sealed[] = [];
    for (const { peer, items } of bySender.values()) {
        const receipts = await applyBatch(
            items.map((item) => item.envelope),
            identity.fingerprint,
            () => null,
            true,
        );
        for (const [index, receipt] of receipts.entries()) {
            const item = items[index];
            if (item === undefined) continue;
            if (receipt.status === "applied") result.applied += 1;
            if (receipt.status === "applied" || receipt.status === "duplicate" || receipt.status === "refused")
                done.push(item.key);
        }
        if (receipts.length === 0) continue;
        const ack = controlEnvelope(peer, "ack", { receipts }, identity);
        bundles.push(
            await seal(
                {
                    from: loadMachine().name,
                    fromKey: identity.fingerprint,
                    to: peer.fingerprint,
                    id: ack.id,
                    seq: ack.seq,
                },
                peer.key,
                JSON.stringify(ack),
            ),
        );
    }
    if (done.length > 0 || bundles.length > 0) {
        const answer = await postPeer(
            relay,
            "/v1/relay/ack",
            relayRequest(relay, "relay-ack", { done, receipts: bundles }, identity),
        );
        if (answer.status !== 200)
            throw new Error(`relay ack: ${relay.name} answered ${answer.status}: ${String(answer.value.error ?? "")}`);
    }
    return result;
}
