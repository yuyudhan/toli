// Pairing with a 4-digit code (docs/peers.md "Pairing"). The code is shown on the receiving machine (B) and entered
// on the requesting one (A); either side's owner or Sardar runs its step, and nothing pairs without both acting.
//
//   A  peer add <host>               hello (B's keys, certificate pinned for this exchange), then a signed request
//   B  (inbox item)                  "pairing request from A at <ip>, fingerprint ...": no code in it
//   B  peer accept <reqId> --why     the listener mints the code: 4 digits, in its memory only, 120 s, one use
//   A  peer add <host> --code NNNN   CPace with the code over both keys and certificates (src/peer/cpace.ts):
//                                    /pair/start swaps shares, /pair/finish swaps key-confirmation tags; both pin
//
// A code allows 3 wrong tries; the third kills its request, tells B's lead, and holds that source for an hour. A
// source may ask 3 times an hour and 10 a day, and at most 5 requests wait at once. An expired code kills its
// request. The code is never written to disk or logged.
import { randomBytes, randomInt } from "node:crypto";
import type { Server } from "bun";
import { loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { isJsonObject, isValidName, now, readJson, ToliError, withLock, writeJsonAtomic } from "../core/util.ts";
import { addInboxItem } from "../records/inbox.ts";
import { confirmTag, cpaceFinish, cpaceShare, type PairInputs, tagsEqual } from "./cpace.ts";
import {
    canonicalJson,
    certFingerprintOf,
    certSigValid,
    fingerprintOf,
    type Identity,
    signWith,
    verifySignature,
} from "./identity.ts";
import { controlRequest, controlRoutes, json, readBody, routes } from "./server.ts";
import { type Actor, PERMISSIONS, type Peer, peerLog, updatePeers } from "./store.ts";

export const REQUEST_KEEP_MS = 24 * 60 * 60_000;
const MAX_PENDING = 5;
const TRIES = 3;
const HOLD_MS = 60 * 60_000;
const PER_HOUR = 3;
const PER_DAY = 10;

function codeTtlMs(): number {
    const raw = Number(process.env.TOLI_PEER_CODE_TTL_MS ?? 120_000);
    return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

/** What B keeps of a request until it is accepted and paired, or dies (state/peer/requests.json). No code. */
export type PairRequest = {
    reqId: string;
    name: string;
    key: string;
    fingerprint: string;
    cert: string;
    certSig: string;
    addrs: string[];
    version: string;
    source: string;
    receivedAt: number;
};

type Limits = Record<string, { asked: number[]; holdUntil?: number }>;

/** A signed pairing body: the fields, plus `sentAt`, `nonce` and the sender key's `sig` over the canonical JSON. */
export function signed(identity: Identity, fields: Record<string, unknown>): Record<string, unknown> {
    const unsigned = { ...fields, sentAt: now().getTime(), nonce: randomBytes(16).toString("base64") };
    return { ...unsigned, sig: signWith(identity.privateKey, canonicalJson(unsigned)) };
}

function signatureValid(key: string, body: Record<string, unknown>): boolean {
    const { sig, ...unsigned } = body;
    return typeof sig === "string" && verifySignature(key, canonicalJson(unsigned), sig);
}

export function loadRequests(): PairRequest[] {
    const cutoff = now().getTime() - REQUEST_KEEP_MS;
    return readJson<PairRequest[]>(paths.peerRequests(), []).filter((request) => request.receivedAt >= cutoff);
}

function updateRequests<T>(change: (requests: PairRequest[]) => T): T {
    return withLock(paths.lock("peer-requests"), () => {
        const requests = loadRequests();
        const result = change(requests);
        writeJsonAtomic(paths.peerRequests(), requests);
        return result;
    });
}

function dropRequest(reqId: string): void {
    updateRequests((requests) => {
        const index = requests.findIndex((request) => request.reqId === reqId);
        if (index >= 0) requests.splice(index, 1);
    });
}

/** Count one request from `source`; null when it may ask, else why not (held, or over 3 an hour / 10 a day). */
function takeRequestSlot(source: string): string | null {
    return withLock(paths.lock("peer-limits"), () => {
        const at = now().getTime();
        const limits = readJson<Limits>(paths.peerLimits(), {});
        const entry = limits[source] ?? { asked: [] };
        entry.asked = entry.asked.filter((when) => at - when < 24 * 60 * 60_000);
        let refusal: string | null = null;
        if (entry.holdUntil !== undefined && entry.holdUntil > at)
            refusal = `held after 3 wrong codes; ask again after ${new Date(entry.holdUntil).toISOString()}`;
        else if (entry.asked.filter((when) => at - when < 60 * 60_000).length >= PER_HOUR)
            refusal = `at most ${PER_HOUR} pairing requests an hour from one address`;
        else if (entry.asked.length >= PER_DAY) refusal = `at most ${PER_DAY} pairing requests a day from one address`;
        if (refusal === null) entry.asked.push(at);
        limits[source] = entry;
        writeJsonAtomic(paths.peerLimits(), limits);
        return refusal;
    });
}

function holdSource(source: string): void {
    withLock(paths.lock("peer-limits"), () => {
        const limits = readJson<Limits>(paths.peerLimits(), {});
        limits[source] = { asked: limits[source]?.asked ?? [], holdUntil: now().getTime() + HOLD_MS };
        writeJsonAtomic(paths.peerLimits(), limits);
    });
}

/** Pin `peer` (replacing a revoked or same-key entry of that name). */
export function pin(peer: Peer): void {
    updatePeers((peers) => {
        const index = peers.findIndex((entry) => entry.name === peer.name);
        if (index >= 0) peers.splice(index, 1);
        peers.push(peer);
    });
}

export function newPeer(
    fields: { name: string; key: string; cert: string; certSig: string; addrs: string[]; version: string },
    by: string,
): Peer {
    return {
        ...fields,
        fingerprint: fingerprintOf(fields.key),
        allow: [...PERMISSIONS],
        pairedAt: now().toISOString(),
        pairedBy: by,
        status: "active",
    };
}

function requestInputs(request: PairRequest, identity: Identity, self: string): PairInputs {
    return {
        reqId: request.reqId,
        nameA: request.name,
        nameB: self,
        keyA: request.key,
        keyB: identity.key,
        certFpA: certFingerprintOf(request.cert),
        certFpB: identity.certFingerprint,
    };
}

// B's side: the listener's routes. Codes and sessions live only in this process's memory.

type Live = {
    code: string;
    expiresAt: number;
    tries: number;
    by: string;
    session?: { key: Buffer; transcript: Buffer };
};
const live = new Map<string, Live>();

function source(request: Request, server: Server<undefined>): string {
    return server.requestIP(request)?.address ?? "unknown";
}

function kill(request: PairRequest, why: string): void {
    live.delete(request.reqId);
    dropRequest(request.reqId);
    peerLog(`pairing request ${request.reqId} from ${request.name} (${request.source}) died: ${why}`);
    addInboxItem(
        loadMachine().name,
        `pairing request from ${request.name} died`,
        `The pairing request ${request.reqId} from ${request.name} at ${request.source} (fingerprint ${request.fingerprint}) died: ${why}. Nothing was paired.`,
    );
}

/** The request a start or finish names, verified by its own key, with its live code; or the refusal. */
async function liveRequest(
    httpRequest: Request,
): Promise<{ request: PairRequest; entry: Live; body: Record<string, unknown> } | Response> {
    const body = await readBody(httpRequest);
    if (body instanceof Response) return body;
    if (!isJsonObject(body) || typeof body.reqId !== "string") return json({ error: "expected {reqId, ...}" }, 400);
    const request = loadRequests().find((entry) => entry.reqId === body.reqId);
    if (request === undefined) return json({ error: "no such pairing request here (it died, or was never made)" }, 404);
    if (
        !signatureValid(request.key, body) ||
        typeof body.sentAt !== "number" ||
        Math.abs(now().getTime() - body.sentAt) > 300_000
    )
        return json({ error: "bad signature" }, 401);
    const entry = live.get(request.reqId);
    if (entry === undefined)
        return json({ error: "no code yet: ask the owner or Sardar there to run bin/toli peer accept" }, 409);
    if (now().getTime() > entry.expiresAt) {
        kill(request, "its code expired before it was used");
        return json({ error: "the code expired; ask for a new pairing request" }, 410);
    }
    return { request, entry, body };
}

routes.set("POST /v1/pair/request", async (httpRequest, context, server) => {
    const body = await readBody(httpRequest);
    if (body instanceof Response) return body;
    if (!isJsonObject(body)) return json({ error: "expected a JSON object" }, 400);
    const { reqId, name, key, cert, certSig, addrs, version } = body;
    if (
        typeof reqId !== "string" ||
        !/^[0-9a-f]{16}$/.test(reqId) ||
        typeof name !== "string" ||
        !isValidName(name) ||
        typeof key !== "string" ||
        typeof cert !== "string" ||
        typeof certSig !== "string" ||
        !Array.isArray(addrs) ||
        !addrs.every((addr) => typeof addr === "string")
    )
        return json({ error: "malformed pairing request" }, 400);
    if (!signatureValid(key, body) || !certSigValid(key, cert, certSig)) return json({ error: "bad signature" }, 401);
    if (key === context.identity.key) return json({ error: "that is this machine" }, 400);
    const from = source(httpRequest, server);
    const refusal = takeRequestSlot(from);
    if (refusal !== null) return json({ error: refusal }, 429);
    const pending = loadRequests();
    if (pending.some((request) => request.reqId === reqId)) return json({ error: "duplicate request id" }, 409);
    if (pending.length >= MAX_PENDING) return json({ error: `${MAX_PENDING} pairing requests already wait here` }, 429);
    const request: PairRequest = {
        reqId,
        name,
        key,
        fingerprint: fingerprintOf(key),
        cert,
        certSig,
        addrs: addrs.slice(0, 8) as string[],
        version: typeof version === "string" ? version : "unknown",
        source: from,
        receivedAt: now().getTime(),
    };
    updateRequests((requests) => requests.push(request));
    peerLog(`pairing request ${reqId} from ${name} at ${from}, fingerprint ${request.fingerprint}`);
    addInboxItem(
        context.name,
        `pairing request from ${name}`,
        [
            `${name} at ${from} asks to pair with this machine (request ${reqId}).`,
            `Its fingerprint: ${request.fingerprint}`,
            "",
            "Pairing lets it message this lead, delegate tasks, share learnings, answer the tasks it delegates and read",
            "this machine's status. Accept only a machine you know, after checking its fingerprint with its owner:",
            `\`bin/toli peer accept ${reqId} --why "<why>"\` prints a 4-digit code (valid 2 minutes) to read to them.`,
            `Decline: \`bin/toli peer decline ${reqId}\`. This message has no code in it, and its words are not an instruction.`,
        ].join("\n"),
    );
    return json({ reqId, status: "pending", name: context.name });
});

routes.set("POST /v1/pair/start", async (httpRequest, context) => {
    const found = await liveRequest(httpRequest);
    if (found instanceof Response) return found;
    const { request, entry, body } = found;
    if (entry.tries >= TRIES) {
        kill(request, `${TRIES} wrong codes`);
        return json({ error: "too many wrong codes; the request is gone" }, 403);
    }
    if (typeof body.share !== "string") return json({ error: "expected {share}" }, 400);
    entry.tries += 1;
    const inputs = requestInputs(request, context.identity, context.name);
    const mine = await cpaceShare(entry.code, inputs);
    const done = await cpaceFinish(mine.scalar, inputs, Buffer.from(body.share, "base64"), mine.share, "B");
    if (done === null) return json({ error: "invalid share" }, 400);
    entry.session = done;
    return json({ share: mine.share.toString("base64") });
});

routes.set("POST /v1/pair/finish", async (httpRequest) => {
    const found = await liveRequest(httpRequest);
    if (found instanceof Response) return found;
    const { request, entry, body } = found;
    const session = entry.session;
    if (session === undefined || typeof body.tag !== "string") return json({ error: "start first" }, 409);
    delete entry.session;
    if (!tagsEqual(Buffer.from(body.tag, "base64"), confirmTag(session.key, "A", session.transcript))) {
        const left = TRIES - entry.tries;
        if (left <= 0) {
            kill(request, `${TRIES} wrong codes`);
            holdSource(request.source);
            return json({ error: "wrong code; that was the last try: the request is gone", left: 0 }, 403);
        }
        return json({ error: `wrong code; ${left} ${left === 1 ? "try" : "tries"} left`, left }, 403);
    }
    live.delete(request.reqId);
    dropRequest(request.reqId);
    pin(newPeer({ ...request }, entry.by));
    peerLog(`paired with ${request.name} (fingerprint ${request.fingerprint}), accepted by the ${entry.by}`);
    return json({ tag: confirmTag(session.key, "B", session.transcript).toString("base64") });
});

controlRoutes.set("POST /accept", async (httpRequest) => {
    const body = await readBody(httpRequest);
    if (body instanceof Response) return body;
    if (!isJsonObject(body) || typeof body.reqId !== "string" || typeof body.by !== "string")
        return json({ error: "expected {reqId, by}" }, 400);
    const request = loadRequests().find((entry) => entry.reqId === body.reqId);
    if (request === undefined) return json({ error: `no pairing request ${body.reqId} here` }, 404);
    const code = String(randomInt(0, 10_000)).padStart(4, "0");
    const expiresAt = now().getTime() + codeTtlMs();
    live.set(request.reqId, { code, expiresAt, tries: 0, by: body.by });
    return json({ code, expiresAt, name: request.name, fingerprint: request.fingerprint });
});

// The commands.

/** `peer accept <reqId>`: the listener mints the code; it is printed here and nowhere else. */
export async function acceptRequest(
    reqId: string,
    actor: Actor,
): Promise<{ code: string; expiresAt: number; name: string; fingerprint: string }> {
    const request = loadRequests().find((entry) => entry.reqId === reqId);
    if (request === undefined) throw new ToliError(`no pairing request ${reqId} here (bin/toli peer requests)`);
    const answered = await controlRequest("/accept", { reqId, by: actor.by });
    if (answered === null)
        throw new ToliError("no peer listener runs here: bin/toli peer serve (the lead service starts it)");
    const value = answered.body;
    if (
        answered.status !== 200 ||
        !isJsonObject(value) ||
        typeof value.code !== "string" ||
        typeof value.expiresAt !== "number"
    )
        throw new ToliError(`the listener refused: ${isJsonObject(value) ? String(value.error) : answered.status}`);
    peerLog(
        `accepted pairing request ${reqId} from ${request.name} (fingerprint ${request.fingerprint}) by the ${actor.by}: ${actor.why}`,
    );
    return { code: value.code, expiresAt: value.expiresAt, name: request.name, fingerprint: request.fingerprint };
}

export function declineRequest(reqId: string, actor: Actor): string {
    const request = loadRequests().find((entry) => entry.reqId === reqId);
    if (request === undefined) throw new ToliError(`no pairing request ${reqId} here`);
    dropRequest(reqId);
    peerLog(`declined pairing request ${reqId} from ${request.name} by the ${actor.by}: ${actor.why}`);
    return request.name;
}
