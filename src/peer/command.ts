// `bin/toli peer ...` (docs/peers.md): this installation's identity, its paired peers and their permissions, pairing
// with a 4-digit code, the HTTPS listener, discovery and delivery timings.
import { Args } from "../core/args.ts";
import { hasMachine, loadMachine } from "../core/config.ts";
import { isJsonObject, out, pidAlive, printJson, readStdin, ToliError } from "../core/util.ts";
import { bindAddresses } from "./bind.ts";
import { applyBatch } from "./envelope.ts";
import { hasIdentity, initIdentity, loadIdentity, spokenFingerprint } from "./identity.ts";
import { controlRequest, type ListenerRecord, readListener, runListener } from "./server.ts";
import { loadPeers, type Peer, peerSettings, updatePeerSettings } from "./store.ts";

const USAGE = `usage: toli peer init | status [--json] | list [--json] | apply (envelopes on stdin)
  peer serve | listen on|off | set [--port <n>] [--bind private|<ip,...>] [--ssh-fallback on|off]`;

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
    const args = new Args(argv, { values: ["port", "bind", "ssh-fallback"] });
    args.maxPositional(0);
    const port = args.str("port");
    const bind = args.str("bind");
    const fallback = args.str("ssh-fallback");
    if (port === undefined && bind === undefined && fallback === undefined)
        throw new ToliError("peer set needs --port, --bind or --ssh-fallback");
    const portNumber = port === undefined ? undefined : Number(port);
    if (portNumber !== undefined && (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535))
        throw new ToliError("--port must be 1-65535");
    const bindList = bind === undefined || bind === "private" ? bind : bind.split(",").map((ip) => ip.trim());
    if (Array.isArray(bindList)) bindAddresses(bindList);
    updatePeerSettings((settings) => {
        if (portNumber !== undefined) settings.port = portNumber;
        if (bindList !== undefined) settings.bind = bindList as "private" | string[];
        if (fallback !== undefined) settings.sshFallback = onOff(fallback, "--ssh-fallback");
    });
    const now = peerSettings();
    out(
        `peer settings: port ${now.port}, bind ${Array.isArray(now.bind) ? now.bind.join(",") : now.bind}, ssh fallback ${now.sshFallback ? "on" : "off"}`,
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
        default:
            throw new ToliError(USAGE);
    }
}
