// `bin/toli peer ...` (docs/peers.md): this installation's identity, its paired peers and their permissions, pairing
// with a 4-digit code, the HTTPS listener, discovery and delivery timings.
import { Args } from "../core/args.ts";
import { hasMachine, loadMachine } from "../core/config.ts";
import { isJsonObject, out, printJson, readStdin, ToliError } from "../core/util.ts";
import { applyBatch } from "./envelope.ts";
import { hasIdentity, initIdentity, loadIdentity, spokenFingerprint } from "./identity.ts";
import { loadPeers, type Peer, peerSettings } from "./store.ts";

const USAGE = "usage: toli peer init | status [--json] | list [--json] | apply (envelopes on stdin)";

/**
 * `peer apply`: the ssh transport's receiver. Stdin is `{envelopes: [...]}` (or one envelope); prints `{receipts}`.
 * The same checks as over HTTPS: the signature, not the ssh login, says who sent each one.
 */
async function apply(argv: string[]): Promise<void> {
    new Args(argv).maxPositional(0);
    let value: unknown;
    try {
        value = JSON.parse(readStdin());
    } catch {
        throw new ToliError("peer apply needs envelope JSON on stdin");
    }
    const envelopes = isJsonObject(value) && Array.isArray(value.envelopes) ? value.envelopes : [value];
    printJson({ receipts: await applyBatch(envelopes, loadIdentity().fingerprint) });
}

function init(argv: string[]): void {
    new Args(argv).maxPositional(0);
    const made = initIdentity();
    const identity = loadIdentity();
    out(made ? "peer identity made (config/peer/)" : "peer identity already here (config/peer/)");
    out(`fingerprint: ${spokenFingerprint(identity.fingerprint)}`);
}

function status(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const settings = peerSettings();
    if (!hasIdentity()) {
        if (args.bool("json")) printJson({ identity: false, settings });
        else out("no peer identity here: run `bin/toli peer init`");
        return;
    }
    const identity = loadIdentity();
    const peers = loadPeers();
    if (args.bool("json")) {
        printJson({
            identity: true,
            name: hasMachine() ? loadMachine().name : null,
            key: identity.key,
            fingerprint: identity.fingerprint,
            cert: identity.certPem,
            certFingerprint: identity.certFingerprint,
            certSig: identity.certSig,
            settings,
            peers: peers.length,
        });
        return;
    }
    out(`fingerprint: ${spokenFingerprint(identity.fingerprint)}`);
    out(`certificate: ${identity.certFingerprint.slice(0, 16)}...`);
    out(
        `listener: ${settings.listen ? `on, port ${settings.port}, bind ${Array.isArray(settings.bind) ? settings.bind.join(", ") : settings.bind}` : "off (this machine pulls from its peers)"}`,
    );
    out(`ssh fallback for paired peers: ${settings.sshFallback ? "on" : "off"}`);
    out(`peers: ${peers.filter((peer) => peer.status === "active").length} active, ${peers.length} recorded`);
}

function peerLine(peer: Peer): string {
    const addrs = peer.addrs.length === 0 ? "no address yet" : peer.addrs.join(", ");
    return `${peer.name}\t${peer.status}\t${peer.allow.join(",") || "nothing"}\t${addrs}\t${peer.fingerprint.slice(0, 16)}`;
}

function list(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const peers = loadPeers();
    if (args.bool("json")) {
        printJson(peers.map(({ cert: _cert, ...peer }) => peer));
        return;
    }
    if (peers.length === 0) {
        out("no peers paired yet: bin/toli peer add <host>");
        return;
    }
    for (const peer of peers) out(peerLine(peer));
}

export async function peerCommand(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;
    switch (sub) {
        case "init":
            init(rest);
            return;
        case "status":
            status(rest);
            return;
        case "list":
            list(rest);
            return;
        case "apply":
            await apply(rest);
            return;
        default:
            throw new ToliError(USAGE);
    }
}
