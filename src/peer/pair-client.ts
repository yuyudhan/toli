// The requesting side (A) of pairing (docs/peers.md "Pairing", src/peer/pair.ts for B's side): read B's hello with
// the certificate it serves and send a signed request. On an open network B pairs on first contact and A pins it the
// same way; otherwise A runs CPace with the code B's owner or Sardar reads out.
import { randomBytes } from "node:crypto";
import { connect } from "node:tls";
import { loadMachine } from "../core/config.ts";
import { codeRoot, paths } from "../core/paths.ts";
import { isJsonObject, now, readJson, ToliError, withLock, writeJsonAtomic } from "../core/util.ts";
import { hostPort, splitHostPort } from "./bind.ts";
import { confirmTag, cpaceFinish, cpaceShare, type PairInputs, tagsEqual } from "./cpace.ts";
import { raiseKeyMismatch } from "./first-contact.ts";
import { certFingerprintOf, certPem, certSigValid, fingerprintOf, loadIdentity, TLS_NAME } from "./identity.ts";
import { newPeer, pin, REQUEST_KEEP_MS, signed } from "./pair.ts";
import { readListener } from "./server.ts";
import { type Actor, loadPeers, type Peer, peerLog, peerSettings, personField, updatePeers } from "./store.ts";

const CONNECT_MS = 5_000;
const POST_MS = 30_000;

/** What A keeps between `peer add` and `peer add --code` (state/peer/outgoing.json). */
type Outgoing = {
    reqId: string;
    host: string;
    port: number;
    name: string;
    key: string;
    cert: string;
    certSig: string;
    version: string;
    createdAt: number;
};

/**
 * The certificate a host serves, read before any pin (Bun's fetch cannot hand it over). The deadline is a timer of
 * its own: Bun's socket `timeout` never fires while a connect to an address nobody answers (127.0.0.2 on macOS, a
 * dropped VPN peer) is still pending, so the read would hang.
 */
export async function serverCertificate(host: string, port: number, timeoutMs = CONNECT_MS): Promise<string> {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const socket = connect({ host, port, servername: TLS_NAME, rejectUnauthorized: false });
    const deadline = setTimeout(() => {
        socket.destroy();
        reject(new ToliError(`${hostPort(host, port)} did not answer within ${timeoutMs / 1000} s`));
    }, timeoutMs);
    socket.once("secureConnect", () => {
        const raw = socket.getPeerCertificate(true).raw;
        socket.end();
        if (raw === undefined) reject(new ToliError(`${hostPort(host, port)} sent no certificate`));
        else resolve(certPem(raw));
    });
    socket.once("error", (error) => reject(new ToliError(`${hostPort(host, port)}: ${error.message}`)));
    try {
        return await promise;
    } finally {
        clearTimeout(deadline);
    }
}

export type Hello = {
    name: string;
    version: string;
    key: string;
    fingerprint: string;
    certFingerprint: string;
    certSig: string;
};

/** `GET /v1/hello` with the served certificate pinned, checked: the certificate is the one its key vouches for. */
export async function fetchHello(
    host: string,
    port: number,
    timeoutMs = CONNECT_MS,
): Promise<{ hello: Hello; cert: string }> {
    const cert = await serverCertificate(host, port, timeoutMs);
    const response = await fetch(`https://${hostPort(host, port)}/v1/hello`, {
        tls: { ca: cert, serverName: TLS_NAME },
        signal: AbortSignal.timeout(timeoutMs),
    });
    const value: unknown = await response.json();
    if (!isJsonObject(value)) throw new ToliError("hello: not a JSON object");
    const fields = ["name", "version", "key", "fingerprint", "certFingerprint", "certSig"] as const;
    for (const field of fields) if (typeof value[field] !== "string") throw new ToliError(`hello: no ${field}`);
    const hello = value as Hello;
    if (fingerprintOf(hello.key) !== hello.fingerprint) throw new ToliError("hello: the fingerprint is not its key's");
    if (certFingerprintOf(cert) !== hello.certFingerprint || !certSigValid(hello.key, cert, hello.certSig))
        throw new ToliError("hello: the certificate served is not the one its key vouches for: not pairing");
    return { hello, cert };
}

export async function postJson(
    host: string,
    port: number,
    cert: string,
    path: string,
    body: unknown,
): Promise<{ status: number; value: Record<string, unknown> }> {
    const response = await fetch(`https://${hostPort(host, port)}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        tls: { ca: cert, serverName: TLS_NAME },
        signal: AbortSignal.timeout(POST_MS),
    });
    const value: unknown = await response.json().catch(() => ({}));
    return { status: response.status, value: isJsonObject(value) ? value : {} };
}

/**
 * What a request did: on an open network the host paired on first contact (`paired`, pinned here too, or already
 * paired); anywhere else it waits for a code, for the request id to give the host's owner.
 */
export type Requested = { hello: Hello; reqId: string; paired: Peer | null; already: boolean };

/**
 * Step 1 on A: ask `target` to pair. A host whose name is pinned here with another key is refused before anything is
 * sent (and raised to the lead): that is what stops a machine passing for one already paired.
 */
export async function requestPairing(target: string): Promise<Requested> {
    const { host, port } = splitHostPort(target, peerSettings().port);
    const identity = loadIdentity();
    const { hello, cert } = await fetchHello(host, port);
    if (hello.key === identity.key) throw new ToliError("that is this machine");
    const peers = loadPeers();
    const named = peers.find((peer) => peer.name === hello.name);
    if (named !== undefined && named.key !== hello.key) {
        raiseKeyMismatch(hello.name, hello.fingerprint, named.fingerprint, `at ${hostPort(host, port)}`);
        throw new ToliError(
            `${hello.name}'s key is not the one pinned here (${hostPort(host, port)} shows ${hello.fingerprint.slice(0, 16)}, pinned ${named.fingerprint.slice(0, 16)}): not paired`,
        );
    }
    const holder = peers.find((peer) => peer.key === hello.key && peer.name !== hello.name);
    if (holder !== undefined)
        throw new ToliError(`${hostPort(host, port)} has the key pinned here as ${holder.name}, not ${hello.name}`);
    const reqId = randomBytes(8).toString("hex");
    const version = readJson<{ version?: string }>(`${codeRoot()}/package.json`, {}).version ?? "unknown";
    const sent = await postJson(
        host,
        port,
        cert,
        "/v1/pair/request",
        signed(identity, {
            reqId,
            name: loadMachine().name,
            version,
            key: identity.key,
            cert: identity.certPem,
            certSig: identity.certSig,
            addrs: readListener()?.addrs ?? [],
            ...personField(),
        }),
    );
    if (sent.status !== 200)
        throw new ToliError(`${hello.name} refused the request (${sent.status}): ${String(sent.value.error)}`);
    if (sent.value.status === "paired") {
        // The host pinned this machine on first contact; pin it here the same way, unless it already is.
        if (named?.status === "active") {
            if (named.introducedBy === undefined) return { hello, reqId, paired: named, already: true };
            // Pinned through an introducer until now: paired directly, it is this machine's own pin, with no expiry
            // and nothing the introducer can revoke (docs/peers.md "Talking on the office network").
            const own = updatePeers((peers) => {
                const peer = peers.find((entry) => entry.name === named.name && entry.status === "active");
                if (peer === undefined) return named;
                delete peer.introducedBy;
                delete peer.introId;
                delete peer.notAfter;
                peer.pairedBy = "first-contact";
                if (!peer.addrs.includes(hostPort(host, port))) peer.addrs = [hostPort(host, port), ...peer.addrs];
                if (peer.cert === "") {
                    peer.cert = cert;
                    peer.certSig = hello.certSig;
                }
                return peer;
            });
            peerLog(`paired with ${named.name} directly on first contact: its pin is now this machine's own`);
            return { hello, reqId, paired: own, already: false };
        }
        const peer = newPeer(
            {
                name: hello.name,
                key: hello.key,
                cert,
                certSig: hello.certSig,
                addrs: [hostPort(host, port)],
                version: hello.version,
            },
            "first-contact",
        );
        pin(peer);
        peerLog(
            `paired with ${peer.name} at ${hostPort(host, port)} (fingerprint ${peer.fingerprint}) on first contact`,
        );
        return { hello, reqId, paired: peer, already: false };
    }
    withLock(paths.lock("peer-outgoing"), () => {
        const outgoing = readJson<Outgoing[]>(paths.peerOutgoing(), []).filter(
            (entry) => now().getTime() - entry.createdAt < REQUEST_KEEP_MS,
        );
        outgoing.push({
            reqId,
            host,
            port,
            name: hello.name,
            key: hello.key,
            cert,
            certSig: hello.certSig,
            version: hello.version,
            createdAt: now().getTime(),
        });
        writeJsonAtomic(paths.peerOutgoing(), outgoing);
    });
    return { hello, reqId, paired: null, already: false };
}

/** Step 2 on A: run CPace with `code` for the latest request to `target`; pins B when both tags verify. */
export async function completePairing(target: string, code: string, actor: Actor): Promise<Peer> {
    if (!/^\d{4}$/.test(code)) throw new ToliError("the code is 4 digits");
    const { host, port } = splitHostPort(target, peerSettings().port);
    const outgoing = readJson<Outgoing[]>(paths.peerOutgoing(), [])
        .filter((entry) => entry.host === host && entry.port === port)
        .at(-1);
    if (outgoing === undefined)
        throw new ToliError(
            `no pairing request to ${hostPort(host, port)} here: run bin/toli peer add ${target} first`,
        );
    const identity = loadIdentity();
    const inputs: PairInputs = {
        reqId: outgoing.reqId,
        nameA: loadMachine().name,
        nameB: outgoing.name,
        keyA: identity.key,
        keyB: outgoing.key,
        certFpA: identity.certFingerprint,
        certFpB: certFingerprintOf(outgoing.cert),
    };
    const mine = await cpaceShare(code, inputs);
    const started = await postJson(
        host,
        port,
        outgoing.cert,
        "/v1/pair/start",
        signed(identity, { reqId: outgoing.reqId, share: mine.share.toString("base64") }),
    );
    if (started.status !== 200 || typeof started.value.share !== "string")
        throw new ToliError(`${outgoing.name}: ${String(started.value.error ?? started.status)}`);
    const done = await cpaceFinish(mine.scalar, inputs, mine.share, Buffer.from(started.value.share, "base64"), "A");
    if (done === null) throw new ToliError(`${outgoing.name} sent an invalid share: not paired`);
    const finished = await postJson(
        host,
        port,
        outgoing.cert,
        "/v1/pair/finish",
        signed(identity, { reqId: outgoing.reqId, tag: confirmTag(done.key, "A", done.transcript).toString("base64") }),
    );
    if (finished.status !== 200 || typeof finished.value.tag !== "string")
        throw new ToliError(`${outgoing.name}: ${String(finished.value.error ?? finished.status)}`);
    if (!tagsEqual(Buffer.from(finished.value.tag, "base64"), confirmTag(done.key, "B", done.transcript)))
        throw new ToliError(
            `${outgoing.name}'s confirmation did not verify: not paired here (remove it there: bin/toli peer remove)`,
        );
    const peer = newPeer(
        {
            name: outgoing.name,
            key: outgoing.key,
            cert: outgoing.cert,
            certSig: outgoing.certSig,
            addrs: [hostPort(host, port)],
            version: outgoing.version,
        },
        actor.by,
    );
    pin(peer);
    withLock(paths.lock("peer-outgoing"), () =>
        writeJsonAtomic(
            paths.peerOutgoing(),
            readJson<Outgoing[]>(paths.peerOutgoing(), []).filter((entry) => entry.reqId !== outgoing.reqId),
        ),
    );
    peerLog(`paired with ${peer.name} (fingerprint ${peer.fingerprint}) by the ${actor.by}: ${actor.why}`);
    return peer;
}
