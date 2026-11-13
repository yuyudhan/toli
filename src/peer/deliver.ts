// Delivery to paired peers over HTTPS (docs/peers.md "Delivery"): the outbox's items for a peer go out in order, in
// batches of up to 50 signed envelopes, and each receipt settles its item: applied or duplicate removes it (a
// delegation's answer is then recorded, as over ssh), refused moves it to state/outbox/cancelled/ with the reason,
// deferred or failed keeps it and everything after it queued. A peer that comes back announces itself, and what
// waits for it goes out at once. A peer without a listener pulls instead (`/v1/outbox/pending` and `/ack`).
//
// The listener's routes for these live here too: announce, status, pending, ack and rotate (relay routes: relay.ts).
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { isJsonObject, now, runAsync, warn } from "../core/util.ts";
import type { OutboxItem, Queued } from "../jobs/outbox.ts";
import { cancelItems, itemsFor } from "../jobs/outbox-admin.ts";
import { notePuller } from "../jobs/pull.ts";
import { controlEnvelope, postPeer, recordStat, Unreachable } from "./client.ts";
import { type Envelope, type Receipt, sealEnvelope } from "./envelope.ts";
import { certSigValid, fingerprintOf, initIdentity, loadIdentity } from "./identity.ts";
import { heldFor } from "./relay.ts";
import { flushRelayed } from "./relay-client.ts";
import { controlRequest, json, type ListenerContext, MAX_BATCH, onBound, readControl, routes } from "./server.ts";
import { activePeer, loadPeers, type Peer, peerLog, pushable, updatePeers } from "./store.ts";

/** What one flush did for one peer. */
export type Flush = {
    peer: string;
    sent: number;
    receipts: Receipt[];
    /** Set when no address answered: the items stay queued (and may go over ssh, or wait for a pull). */
    unreachable?: string;
    error?: string;
};

/** How a delivered item's receipt reaches its sender's own bookkeeping (a delegation's answer). */
export type OnDelivered = (item: OutboxItem, stdout: string, file: string) => void;

/** The envelope an outbox item travels as: its id is the file name, signed fresh on every attempt. */
export function itemEnvelope(peer: Peer, file: string, item: OutboxItem): Envelope {
    const queuedAt = item.queuedAt ?? now().getTime();
    return sealEnvelope(loadIdentity(), {
        id: file.replace(/\.json$/, ""),
        seq: queuedAt,
        from: loadMachine().name,
        to: peer.fingerprint,
        kind: item.kind ?? "inbox",
        title: item.title,
        body: item.body,
        queuedAt,
    });
}

type Claimed = Queued & { claimed: string };

/** Claim the peer's queued items, oldest first, up to MAX_BATCH (a rename, so nothing sends one twice). */
function claimFor(peer: Peer): Claimed[] {
    const dir = paths.outboxDir();
    const claimed: Claimed[] = [];
    for (const queued of itemsFor(peer.name)) {
        if (claimed.length >= MAX_BATCH) break;
        const path = join(dir, `${queued.file}.sending-${process.pid}`);
        try {
            renameSync(join(dir, queued.file), path);
        } catch {
            break;
        }
        claimed.push({ ...queued, claimed: path });
    }
    return claimed;
}

function release(items: Claimed[]): void {
    for (const { file, claimed } of items) {
        try {
            renameSync(claimed, join(paths.outboxDir(), file));
        } catch (error) {
            warn(`outbox: could not release ${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

/**
 * Send what waits for `peer`, batch after batch, until the queue is empty or a batch stops (unreachable, deferred,
 * failed). `onDelivered` sees every applied or duplicate item and what the receiver printed. A peer with no address
 * and a relay (`via`) gets its items through that relay instead (src/peer/relay.ts).
 */
export async function flushPeer(peer: Peer, onDelivered?: OnDelivered): Promise<Flush> {
    if (!pushable(peer) && peer.via !== undefined) return await flushRelayed(peer, onDelivered);
    const flush: Flush = { peer: peer.name, sent: 0, receipts: [] };
    for (;;) {
        const batch = claimFor(peer);
        if (batch.length === 0) return flush;
        const envelopes = batch.map(({ file, item }) => itemEnvelope(peer, file, item));
        let answer: Awaited<ReturnType<typeof postPeer>>;
        try {
            answer = await postPeer(peer, "/v1/messages", { envelopes });
        } catch (error) {
            release(batch);
            if (!(error instanceof Unreachable)) throw error;
            flush.unreachable = error.message;
            return flush;
        }
        const receipts = Array.isArray(answer.value.receipts) ? (answer.value.receipts as Receipt[]) : [];
        const byId = new Map(receipts.map((receipt) => [receipt.id, receipt]));
        const refused: string[] = [];
        let stopped = receipts.length === 0;
        const each = Math.round(answer.ms / batch.length);
        for (const [index, queued] of batch.entries()) {
            const receipt = byId.get(envelopes[index]?.id ?? "");
            if (stopped || receipt === undefined || receipt.status === "deferred" || receipt.status === "failed") {
                stopped = true;
                release([queued]);
                if (receipt !== undefined) flush.receipts.push(receipt);
                continue;
            }
            flush.receipts.push(receipt);
            recordStat({
                peer: peer.name,
                id: receipt.id,
                kind: queued.item.kind ?? "inbox",
                transport: "https",
                ms: each,
                outcome: receipt.status,
            });
            if (receipt.status === "refused") {
                renameSync(queued.claimed, join(paths.outboxDir(), queued.file));
                refused.push(queued.file);
                continue;
            }
            rmSync(queued.claimed, { force: true });
            flush.sent += 1;
            try {
                onDelivered?.(queued.item, receipt.stdout, queued.file);
            } catch (error) {
                flush.error = `${queued.file}: delivered, then ${error instanceof Error ? error.message : String(error)}`;
            }
        }
        if (refused.length > 0) {
            const reasons = [...new Set(flush.receipts.filter((r) => r.status === "refused").map((r) => r.reason))];
            cancelItems(refused, `${peer.name} refused: ${reasons.join("; ")}`);
        }
        if (answer.status !== 200 && receipts.length === 0) {
            flush.error = `${peer.name} answered ${answer.status}: ${String(answer.value.error ?? "")}`;
            return flush;
        }
        if (stopped) return flush;
    }
}

/** Every active peer with something queued for it, flushed one after another (directly, or through its relay). */
export async function flushAll(onDelivered?: OnDelivered): Promise<Flush[]> {
    const flushes: Flush[] = [];
    for (const peer of loadPeers().filter(
        (entry) => entry.status === "active" && (pushable(entry) || entry.via !== undefined),
    ))
        if (itemsFor(peer.name).length > 0) flushes.push(await flushPeer(peer, onDelivered));
    return flushes;
}

/** The delegate's hook, loaded lazily: src/fleet/delegate.ts imports the outbox, which may load this module. */
export async function delegationHook(): Promise<OnDelivered> {
    const { onOutboxDelivered } = await import("../fleet/delegate.ts");
    return (item, stdout) => onOutboxDelivered({ item, stdout });
}

// Announce: this machine is (back) on these addresses; the peer sends what waits for it here.

async function announceAll(context: ListenerContext, addrs: string[]): Promise<void> {
    for (const peer of loadPeers().filter(pushable)) {
        try {
            const answer = await postPeer(
                peer,
                "/v1/announce",
                controlEnvelope(peer, "announce", { addrs, version: context.version }),
            );
            if (answer.status !== 200)
                peerLog(`announce to ${peer.name}: ${answer.status} ${String(answer.value.error ?? "")}`);
        } catch (error) {
            peerLog(`announce to ${peer.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

onBound.push((context, addrs) => {
    if (addrs.length > 0) void announceAll(context, addrs);
});

function parsed(envelope: Envelope): Record<string, unknown> {
    try {
        const value: unknown = JSON.parse(envelope.body);
        return isJsonObject(value) ? value : {};
    } catch {
        return {};
    }
}

routes.set("POST /v1/announce", async (request, context) => {
    const control = await readControl(request, context, "announce");
    if (control instanceof Response) return control;
    const body = parsed(control.envelope);
    const addrs = Array.isArray(body.addrs) ? body.addrs.filter((addr) => typeof addr === "string").slice(0, 8) : [];
    if (addrs.length > 0)
        updatePeers((peers) => {
            const peer = peers.find((entry) => entry.name === control.peer.name);
            if (peer !== undefined) peer.addrs = [...new Set([...(addrs as string[]), ...peer.addrs])].slice(0, 8);
        });
    const peer = activePeer(control.peer.name);
    peerLog(`${control.peer.name} announced ${addrs.join(", ") || "no address"}`);
    // Deliver what waits for it, without holding up its request.
    if (peer !== undefined && itemsFor(peer.name).length > 0)
        void delegationHook()
            .then((hook) => flushPeer(peer, hook))
            .then((flush) =>
                peerLog(
                    `after ${peer.name}'s announce: sent ${flush.sent}${flush.unreachable ? `, unreachable: ${flush.unreachable}` : ""}`,
                ),
            )
            .catch((error) =>
                peerLog(`after ${peer.name}'s announce: ${error instanceof Error ? error.message : String(error)}`),
            );
    return json({ ok: true, waiting: peer === undefined ? 0 : itemsFor(peer.name).length });
});

// Status: what `bin/toli resources --json` reports here, for a peer allowed `status`.

routes.set("POST /v1/status", async (request, context) => {
    const control = await readControl(request, context, "status");
    if (control instanceof Response) return control;
    const result = await runAsync([process.execPath, paths.codeBin(), "resources", "--json"], {
        cwd: paths.root(),
        env: { TOLI_ROOT: paths.root() },
        timeoutMs: 60_000,
    });
    if (result.code !== 0) return json({ error: `resources exited ${result.code}` }, 500);
    return new Response(result.stdout, { headers: { "content-type": "application/json" } });
});

/** `bin/toli peer ask <peer> status`: that machine's `resources --json`, over HTTPS. */
export async function askStatus(peer: Peer): Promise<{ value: Record<string, unknown>; ms: number }> {
    const answer = await postPeer(peer, "/v1/status", controlEnvelope(peer, "status", {}));
    recordStat({
        peer: peer.name,
        id: "status",
        kind: "status",
        transport: "https",
        ms: answer.ms,
        outcome: String(answer.status),
    });
    if (answer.status !== 200)
        throw new Error(`${peer.name} answered ${answer.status}: ${String(answer.value.error ?? "")}`);
    return { value: answer.value, ms: answer.ms };
}

// Pull: a peer without a listener asks for what waits for it here, applies it, then acknowledges the receipts.

routes.set("POST /v1/outbox/pending", async (request, context) => {
    const control = await readControl(request, context, "pending");
    if (control instanceof Response) return control;
    const peer = control.peer;
    notePuller(peer.name);
    const pulling = parsed(control.envelope).inbound === false;
    if ((peer.inbound === false) !== pulling)
        updatePeers((peers) => {
            const entry = peers.find((candidate) => candidate.name === peer.name);
            if (entry === undefined) return;
            if (pulling) entry.inbound = false;
            else delete entry.inbound;
        });
    const envelopes = itemsFor(peer.name)
        .slice(0, MAX_BATCH)
        .map(({ file, item }) => itemEnvelope(peer, file, item));
    // What this machine holds for it as a relay, sealed by other peers (src/peer/relay.ts).
    return json({ envelopes, relayed: heldFor(peer.fingerprint) });
});

routes.set("POST /v1/outbox/ack", async (request, context) => {
    const control = await readControl(request, context, "ack");
    if (control instanceof Response) return control;
    const body = parsed(control.envelope);
    const receipts = Array.isArray(body.receipts) ? (body.receipts as Receipt[]) : [];
    const hook = await delegationHook();
    const queued = new Map(itemsFor(control.peer.name).map((entry) => [entry.file.replace(/\.json$/, ""), entry]));
    const refused: string[] = [];
    let acked = 0;
    for (const receipt of receipts) {
        const entry = isJsonObject(receipt) ? queued.get(String(receipt.id)) : undefined;
        if (entry === undefined) continue;
        if (receipt.status === "refused") {
            refused.push(entry.file);
            continue;
        }
        if (receipt.status !== "applied" && receipt.status !== "duplicate") continue;
        const path = join(paths.outboxDir(), entry.file);
        const claimed = `${path}.acking-${process.pid}`;
        try {
            renameSync(path, claimed);
        } catch {
            continue;
        }
        rmSync(claimed, { force: true });
        acked += 1;
        recordStat({
            peer: control.peer.name,
            id: String(receipt.id),
            kind: entry.item.kind ?? "inbox",
            transport: "https",
            ms: 0,
            outcome: `pulled ${receipt.status}`,
        });
        try {
            hook(entry.item, String(receipt.stdout ?? ""), entry.file);
        } catch (error) {
            warn(`outbox: ${entry.file} pulled, then ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (refused.length > 0) cancelItems(refused, `${control.peer.name} refused them`);
    return json({ acked, cancelled: refused.length });
});

// Rotate: a new key and certificate, announced to every peer signed by the old key; they accept the old one for a
// week more (src/peer/store.ts `prevKey`), so messages already on their way still verify.

const ROTATE_GRACE_MS = 7 * 24 * 60 * 60_000;

routes.set("POST /v1/rotate", async (request, context) => {
    const control = await readControl(request, context, "rotate");
    if (control instanceof Response) return control;
    const body = parsed(control.envelope);
    const { key, cert, certSig } = body;
    if (typeof key !== "string" || typeof cert !== "string" || typeof certSig !== "string")
        return json({ error: "expected {key, cert, certSig}" }, 400);
    if (!certSigValid(key, cert, certSig))
        return json({ error: "the new key does not vouch for the certificate" }, 400);
    updatePeers((peers) => {
        const peer = peers.find((entry) => entry.name === control.peer.name);
        if (peer === undefined) return;
        peer.prevKey = peer.key;
        peer.prevKeyUntil = new Date(now().getTime() + ROTATE_GRACE_MS).toISOString();
        peer.key = key;
        peer.fingerprint = fingerprintOf(key);
        peer.cert = cert;
        peer.certSig = certSig;
    });
    peerLog(`${control.peer.name} rotated its key to ${fingerprintOf(key)}`);
    return json({ ok: true });
});

/**
 * `peer rotate`: make a new key and certificate here, then tell every active peer, signed by the old key. Returns the
 * peers told and those that could not be (they must pair again). The listener restarts on the new certificate.
 */
export async function rotateIdentity(): Promise<{ told: string[]; missed: string[] }> {
    const old = loadIdentity();
    initIdentity({ rotate: true });
    const fresh = loadIdentity();
    const told: string[] = [];
    const missed: string[] = [];
    for (const peer of loadPeers().filter((entry) => entry.status === "active")) {
        const envelope = controlEnvelope(
            peer,
            "rotate",
            { key: fresh.key, cert: fresh.certPem, certSig: fresh.certSig },
            old,
        );
        try {
            const answer = await postPeer(peer, "/v1/rotate", envelope);
            (answer.status === 200 ? told : missed).push(peer.name);
        } catch {
            missed.push(peer.name);
        }
    }
    peerLog(`rotated this machine's key to ${fresh.fingerprint}; told ${told.join(", ") || "nobody"}`);
    await controlRequest("/stop");
    return { told, missed };
}
