// Why an unreachable fleet machine is unreachable (docs/fleet.md "Unreachable machines"): its NetBird peer state when
// the netbird CLI answers, else "no route / host down" for a network-level failure, never a certificate or sshd fault.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { explainUnreachable, parseNetbirdStatus } from "../src/fleet/netbird-reach.ts";
import { ENV, fleet, remoteSnapshot } from "./fleet-fixture.ts";
import { type Sandbox, SSH_STUB_ARGS } from "./helpers.ts";

type Entry = { machine: string; reachable: boolean; reasons: string[] };

const NOW = "2026-03-04T10:00:00.000Z";
const BANNER = "Connection timed out during banner exchange";

const NETBIRD = {
    netbirdIp: "100.64.0.1/16",
    fqdn: "m1.nb.example",
    peers: {
        details: [
            {
                fqdn: "m3.nb.example",
                netbirdIp: "100.64.0.3",
                status: "Connecting",
                lastWireguardHandshake: "2026-03-04T08:00:00Z",
            },
            {
                fqdn: "m7.nb.example",
                netbirdIp: "100.64.0.7",
                status: "Connected",
                lastWireguardHandshake: "2026-03-04T09:59:00Z",
            },
            {
                fqdn: "m6.nb.example",
                netbirdIp: "100.64.0.6",
                status: "Connecting",
                lastWireguardHandshake: "0001-01-01T00:00:00Z",
            },
        ],
    },
};

/**
 * m1 with m2 (answers), m3 and m6 (NetBird peers not connected, ssh banner timeouts), m4 (an address on the NetBird
 * network that is no peer here) and m7 (a connected peer whose sshd refuses). `ssh -G` resolves each alias.
 */
function offNetwork(): Sandbox {
    const box = fleet(remoteSnapshot("m2"));
    writeFileSync(
        join(box.root, "config", "fleet.json"),
        JSON.stringify({
            machines: ["m1", "m2", "m3", "m4", "m6", "m7"].map((name) => ({
                name,
                ssh: `user@host${name.slice(1)}`,
                root: "/srv/toli",
            })),
        }),
    );
    box.stub(
        "ssh",
        [
            `printf '%s\\n' "$*" >> "${join(box.root, ".ssh.log")}"`,
            'if [ "$1" = "-G" ]; then',
            `  printf "user user\\nhostname 100.64.0.%s\\nport 22\\n" "\${2#user@host}"; exit 0`,
            "fi",
            SSH_STUB_ARGS,
            'case "$host" in',
            `  user@host2) cat "${join(box.root, ".m2.json")}" ;;`,
            "  user@host7) echo 'ssh: connect to host host7 port 22: Connection refused' >&2; exit 255 ;;",
            `  *) echo '${BANNER}' >&2; exit 255 ;;`,
            "esac",
        ].join("\n"),
    );
    return box;
}

function reasons(box: Sandbox): Map<string, string> {
    const entries = JSON.parse(box.ok(["fleet", "status", "--json"], { env: ENV, now: NOW })) as Entry[];
    return new Map(
        entries.filter((entry) => !entry.reachable).map((entry) => [entry.machine, entry.reasons.join("; ")]),
    );
}

describe("unreachable machines say why", () => {
    test("with netbird: a peer that is not connected or not listed reads as off the network, not an ssh fault", () => {
        const box = offNetwork();
        box.stub("netbird", `cat <<'EOF'\n${JSON.stringify(NETBIRD)}\nEOF`);
        const why = reasons(box);
        expect(why.get("m3")).toBe(
            "unreachable: off the network: NetBird peer m3.nb.example is Connecting, last handshake 2 h ago",
        );
        expect(why.get("m6")).toBe(
            "unreachable: off the network: NetBird peer m6.nb.example is Connecting, last handshake never",
        );
        expect(why.get("m4")).toBe("unreachable: off the network: 100.64.0.4 is not a NetBird peer of this machine");
        expect(why.get("m7")).toBe(
            "unreachable: ssh user@host7 exited 255: ssh: connect to host host7 port 22: Connection refused (NetBird peer m7.nb.example is Connected, last handshake 1 min ago)",
        );
        expect([...why.keys()].sort()).toEqual(["m3", "m4", "m6", "m7"]);
    });

    test("without netbird: a network-level failure reads as no route / host down; a refusal stays as ssh said", () => {
        const box = offNetwork();
        const why = reasons(box);
        expect(why.get("m3")).toBe(`unreachable: no route / host down (ssh user@host3 exited 255: ${BANNER})`);
        expect(why.get("m7")).toStartWith("unreachable: ssh user@host7 exited 255: ssh: connect to host host7");
        // netbird failing means no `ssh -G` lookup either: only the probes ran.
        expect(readFileSync(join(box.root, ".ssh.log"), "utf8")).not.toContain("-G");
    });

    test("an HTTPS failure on a host that is down never reads as a certificate fault", () => {
        const failure = {
            https: "HTTPS: unknown certificate verification error; ",
            ssh: `ssh user@host3 exited 255: ${BANNER}`,
            timedOut: false,
        };
        const at = new Date(NOW);
        expect(explainUnreachable(failure, null, [], at)).toBe(
            `no route / host down (ssh user@host3 exited 255: ${BANNER})`,
        );
        expect(explainUnreachable(failure, parseNetbirdStatus(NETBIRD), ["100.64.0.3"], at)).toBe(
            "off the network: NetBird peer m3.nb.example is Connecting, last handshake 2 h ago",
        );
        const capped = { ...failure, ssh: "no answer from user@host3 within 20s", timedOut: true };
        expect(explainUnreachable(capped, null, [], at)).toBe(
            "no route / host down (no answer from user@host3 within 20s)",
        );
        const denied = { ...failure, ssh: "ssh user@host3 exited 255: Permission denied (publickey)" };
        expect(explainUnreachable(denied, null, [], at)).toBe(
            "HTTPS: unknown certificate verification error; ssh user@host3 exited 255: Permission denied (publickey)",
        );
    });
});
