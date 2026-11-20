// Why a fleet machine did not answer, in plain words (docs/fleet.md "Unreachable machines"). A TCP connect proves
// nothing on a mesh VPN whose userspace client accepts connections to any of its addresses, so a host that is off
// the network shows up as an ssh banner timeout or a TLS failure. When the netbird CLI answers, the machine's NetBird
// peer state says what happened; without it, a network-level failure reads as "no route / host down".
import { isIP } from "node:net";
import { isJsonObject, runAsync, waited } from "../core/util.ts";

/** One peer from `netbird status --json`; `lastHandshake` is null when it never completed one. */
export type NetbirdPeer = { fqdn: string; ip: string; status: string; lastHandshake: string | null };

/** This machine's NetBird view: its own address and prefix length, its DNS domain, and its peers. */
export type Netbird = { ip: string; prefix: number; domain: string; peers: NetbirdPeer[] };

/** What a probe saw: the HTTPS failure prefix (`HTTPS: ...; ` or empty), ssh's own detail, and whether it hit the cap. */
export type ProbeFailure = { https: string; ssh: string; timedOut: boolean };

const NETBIRD_MS = 5_000;
const SSH_CONFIG_MS = 5_000;

/** ssh failures that mean the host or the route to it is gone, not that sshd answered and refused. */
const NETWORK_FAILURE = /timed out|no route to host|network is unreachable|host is down|banner exchange/i;

/** NetBird writes the zero time for a peer that never completed a handshake. */
function handshake(value: unknown): string | null {
    if (typeof value !== "string" || value.startsWith("0001-") || Number.isNaN(Date.parse(value))) return null;
    return value;
}

/** `netbird status --json`, or null when it is not shaped like one. */
export function parseNetbirdStatus(status: unknown): Netbird | null {
    if (!isJsonObject(status) || typeof status.netbirdIp !== "string") return null;
    const [ip = "", prefix = "32"] = status.netbirdIp.split("/");
    const fqdn = typeof status.fqdn === "string" ? status.fqdn.toLowerCase().replace(/\.$/, "") : "";
    const details = isJsonObject(status.peers) && Array.isArray(status.peers.details) ? status.peers.details : [];
    return {
        ip,
        prefix: Number(prefix),
        domain: fqdn.includes(".") ? fqdn.slice(fqdn.indexOf(".") + 1) : "",
        peers: details.flatMap((peer: unknown) => {
            if (!isJsonObject(peer) || typeof peer.netbirdIp !== "string" || typeof peer.fqdn !== "string") return [];
            return [
                {
                    fqdn: peer.fqdn.toLowerCase().replace(/\.$/, ""),
                    ip: peer.netbirdIp.split("/")[0] ?? "",
                    status: typeof peer.status === "string" ? peer.status : "unknown",
                    lastHandshake: handshake(peer.lastWireguardHandshake),
                },
            ];
        }),
    };
}

function ipv4Number(address: string): number | null {
    if (isIP(address) !== 4) return null;
    return address.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
}

/** Whether `host` is an address or a name on this machine's NetBird network. */
function onNetbird(netbird: Netbird, host: string): boolean {
    if (netbird.domain !== "" && host.endsWith(`.${netbird.domain}`)) return true;
    const address = ipv4Number(host);
    const own = ipv4Number(netbird.ip);
    if (address === null || own === null || !(netbird.prefix >= 1 && netbird.prefix <= 32)) return false;
    const size = 2 ** (32 - netbird.prefix);
    return Math.floor(address / size) === Math.floor(own / size);
}

/** The peer one of `hosts` names: its address, its FQDN, or (a bare name) its FQDN's first label. */
function peerFor(netbird: Netbird, hosts: string[]): NetbirdPeer | undefined {
    return netbird.peers.find((peer) =>
        hosts.some(
            (host) =>
                host === peer.ip ||
                host === peer.fqdn ||
                (!host.includes(".") && isIP(host) === 0 && peer.fqdn.split(".")[0] === host),
        ),
    );
}

function peerText(peer: NetbirdPeer, at: Date): string {
    const last = peer.lastHandshake === null ? "never" : `${waited(at.getTime() - Date.parse(peer.lastHandshake))} ago`;
    return `NetBird peer ${peer.fqdn} is ${peer.status}, last handshake ${last}`;
}

/**
 * Why a probe failed, without the leading `unreachable: `. `hosts` are the names and addresses the machine is reached
 * by (lowercase). A NetBird peer that is not connected, or a NetBird address that is no peer, is off the network; a
 * connected peer keeps the probe's own errors, which are then real. Without NetBird, a network-level ssh failure drops
 * the HTTPS error, which on a host that is down says nothing true.
 */
export function explainUnreachable(failure: ProbeFailure, netbird: Netbird | null, hosts: string[], at: Date): string {
    const raw = `${failure.https}${failure.ssh}`;
    if (netbird !== null) {
        const peer = peerFor(netbird, hosts);
        if (peer !== undefined)
            return peer.status === "Connected"
                ? `${raw} (${peerText(peer, at)})`
                : `off the network: ${peerText(peer, at)}`;
        const stray = hosts.find((host) => onNetbird(netbird, host));
        if (stray !== undefined) return `off the network: ${stray} is not a NetBird peer of this machine`;
    }
    if (failure.timedOut || NETWORK_FAILURE.test(failure.ssh)) return `no route / host down (${failure.ssh})`;
    return raw;
}

/** This machine's NetBird view, or null when the netbird CLI is missing, fails, or prints no status. */
export async function readNetbird(): Promise<Netbird | null> {
    const result = await runAsync(["netbird", "status", "--json"], { timeoutMs: NETBIRD_MS });
    if (result.code !== 0 || result.timedOut) return null;
    try {
        return parseNetbirdStatus(JSON.parse(result.stdout));
    } catch {
        return null;
    }
}

/** One `readNetbird` shared by every probe of one fleet pass, run only when a probe first needs it. */
export function netbirdOnce(): () => Promise<Netbird | null> {
    let pending: Promise<Netbird | null> | undefined;
    return () => {
        pending ??= readNetbird();
        return pending;
    };
}

/** `host:port` or `[v6]:port` to its host. */
function addressHost(address: string): string {
    const bracketed = /^\[([^\]]+)\]/.exec(address);
    if (bracketed?.[1] !== undefined) return bracketed[1];
    const colon = address.lastIndexOf(":");
    return colon > 0 && address.indexOf(":") === colon ? address.slice(0, colon) : address;
}

/**
 * The names and addresses a machine is reached by: its ssh target without the user, the host name ssh's own config
 * resolves it to (`ssh -G`, which connects nowhere), and its paired peer addresses.
 */
export async function reachHosts(ssh: string, peerAddrs: string[]): Promise<string[]> {
    const hosts = [ssh.slice(ssh.indexOf("@") + 1), ...peerAddrs.map(addressHost)];
    if (ssh !== "") {
        const config = await runAsync(["ssh", "-G", ssh], { timeoutMs: SSH_CONFIG_MS });
        const resolved = config.code === 0 ? /^hostname (\S+)$/m.exec(config.stdout)?.[1] : undefined;
        if (resolved !== undefined) hosts.unshift(resolved);
    }
    return [...new Set(hosts.filter((host) => host !== "").map((host) => host.toLowerCase()))];
}

/** Why a probe failed, with this machine's NetBird view when it has one (`unreachable: ` left to the caller). */
export async function unreachableReason(
    failure: ProbeFailure,
    machine: { ssh: string; peerAddrs: string[] },
    netbird: () => Promise<Netbird | null>,
    at: Date,
): Promise<string> {
    const view = await netbird();
    const hosts = view === null ? [] : await reachHosts(machine.ssh, machine.peerAddrs);
    return explainUnreachable(failure, view, hosts, at);
}
