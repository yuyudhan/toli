// `bin/toli peer ...` (docs/peers.md): this installation's identity, its paired peers and their permissions, pairing
// with a 4-digit code, the HTTPS listener, discovery and delivery timings.
import { Args } from "../core/args.ts";
import { hasMachine, loadMachine } from "../core/config.ts";
import { isJsonObject, out, printJson, readStdin, ToliError } from "../core/util.ts";
import { scanCommand } from "./discover.ts";
import { applyBatch } from "./envelope.ts";
import { hasIdentity, initIdentity, loadIdentity, spokenFingerprint } from "./identity.ts";
import { introduceCommand, receiveIntroduction, removeCommand } from "./introduce-command.ts";
import { acceptRequest, declineRequest, lifetimeText, loadRequests } from "./pair.ts";
import { completePairing, requestPairing } from "./pair-client.ts";
import { pairFleet } from "./roster.ts";
import { rotateIdentity } from "./rotate.ts";
import { runListener } from "./server.ts";
import { listenCommand, setCommand } from "./settings-command.ts";
import {
    actorFrom,
    GRANTS,
    INTRODUCER_PERMISSION,
    isGrant,
    loadPeers,
    type Peer,
    peerLog,
    peerSettings,
    requirePeer,
    updatePeers,
} from "./store.ts";
import { liveListener } from "./supervise.ts";
import { askCommand, flushCommand, pullCommand, statsCommand } from "./transport-command.ts";
import { trustCommand } from "./trust.ts";

const USAGE = `usage: toli peer init | status [--json] | list [--json] [--introduced-by <peer>] | apply (envelopes on stdin) | introduction --from <introducer> (certificate on stdin)
  peer serve | listen on|off | set [--port <n>] [--bind private|<ip,...>] [--interfaces <name,...>|none]
    [--ssh-fallback on|off] [--introducer-cap <permission,...>] [--open-networks <cidr,...>|none]
  peer add <host[:port]> [--fleet] [--code NNNN] [--by owner|sardar] [--why "..."] | requests [--json]
  peer accept <request> [--by owner|sardar] [--why "..."] | decline <request> [--why "..."]
  peer trust <peer> --key <key> --via <relay> [--by owner|sardar] [--why "..."]
  peer allow|deny <peer> <talk|delegate|share|answer|status|introduce> [--why "..."] | remove <peer> [--fleet] [--why "..."]
  peer introduce <peer> --fleet|--to <box,...> [--grants <permission,...>] [--by owner|sardar] [--why "..."]
  peer introduce --status <peer> | --sync | --emit-trust-script <peer> | remove --introduced-by <peer> [--why "..."]
  peer flush <peer>|--all [--json] | pull [--json] | stats [--peer <p>] [--json] | ask <peer> status [--json] | rotate
  peer scan [--netbird] [--tailscale] [--subnet <cidr>] [--port <n>] [--json]`;

const ACTOR_VALUES = ["by", "why"];

/**
 * `peer add <host> [--fleet] [--code NNNN]`: ask the host to pair. On an open network that pairs both ways at once;
 * elsewhere the host's owner shows a code and `--code` finishes. `--fleet` (the host is the fleet's coordinator) also
 * pins every fleet box from its signed roster and pairs with each one it reaches (src/peer/roster.ts).
 */
async function add(argv: string[]): Promise<void> {
    const args = new Args(argv, { booleans: ["fleet"], values: ["code", ...ACTOR_VALUES] });
    args.maxPositional(1);
    const target = args.pos(0, "host");
    const code = args.str("code");
    const actor = actorFrom(args.str("by"), args.str("why"));
    let peer: Peer;
    if (code === undefined) {
        const { hello, reqId, paired, already } = await requestPairing(target);
        if (paired === null) {
            out(
                [
                    `asked ${hello.name} to pair (request ${reqId}); its fingerprint: ${spokenFingerprint(hello.fingerprint)}`,
                    `${hello.name} is not on an open network here (bin/toli peer set --open-networks), so pairing takes a code.`,
                    `Ask its owner or Sardar to run \`bin/toli peer accept ${reqId}\` there and read you the`,
                    `4-digit code from its "Pairing code:" line (not a piece of the fingerprint), then:`,
                    `bin/toli peer add ${target} --code NNNN (the code works as long as its accept says: 10 minutes by default).`,
                ].join("\n"),
            );
            return;
        }
        peer = paired;
        out(
            already
                ? `already paired with ${peer.name} (fingerprint ${spokenFingerprint(peer.fingerprint)})`
                : `paired with ${peer.name} on first contact (fingerprint ${spokenFingerprint(peer.fingerprint)}); it may: ${peer.allow.join(", ")}`,
        );
    } else {
        peer = await completePairing(target, code, actor);
        out(
            `paired with ${peer.name} (fingerprint ${spokenFingerprint(peer.fingerprint)}); it may: ${peer.allow.join(", ")}`,
        );
    }
    if (args.bool("fleet")) out((await pairFleet(peer, actor)).join("\n"));
}

/** `peer accept <request>`: mint the 4-digit code; printed here only, never stored or logged. */
async function accept(argv: string[]): Promise<void> {
    const args = new Args(argv, { values: ACTOR_VALUES });
    args.maxPositional(1);
    const reqId = args.pos(0, "request");
    const accepted = await acceptRequest(reqId, actorFrom(args.str("by"), args.str("why")));
    const lifetime = lifetimeText(accepted.expiresAt - Date.now());
    out(
        [
            `Pairing code: ${accepted.code} (tell this to ${accepted.name}'s requester)`,
            `It works once within ${lifetime}. Tell it only after checking ${accepted.name}'s fingerprint with them:`,
            `fingerprint: ${spokenFingerprint(accepted.fingerprint)}`,
        ].join("\n"),
    );
}

function decline(argv: string[]): void {
    const args = new Args(argv, { values: ACTOR_VALUES });
    args.maxPositional(1);
    const name = declineRequest(args.pos(0, "request"), actorFrom(args.str("by"), args.str("why")));
    out(`declined the pairing request from ${name}`);
}

function requests(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const pending = loadRequests();
    if (args.bool("json")) {
        printJson(pending.map(({ cert: _cert, certSig: _sig, ...request }) => request));
        return;
    }
    if (pending.length === 0) {
        out("no pairing requests wait here");
        return;
    }
    for (const request of pending)
        out(
            `${request.reqId}\t${request.name}\t${request.source}\t${new Date(request.receivedAt).toISOString()}\t${request.fingerprint.slice(0, 16)}`,
        );
}

/** `peer allow|deny <peer> <permission>`: grant or revoke one permission, logged with who and why. */
function grant(argv: string[], allow: boolean): void {
    const args = new Args(argv, { values: ACTOR_VALUES });
    args.maxPositional(2);
    const name = args.pos(0, "peer");
    const permission = args.pos(1, "permission");
    if (!isGrant(permission)) throw new ToliError(`unknown permission "${permission}" (${GRANTS.join(", ")})`);
    const actor = actorFrom(args.str("by"), args.str("why"));
    const now = updatePeers((peers) => {
        const peer = peers.find((entry) => entry.name === name && entry.status === "active");
        if (peer === undefined) throw new ToliError(`no paired peer "${name}" (bin/toli peer list)`);
        if (allow && permission === INTRODUCER_PERMISSION && peer.introducedBy !== undefined)
            throw new ToliError(`${name} was introduced here by another machine: an introduced peer cannot introduce`);
        const others = peer.allow.filter((entry) => entry !== permission);
        peer.allow = allow ? GRANTS.filter((entry) => entry === permission || others.includes(entry)) : others;
        return peer.allow;
    });
    peerLog(`${allow ? "allowed" : "denied"} ${name} ${permission} by the ${actor.by}: ${actor.why}`);
    out(`${name} may now: ${now.join(", ") || "nothing"}`);
}

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
    out(`key: ${identity.key} (\`peer trust\` on a machine this one reaches only through a relay takes it)`);
    out(`certificate: ${identity.certFingerprint.slice(0, 16)}...`);
    const running = liveListener();
    out(
        `listener: ${settings.listen ? (running === null ? `on, not running (the lead service starts it; or bin/toli peer serve)` : `running (pid ${running.pid}) on ${running.addrs.join(", ") || "no private address yet"}`) : "off (this machine pulls from its peers)"}`,
    );
    out(`ssh fallback for paired peers: ${settings.sshFallback ? "on" : "off"}`);
    out(`peers: ${peers.filter((peer) => peer.status === "active").length} active, ${peers.length} recorded`);
}

/**
 * One `peer list` row: name, its user's first name (`-` for none yet), status, permissions, addresses, fingerprint,
 * and for an introduced pin the date it expires.
 */
function peerLine(peer: Peer): string {
    const addrs = peer.addrs.length === 0 ? "no address yet" : peer.addrs.join(", ");
    const until = peer.notAfter === undefined ? "" : `\tintroduced, until ${peer.notAfter.slice(0, 10)}`;
    return `${peer.name}\t${peer.person ?? "-"}\t${peer.status}\t${peer.allow.join(",") || "nothing"}\t${addrs}\t${peer.fingerprint.slice(0, 16)}${until}`;
}

function list(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json"], values: ["introduced-by"] });
    args.maxPositional(0);
    const by = args.str("introduced-by");
    const introducer = by === undefined ? undefined : requirePeer(by).fingerprint;
    const peers = loadPeers().filter((peer) => introducer === undefined || peer.introducedBy === introducer);
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

export async function peerCommand(argv: string[]): Promise<number> {
    const [sub, ...rest] = argv;
    switch (sub) {
        case "init":
            init(rest);
            return 0;
        case "status":
            status(rest);
            return 0;
        case "list":
            list(rest);
            return 0;
        case "apply":
            await apply(rest);
            return 0;
        case "serve":
            new Args(rest).maxPositional(0);
            return await runListener();
        case "listen":
            await listenCommand(rest);
            return 0;
        case "set":
            setCommand(rest);
            return 0;
        case "add":
            await add(rest);
            return 0;
        case "accept":
            await accept(rest);
            return 0;
        case "decline":
            decline(rest);
            return 0;
        case "requests":
            requests(rest);
            return 0;
        case "allow":
        case "deny":
            grant(rest, sub === "allow");
            return 0;
        case "scan":
            await scanCommand(rest);
            return 0;
        case "pull":
            await pullCommand(rest);
            return 0;
        case "flush":
            await flushCommand(rest);
            return 0;
        case "stats":
            statsCommand(rest);
            return 0;
        case "ask":
            await askCommand(rest);
            return 0;
        case "rotate": {
            new Args(rest).maxPositional(0);
            const { told, missed } = await rotateIdentity();
            out(`new key: ${spokenFingerprint(loadIdentity().fingerprint)}`);
            out(`told: ${told.join(", ") || "nobody"}`);
            if (missed.length > 0) out(`not reached (they must pair again): ${missed.join(", ")}`);
            return 0;
        }
        case "remove":
            removeCommand(rest);
            return 0;
        case "trust":
            trustCommand(rest);
            return 0;
        case "introduction":
            receiveIntroduction(rest);
            return 0;
        case "introduce":
            introduceCommand(rest);
            return 0;
        default:
            throw new ToliError(USAGE);
    }
}
