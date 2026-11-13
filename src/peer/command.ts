// `bin/toli peer ...` (docs/peers.md): this installation's identity, its paired peers and their permissions, pairing
// with a 4-digit code, the HTTPS listener, discovery and delivery timings.
import { Args } from "../core/args.ts";
import { hasMachine, loadMachine } from "../core/config.ts";
import { isJsonObject, out, pidAlive, printJson, readStdin, ToliError } from "../core/util.ts";
import { cancelItems, itemsFor } from "../jobs/outbox-admin.ts";
import { bindAddresses } from "./bind.ts";
import { rotateIdentity } from "./deliver.ts";
import { scanCommand } from "./discover.ts";
import { applyBatch } from "./envelope.ts";
import { hasIdentity, initIdentity, loadIdentity, spokenFingerprint } from "./identity.ts";
import { acceptRequest, declineRequest, loadRequests } from "./pair.ts";
import { completePairing, requestPairing } from "./pair-client.ts";
import { controlRequest, type ListenerRecord, readListener, runListener } from "./server.ts";
import {
    actorFrom,
    isPermission,
    loadPeers,
    PERMISSIONS,
    type Peer,
    peerLog,
    peerSettings,
    updatePeerSettings,
    updatePeers,
} from "./store.ts";
import { askCommand, flushCommand, pullCommand, statsCommand } from "./transport-command.ts";

const USAGE = `usage: toli peer init | status [--json] | list [--json] | apply (envelopes on stdin)
  peer serve | listen on|off | set [--port <n>] [--bind private|<ip,...>] [--interfaces <name,...>|none]
    [--ssh-fallback on|off]
  peer add <host[:port]> [--code NNNN] [--by owner|sardar] [--why "..."] | requests [--json]
  peer accept <request> [--by owner|sardar] [--why "..."] | decline <request> [--why "..."]
  peer allow|deny <peer> <talk|delegate|share|answer|status> [--why "..."] | remove <peer> [--why "..."]
  peer flush <peer>|--all [--json] | pull [--json] | stats [--peer <p>] [--json] | ask <peer> status [--json] | rotate
  peer scan [--netbird] [--tailscale] [--subnet <cidr>] [--port <n>] [--json]`;

const ACTOR_VALUES = ["by", "why"];

/** `peer add <host> [--code NNNN]`: ask the host to pair, then (with the code its side shows) finish pairing. */
async function add(argv: string[]): Promise<void> {
    const args = new Args(argv, { values: ["code", ...ACTOR_VALUES] });
    args.maxPositional(1);
    const target = args.pos(0, "host");
    const code = args.str("code");
    const actor = actorFrom(args.str("by"), args.str("why"));
    if (code === undefined) {
        const { hello, reqId } = await requestPairing(target);
        out(
            [
                `asked ${hello.name} to pair (request ${reqId}); its fingerprint: ${spokenFingerprint(hello.fingerprint)}`,
                `Ask its owner or Sardar to run \`bin/toli peer accept ${reqId}\` there and read you the`,
                `4-digit code from its "Pairing code:" line (not a piece of the fingerprint), then:`,
                `bin/toli peer add ${target} --code NNNN (the code lives 2 minutes).`,
            ].join("\n"),
        );
        return;
    }
    const peer = await completePairing(target, code, actor);
    out(
        `paired with ${peer.name} (fingerprint ${spokenFingerprint(peer.fingerprint)}); it may: ${peer.allow.join(", ")}`,
    );
}

/** `peer accept <request>`: mint the 4-digit code; printed here only, never stored or logged. */
async function accept(argv: string[]): Promise<void> {
    const args = new Args(argv, { values: ACTOR_VALUES });
    args.maxPositional(1);
    const reqId = args.pos(0, "request");
    const accepted = await acceptRequest(reqId, actorFrom(args.str("by"), args.str("why")));
    const seconds = Math.round((accepted.expiresAt - Date.now()) / 1000);
    out(
        [
            `Pairing code: ${accepted.code} (tell this to ${accepted.name}'s requester)`,
            `It works once within ${seconds} s. Tell it only after checking ${accepted.name}'s fingerprint with them:`,
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
    if (!isPermission(permission))
        throw new ToliError(`unknown permission "${permission}" (${PERMISSIONS.join(", ")})`);
    const actor = actorFrom(args.str("by"), args.str("why"));
    const now = updatePeers((peers) => {
        const peer = peers.find((entry) => entry.name === name && entry.status === "active");
        if (peer === undefined) throw new ToliError(`no paired peer "${name}" (bin/toli peer list)`);
        const others = peer.allow.filter((entry) => entry !== permission);
        peer.allow = allow ? PERMISSIONS.filter((entry) => entry === permission || others.includes(entry)) : others;
        return peer.allow;
    });
    peerLog(`${allow ? "allowed" : "denied"} ${name} ${permission} by the ${actor.by}: ${actor.why}`);
    out(`${name} may now: ${now.join(", ") || "nothing"}`);
}

/** `peer remove <peer>`: revoke it; its key is refused from now on (kept as `revoked`, not forgotten). */
function remove(argv: string[]): void {
    const args = new Args(argv, { values: ACTOR_VALUES });
    args.maxPositional(1);
    const name = args.pos(0, "peer");
    const actor = actorFrom(args.str("by"), args.str("why"));
    updatePeers((peers) => {
        const peer = peers.find((entry) => entry.name === name && entry.status === "active");
        if (peer === undefined) throw new ToliError(`no paired peer "${name}" (bin/toli peer list)`);
        peer.status = "revoked";
        peer.revokedAt = new Date().toISOString();
        peer.allow = [];
    });
    peerLog(`removed ${name} by the ${actor.by}: ${actor.why}`);
    const cancelled = cancelItems(
        itemsFor(name).map(({ file }) => file),
        `${name} was removed as a peer`,
    );
    out(
        `removed ${name}: its key is refused here from now on${cancelled.length > 0 ? `; ${cancelled.length} queued item(s) for it moved to state/outbox/cancelled/` : ""}`,
    );
}

/** The running listener's record, or null when none runs. */
function liveListener(): ListenerRecord | null {
    const record = readListener();
    return record !== null && pidAlive(record.pid) ? record : null;
}

async function listen(argv: string[]): Promise<void> {
    const args = new Args(argv);
    args.maxPositional(1);
    const mode = args.pos(0, "on|off");
    if (mode !== "on" && mode !== "off") throw new ToliError("usage: toli peer listen on|off");
    updatePeerSettings((settings) => {
        settings.listen = mode === "on";
    });
    if (mode === "on") {
        out("peer listener on: the lead service starts it within 15 s (or run bin/toli peer serve)");
        return;
    }
    const answered = await controlRequest("/stop", {});
    out(answered === null ? "peer listener off (none was running)" : "peer listener off: stopped");
}

function onOff(value: string, flag: string): boolean {
    if (value !== "on" && value !== "off") throw new ToliError(`${flag} takes on or off`);
    return value === "on";
}

function set(argv: string[]): void {
    const args = new Args(argv, { values: ["port", "bind", "interfaces", "ssh-fallback"] });
    args.maxPositional(0);
    const port = args.str("port");
    const bind = args.str("bind");
    const interfaces = args.str("interfaces");
    const fallback = args.str("ssh-fallback");
    if (port === undefined && bind === undefined && interfaces === undefined && fallback === undefined)
        throw new ToliError("peer set needs --port, --bind, --interfaces or --ssh-fallback");
    const portNumber = port === undefined ? undefined : Number(port);
    if (portNumber !== undefined && (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535))
        throw new ToliError("--port must be 1-65535");
    const bindList = bind === undefined || bind === "private" ? bind : bind.split(",").map((ip) => ip.trim());
    if (Array.isArray(bindList)) bindAddresses(bindList);
    // `--interfaces none` clears the list; names are kept as given (the interfaces may not exist yet).
    const named =
        interfaces === undefined
            ? undefined
            : interfaces === "none"
              ? []
              : interfaces
                    .split(",")
                    .map((name) => name.trim())
                    .filter((name) => name !== "");
    updatePeerSettings((settings) => {
        if (portNumber !== undefined) settings.port = portNumber;
        if (bindList !== undefined) settings.bind = bindList as "private" | string[];
        if (named !== undefined) settings.interfaces = named;
        if (fallback !== undefined) settings.sshFallback = onOff(fallback, "--ssh-fallback");
    });
    const now = peerSettings();
    out(
        `peer settings: port ${now.port}, bind ${Array.isArray(now.bind) ? now.bind.join(",") : now.bind}, interfaces ${now.interfaces.join(",") || "none"}, ssh fallback ${now.sshFallback ? "on" : "off"}`,
    );
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
    out(`certificate: ${identity.certFingerprint.slice(0, 16)}...`);
    const running = liveListener();
    out(
        `listener: ${settings.listen ? (running === null ? `on, not running (the lead service starts it; or bin/toli peer serve)` : `running (pid ${running.pid}) on ${running.addrs.join(", ") || "no private address yet"}`) : "off (this machine pulls from its peers)"}`,
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
            await listen(rest);
            return 0;
        case "set":
            set(rest);
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
            remove(rest);
            return 0;
        default:
            throw new ToliError(USAGE);
    }
}
