// Finding peers (`bin/toli peer scan`, docs/peers.md "Finding peers"): candidate addresses from NetBird
// (`netbird status --json`), Tailscale (`tailscale status --json`) and an explicit private subnet of at most a /22,
// each asked for its hello on the toli port (at most 32 at once, 1 s each). It prints name, version, fingerprint and
// address and never pairs: pairing is `peer add` with a code. Each source is used when its binary exists; none is
// required and none is assumed.
import { isIP } from "node:net";
import { Args } from "../core/args.ts";
import { isJsonObject, out, printJson, run, ToliError } from "../core/util.ts";
import { hostPort, isPrivateAddress } from "./bind.ts";
import { fetchHello, type Hello } from "./pair-client.ts";
import { loadPeers, peerSettings } from "./store.ts";

export type Candidate = { address: string; name: string; source: string };
export type Found = { address: string; name: string; version: string; fingerprint: string; source: string };

const CONCURRENCY = 32;
const HELLO_MS = 1_000;

function list(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

/** `netbird status --json`: `peers.details[]` with `netbirdIp` (maybe with a prefix length) and `fqdn`. */
export function netbirdCandidates(status: unknown): Candidate[] {
    const peers = isJsonObject(status) && isJsonObject(status.peers) ? status.peers : {};
    return list(peers.details).flatMap((peer) => {
        if (!isJsonObject(peer) || typeof peer.netbirdIp !== "string") return [];
        const address = peer.netbirdIp.split("/")[0] ?? "";
        if (isIP(address) === 0) return [];
        return [{ address, name: typeof peer.fqdn === "string" ? peer.fqdn : address, source: "netbird" }];
    });
}

/** `tailscale status --json`: `Peer.*` with `TailscaleIPs[]` and `DNSName` (with a trailing dot). */
export function tailscaleCandidates(status: unknown): Candidate[] {
    const peers = isJsonObject(status) && isJsonObject(status.Peer) ? Object.values(status.Peer) : [];
    return peers.flatMap((peer) => {
        if (!isJsonObject(peer)) return [];
        const name = typeof peer.DNSName === "string" ? peer.DNSName.replace(/\.$/, "") : "";
        return list(peer.TailscaleIPs)
            .filter((address): address is string => typeof address === "string" && isIP(address) !== 0)
            .map((address) => ({ address, name: name || address, source: "tailscale" }));
    });
}

/** Every host address of an IPv4 `a.b.c.d/n` private subnet of at most a /22 (network and broadcast left out). */
export function subnetCandidates(cidr: string): Candidate[] {
    const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(cidr);
    if (match === null || isIP(match[1] ?? "") !== 4)
        throw new ToliError("--subnet takes an IPv4 CIDR like 10.0.4.0/24");
    const bits = Number(match[2]);
    if (bits < 22 || bits > 30) throw new ToliError(`--subnet is at most a /22 (and at least a /30): ${cidr}`);
    const base = (match[1] ?? "").split(".").reduce((value, part) => value * 256 + Number(part), 0);
    const size = 2 ** (32 - bits);
    const network = base - (base % size);
    const text = (value: number) => [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");
    if (!isPrivateAddress(text(network))) throw new ToliError(`--subnet ${cidr} is not a private range`);
    return Array.from({ length: size - 2 }, (_, index) => ({
        address: text(network + index + 1),
        name: text(network + index + 1),
        source: "subnet",
    }));
}

/** A source's status JSON, or null when its binary is missing or fails. */
function statusJson(binary: string): unknown {
    if (Bun.which(binary) === null) return null;
    const result = run([binary, "status", "--json"], { timeoutMs: 15_000 });
    if (result.code !== 0) return null;
    try {
        return JSON.parse(result.stdout);
    } catch {
        return null;
    }
}

export type ScanOptions = { netbird: boolean; tailscale: boolean; subnet?: string; port: number };

/** The candidates the chosen sources name; with no source chosen, every source whose binary exists. */
export function candidates(options: ScanOptions): Candidate[] {
    const any = options.netbird || options.tailscale || options.subnet !== undefined;
    const found: Candidate[] = [];
    if (options.netbird || !any) found.push(...netbirdCandidates(statusJson("netbird")));
    if (options.tailscale || !any) found.push(...tailscaleCandidates(statusJson("tailscale")));
    if (options.subnet !== undefined) found.push(...subnetCandidates(options.subnet));
    const seen = new Set<string>();
    return found.filter((candidate) => !seen.has(candidate.address) && seen.add(candidate.address));
}

/** Ask every candidate for its hello, CONCURRENCY at a time; the ones that answer, in candidate order. */
export async function scan(options: ScanOptions): Promise<Found[]> {
    const pending = candidates(options);
    const results: Array<Found | null> = new Array(pending.length).fill(null);
    let next = 0;
    const worker = async () => {
        for (;;) {
            const index = next;
            next += 1;
            const candidate = pending[index];
            if (candidate === undefined) return;
            let hello: Hello;
            try {
                hello = (await fetchHello(candidate.address, options.port, HELLO_MS)).hello;
            } catch {
                continue;
            }
            results[index] = {
                address: hostPort(candidate.address, options.port),
                name: hello.name,
                version: hello.version,
                fingerprint: hello.fingerprint,
                source:
                    candidate.name === candidate.address ? candidate.source : `${candidate.source} (${candidate.name})`,
            };
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
    return results.filter((found): found is Found => found !== null);
}

/** `peer scan [--netbird] [--tailscale] [--subnet <cidr>] [--port <n>] [--json]`: list the listeners that answer. */
export async function scanCommand(argv: string[]): Promise<void> {
    const args = new Args(argv, { booleans: ["netbird", "tailscale", "json"], values: ["subnet", "port"] });
    args.maxPositional(0);
    const rawPort = args.str("port");
    const port = rawPort === undefined ? peerSettings().port : Number(rawPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new ToliError(`bad --port "${rawPort}"`);
    const subnet = args.str("subnet");
    const found = await scan({
        netbird: args.bool("netbird"),
        tailscale: args.bool("tailscale"),
        ...(subnet === undefined ? {} : { subnet }),
        port,
    });
    if (args.bool("json")) {
        printJson(found);
        return;
    }
    if (found.length === 0) {
        out("no toli listener answered (pair one with bin/toli peer add <host> once it runs bin/toli peer serve)");
        return;
    }
    const paired = new Set(loadPeers().map((peer) => peer.fingerprint));
    for (const entry of found)
        out(
            `${entry.name}\t${entry.address}\t${entry.version}\t${entry.fingerprint.slice(0, 16)}\t${entry.source}${paired.has(entry.fingerprint) ? "\t(paired)" : ""}`,
        );
}
