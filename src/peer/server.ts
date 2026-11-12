// The HTTPS listener (`bin/toli peer serve`, docs/peers.md "The listener"). The lead service keeps it running
// (src/fleet/lead.ts); it binds only private addresses (src/peer/bind.ts) and serves this installation's certificate.
//
//   GET  /v1/hello            name, version, keys and fingerprints only (unauthenticated)
//   POST /v1/pair/...         pairing with a 4-digit code (src/peer/pair.ts)
//   POST /v1/messages         a signed, ordered batch of envelopes; one receipt each (src/peer/envelope.ts)
//   POST /v1/announce         a peer is back: its addresses, then its queue here goes out at once
//   POST /v1/status           what `bin/toli resources` and `task list` say here (the `status` permission)
//   POST /v1/outbox/pending   a peer without a listener pulls what waits here for it; /v1/outbox/ack drops it
//
// Every POST but pairing needs a pinned peer's signature. Requests are at most 512 KiB and batches 50 envelopes; past
// 60 envelopes a minute from one peer the rest are deferred (429), and stay queued with their sender. A unix socket in
// state/peer/ (mode 0600) takes local commands: `peer accept` asks it for a code, `peer listen off` stops it.
import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Server } from "bun";
import { loadMachine } from "../core/config.ts";
import { codeRoot, paths } from "../core/paths.ts";
import { tryPidLock } from "../core/pid-lock.ts";
import { isJsonObject, now, pidAlive, readJson, ToliError, warn, writeJsonAtomic } from "../core/util.ts";
import { runtimeSuperseded } from "../release/runtime.ts";
import { bindAddresses, hostPort } from "./bind.ts";
import { applyBatch, type Envelope, verifyEnvelope } from "./envelope.ts";
import { hasIdentity, type Identity, initIdentity, loadIdentity } from "./identity.ts";
import { type Peer, peerLog, peerSettings } from "./store.ts";

export const MAX_REQUEST_BYTES = 512 * 1024;
export const MAX_BATCH = 50;
const RESCAN_MS = 15_000;
const RATE_PER_MIN = 60;

/** state/peer/listener.json: the running listener, for `peer status`, the lead service and tests. */
export type ListenerRecord = {
    pid: number;
    port: number;
    addrs: string[];
    startedAt: string;
    fingerprint: string;
    version: string;
};

export function readListener(): ListenerRecord | null {
    return readJson<ListenerRecord | null>(paths.peerListener(), null);
}

/** Envelopes per peer per sliding minute (`TOLI_PEER_RATE_PER_MIN` overrides the 60, for tests). */
class RateLimit {
    private readonly hits = new Map<string, number[]>();
    constructor(private readonly perMinute: number) {}

    take(key: string): boolean {
        const at = Date.now();
        const recent = (this.hits.get(key) ?? []).filter((hit) => at - hit < 60_000);
        if (recent.length >= this.perMinute) {
            this.hits.set(key, recent);
            return false;
        }
        recent.push(at);
        this.hits.set(key, recent);
        return true;
    }
}

/** A verified control request (announce, status, pull) and its peer, or the response refusing it. */
export type Control = { peer: Peer; envelope: Envelope };

/** What a route sees: this installation, and the listener's own state. */
export type ListenerContext = {
    identity: Identity;
    name: string;
    version: string;
    port: () => number;
    addrs: () => string[];
    rate: RateLimit;
    stop: () => void;
};

type Route = (request: Request, context: ListenerContext, server: Server<undefined>) => Promise<Response>;

export function json(value: unknown, status = 200): Response {
    return Response.json(value, { status });
}

/** The request's JSON body, or the response refusing it: 413 over MAX_REQUEST_BYTES, 400 when it is not JSON. */
export async function readBody(request: Request): Promise<unknown | Response> {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_REQUEST_BYTES) return json({ error: "request over 512 KiB" }, 413);
    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) return json({ error: "request over 512 KiB" }, 413);
    try {
        return JSON.parse(text);
    } catch {
        return json({ error: "the body is not JSON" }, 400);
    }
}

/** Verify one signed control envelope of `kind`; a refusal is its HTTP status with the reason. */
export async function readControl(
    request: Request,
    context: ListenerContext,
    kind: string,
): Promise<Control | Response> {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const verified = verifyEnvelope(body, context.identity.fingerprint);
    if (!verified.ok) return json({ error: verified.reason }, verified.code);
    if (verified.envelope.kind !== kind) return json({ error: `expected a ${kind} envelope` }, 400);
    return { peer: verified.peer, envelope: verified.envelope };
}

const hello: Route = async (_request, context) =>
    json({
        name: context.name,
        version: context.version,
        key: context.identity.key,
        fingerprint: context.identity.fingerprint,
        certFingerprint: context.identity.certFingerprint,
        certSig: context.identity.certSig,
    });

const messages: Route = async (request, context) => {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const envelopes = isJsonObject(body) ? body.envelopes : undefined;
    if (!Array.isArray(envelopes)) return json({ error: "expected {envelopes: [...]}" }, 400);
    if (envelopes.length > MAX_BATCH) return json({ error: `at most ${MAX_BATCH} envelopes a request` }, 413);
    const receipts = await applyBatch(envelopes, context.identity.fingerprint, (peer) =>
        context.rate.take(peer.fingerprint) ? null : `rate limit: ${RATE_PER_MIN} messages a minute`,
    );
    const refusedAll = receipts.length > 0 && receipts.every((receipt) => receipt.status === "refused");
    const status = receipts.some((receipt) => receipt.code === 429)
        ? 429
        : refusedAll
          ? Math.min(...receipts.map((receipt) => receipt.code ?? 400))
          : 200;
    return json({ receipts }, status);
};

/** Routes by `METHOD path`; pairing and the queue's control requests add theirs (pair.ts, deliver.ts). */
export const routes = new Map<string, Route>([
    ["GET /v1/hello", hello],
    ["POST /v1/messages", messages],
]);

async function handle(request: Request, context: ListenerContext, server: Server<undefined>): Promise<Response> {
    const route = routes.get(`${request.method} ${new URL(request.url).pathname}`);
    if (route === undefined) return json({ error: "not found" }, 404);
    try {
        return await route(request, context, server);
    } catch (error) {
        warn(`peer listener: ${error instanceof Error ? error.message : String(error)}`);
        return json({ error: "internal error" }, 500);
    }
}

/** Local commands over the control socket; pairing adds `POST /accept` (pair.ts). */
export const controlRoutes = new Map<string, Route>([
    [
        "POST /stop",
        async (_request, context) => {
            setTimeout(context.stop, 10);
            return json({ stopping: true });
        },
    ],
    ["GET /status", async () => json(readListener())],
]);

function rateLimit(): number {
    const raw = Number(process.env.TOLI_PEER_RATE_PER_MIN ?? RATE_PER_MIN);
    return Number.isInteger(raw) && raw > 0 ? raw : RATE_PER_MIN;
}

function listenPort(): number {
    const override = process.env.TOLI_PEER_PORT;
    return override !== undefined && override !== "" ? Number(override) : peerSettings().port;
}

/** Called after every (re)bind with the bound `host:port` list: the queue announces this machine (deliver.ts). */
export const onBound: Array<(context: ListenerContext, addrs: string[]) => void> = [];

/**
 * `peer serve`: run the listener in the foreground until stopped (SIGTERM, `peer listen off`, a newer runtime, or
 * `peer.listen: false`). One per checkout (a pid lock). Makes the identity first when it is missing.
 */
export async function runListener(): Promise<number> {
    const lock = paths.lock("peer-listener");
    if (!tryPidLock(lock)) {
        warn(`toli: a peer listener already runs here (pid ${readListener()?.pid ?? "?"})`);
        return 1;
    }
    initIdentity();
    const identity = loadIdentity();
    const version = readJson<{ version?: string }>(join(codeRoot(), "package.json"), {}).version ?? "unknown";
    const servers = new Map<string, Server<undefined>>();
    let port = listenPort();
    let control: Server<undefined> | null = null;
    let rescan: NodeJS.Timeout | undefined;
    const { promise: stopped, resolve: finish } = Promise.withResolvers<number>();
    let stopping = false;
    const stop = (): void => {
        if (stopping) return;
        stopping = true;
        clearInterval(rescan);
        for (const server of servers.values()) server.stop(true);
        servers.clear();
        control?.stop(true);
        rmSync(paths.peerControl(), { force: true });
        if (readListener()?.pid === process.pid) rmSync(paths.peerListener(), { force: true });
        rmSync(lock, { force: true });
        finish(0);
    };
    const context: ListenerContext = {
        identity,
        name: loadMachine().name,
        version,
        port: () => port,
        addrs: () => [...servers.keys()].map((host) => hostPort(host, port)),
        rate: new RateLimit(rateLimit()),
        stop,
    };
    const bind = (hosts: string[]): boolean => {
        const wanted = new Set(hosts);
        let changed = false;
        for (const [host, server] of servers)
            if (!wanted.has(host)) {
                server.stop(true);
                servers.delete(host);
                changed = true;
            }
        for (const host of hosts) {
            if (servers.has(host)) continue;
            try {
                const server: Server<undefined> = Bun.serve({
                    hostname: host,
                    port,
                    maxRequestBodySize: MAX_REQUEST_BYTES,
                    tls: { key: identity.tlsKeyPem, cert: identity.certPem },
                    fetch: (request, self) => handle(request, context, self),
                });
                if (port === 0) port = server.port ?? 0;
                servers.set(host, server);
                changed = true;
            } catch (error) {
                peerLog(
                    `listener: cannot bind ${hostPort(host, port)}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
        return changed;
    };
    const record = (): void =>
        writeJsonAtomic(paths.peerListener(), {
            pid: process.pid,
            port,
            addrs: context.addrs(),
            startedAt: now().toISOString(),
            fingerprint: identity.fingerprint,
            version,
        } satisfies ListenerRecord);
    const rebind = (): void => {
        if (!existsSync(paths.machine())) {
            // The checkout was removed (or never finished `init`): nothing here can take a message any more.
            peerLog("listener: config/machine.json is gone; stopping");
            stop();
            return;
        }
        const settings = peerSettings();
        if (!settings.listen) {
            peerLog("listener: peer.listen is off; stopping");
            stop();
            return;
        }
        if (runtimeSuperseded()) {
            peerLog("listener: a newer runtime is installed; exiting so the lead service restarts it on that");
            stop();
            return;
        }
        if (!bind(bindAddresses(settings.bind))) return;
        record();
        peerLog(`listener: bound ${context.addrs().join(", ") || "nothing (no private address)"}`);
        for (const hook of onBound) hook(context, context.addrs());
    };
    try {
        mkdirSync(dirname(paths.peerControl()), { recursive: true });
        rmSync(paths.peerControl(), { force: true });
        control = Bun.serve({
            unix: paths.peerControl(),
            fetch: async (request, self) => {
                const route = controlRoutes.get(`${request.method} ${new URL(request.url).pathname}`);
                return route === undefined ? json({ error: "not found" }, 404) : route(request, context, self);
            },
        });
        chmodSync(paths.peerControl(), 0o600);
        if (!bind(bindAddresses(peerSettings().bind)) && servers.size === 0)
            peerLog("listener: no private address to bind yet; rescanning every 15 s");
        record();
        peerLog(`listener: started (pid ${process.pid}) on ${context.addrs().join(", ") || "no address yet"}`);
        for (const hook of onBound) hook(context, context.addrs());
    } catch (error) {
        stop();
        throw new ToliError(`peer listener failed to start: ${error instanceof Error ? error.message : String(error)}`);
    }
    rescan = setInterval(rebind, Number(process.env.TOLI_PEER_RESCAN_MS ?? RESCAN_MS));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    return await stopped;
}

/** Send one local command to the running listener over its control socket; null when no listener answers. */
export async function controlRequest(path: string, body?: unknown): Promise<{ status: number; body: unknown } | null> {
    if (!existsSync(paths.peerControl())) return null;
    try {
        const response = await fetch(`http://localhost${path}`, {
            unix: paths.peerControl(),
            method: body === undefined ? "GET" : "POST",
            ...(body === undefined
                ? {}
                : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
        });
        return { status: response.status, body: await response.json() };
    } catch {
        return null;
    }
}

/**
 * The lead service's pass (src/fleet/lead.ts): start `bin/toli peer serve` detached when `peer.listen` is on, this
 * installation has its peer identity (`peer init`, which `upgrade` runs: a checkout that never opted in, a test
 * sandbox included, never binds the machine's addresses) and no listener runs. Returns the log line when it started
 * one (or, with TOLI_DRY_RUN, would have), else null.
 */
export function ensureListener(): string | null {
    if (!peerSettings().listen || !hasIdentity()) return null;
    const running = readListener();
    if (running !== null && pidAlive(running.pid)) return null;
    if (process.env.TOLI_DRY_RUN === "1") return "would start the peer listener (TOLI_DRY_RUN)";
    mkdirSync(paths.logsDir(), { recursive: true });
    const log = openSync(paths.peerLog(), "a");
    const { TOLI_LEAD_TURN: _turn, ...env } = process.env;
    try {
        const child = spawn(process.execPath, [paths.codeBin(), "peer", "serve"], {
            cwd: paths.root(),
            detached: true,
            stdio: ["ignore", log, log],
            env,
        });
        child.unref();
        return `started the peer listener (pid ${child.pid ?? "?"})`;
    } finally {
        closeSync(log);
    }
}
