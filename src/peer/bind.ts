// Which addresses the listener binds (docs/peers.md "The listener"). By default ("private") every local interface
// address in a private range: 10/8, 172.16/12, 192.168/16, 100.64/10 (CGNAT, which NetBird and Tailscale use) and
// IPv6 ULA fd00::/8. Never a wildcard (0.0.0.0, ::), a loopback, a link-local or a public address unless config lists
// it explicitly (`peer.bind`). `TOLI_PEER_BIND` (a comma list) overrides both, for tests.
import { isIP } from "node:net";
import { type NetworkInterfaceInfo, networkInterfaces } from "node:os";
import { ToliError } from "../core/util.ts";

function ipv4Parts(ip: string): number[] {
    return ip.split(".").map(Number);
}

/** Whether `ip` is in a private range the default bind uses (see the header). */
export function isPrivateAddress(ip: string): boolean {
    if (isIP(ip) === 4) {
        const [a = -1, b = -1] = ipv4Parts(ip);
        return (
            a === 10 ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 100 && b >= 64 && b <= 127)
        );
    }
    if (isIP(ip) === 6) return /^fd[0-9a-f]{2}:/i.test(ip);
    return false;
}

/** The private addresses of `interfaces` (the machine's by default), sorted, without duplicates. */
export function privateAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
    const found = new Set<string>();
    for (const entries of Object.values(interfaces))
        for (const entry of entries ?? [])
            if (!entry.internal && isPrivateAddress(entry.address)) found.add(entry.address);
    return [...found].sort();
}

/** The addresses to bind now: TOLI_PEER_BIND, else an explicit `peer.bind` list, else the private ones. */
export function bindAddresses(bind: "private" | string[]): string[] {
    const override = process.env.TOLI_PEER_BIND;
    const list = override !== undefined && override !== "" ? override.split(",").map((entry) => entry.trim()) : bind;
    if (list === "private") return privateAddresses();
    for (const ip of list) if (isIP(ip) === 0) throw new ToliError(`peer.bind: "${ip}" is not an IP address`);
    return [...new Set(list)];
}

/** `host:port`, bracketing an IPv6 host. */
export function hostPort(host: string, port: number): string {
    return isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

/** Split `host[:port]` (IPv6 in brackets) into its parts; the port defaults to `defaultPort`. */
export function splitHostPort(value: string, defaultPort: number): { host: string; port: number } {
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
    if (bracketed)
        return { host: bracketed[1] as string, port: bracketed[2] === undefined ? defaultPort : Number(bracketed[2]) };
    if (isIP(value) === 6) return { host: value, port: defaultPort };
    const colon = value.lastIndexOf(":");
    if (colon < 0) return { host: value, port: defaultPort };
    const port = Number(value.slice(colon + 1));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new ToliError(`bad port in "${value}"`);
    return { host: value.slice(0, colon), port };
}
