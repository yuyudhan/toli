// A running `bin/toli peer serve` in a peer sandbox, bound to 127.0.0.1 on a free port (TOLI_PEER_BIND and
// TOLI_PEER_PORT), reached with its certificate pinned the way a paired peer reaches it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject, pidAlive } from "../src/core/util.ts";
import { GIT_ENV, TOLI_BIN } from "./helpers.ts";
import type { PeerBox } from "./peer-fixture.ts";

/** The pid of the live listener `state/peer/listener.json` names in the checkout `root`, or null. */
export function livePid(root: string): number | null {
    const record = join(root, "state", "peer", "listener.json");
    if (!existsSync(record)) return null;
    const parsed: unknown = JSON.parse(readFileSync(record, "utf8"));
    const pid = isJsonObject(parsed) ? parsed.pid : undefined;
    return typeof pid === "number" && pidAlive(pid) ? pid : null;
}

/**
 * Poll `probe` until it returns a value, or throw after `ms`. The processes it watches (a lead service, detached
 * listeners) run on the real clock in other processes, so there is no fake timer to advance.
 */
export async function until<T>(what: string, ms: number, probe: () => T | null): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
        const value = probe();
        if (value !== null) return value;
        if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
        await Bun.sleep(50);
    }
}

export type Listening = {
    base: string;
    port: number;
    fetch(path: string, init?: RequestInit): Promise<Response>;
    post(path: string, body: unknown): Promise<Response>;
    stop(): Promise<void>;
    exited: Promise<number>;
};

const START_MS = 20_000;

/** The env a sandbox's own processes get (tests/helpers.ts sandbox), plus the listener's test overrides. */
export function peerEnv(recv: PeerBox, env: Record<string, string> = {}): Record<string, string | undefined> {
    return {
        ...process.env,
        ...GIT_ENV,
        PATH: [join(recv.box.root, ".stubs"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
        TOLI_ROOT: recv.box.root,
        TOLI_DRY_RUN: "1",
        TOLI_PEER_BIND: "127.0.0.1",
        TOLI_PEER_PORT: "0",
        ...env,
    };
}

export async function serve(recv: PeerBox, env: Record<string, string> = {}): Promise<Listening> {
    const record = join(recv.box.root, "state", "peer", "listener.json");
    const proc = Bun.spawn([process.execPath, TOLI_BIN, "peer", "serve"], {
        cwd: recv.box.root,
        env: peerEnv(recv, env),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    const deadline = Date.now() + START_MS;
    let port = 0;
    while (port === 0) {
        if (existsSync(record)) {
            const parsed = JSON.parse(readFileSync(record, "utf8")) as { port?: number; pid?: number };
            if (parsed.pid === proc.pid && typeof parsed.port === "number") port = parsed.port;
        }
        if (port !== 0) break;
        if (proc.exitCode !== null || Date.now() > deadline) {
            proc.kill();
            const output = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`;
            throw new Error(`peer serve did not start (exit ${proc.exitCode}): ${output}`);
        }
        await Bun.sleep(50);
    }
    const base = `https://127.0.0.1:${port}`;
    const tls = { ca: recv.cert, serverName: "toli-peer" };
    const fetchPinned = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, tls });
    return {
        base,
        port,
        fetch: fetchPinned,
        post: (path, body) =>
            fetchPinned(path, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: typeof body === "string" ? body : JSON.stringify(body),
            }),
        async stop() {
            if (proc.exitCode === null) proc.kill("SIGTERM");
            await proc.exited;
        },
        exited: proc.exited,
    };
}
