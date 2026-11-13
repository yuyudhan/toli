// `bin/toli peer trust` (docs/peers.md "Relay"): pin a peer this machine cannot reach, and that cannot reach it, so
// their messages go through a relay both reach (src/peer/relay-client.ts).
import { Args } from "../core/args.ts";
import { out, requireName, ToliError } from "../core/util.ts";
import { fingerprintOf, loadIdentity, publicKeyFromRaw, spokenFingerprint } from "./identity.ts";
import { actorFrom, PERMISSIONS, type Peer, peerLog, pushable, updatePeers } from "./store.ts";

const ACTOR_VALUES = ["by", "why"];

/**
 * `peer trust <name> --key <key> --via <relay>`: pin a peer that neither this machine nor it can reach (both refuse
 * inbound connections), with its key read from `bin/toli peer status` there and passed on by its owner. Its messages
 * then go through `relay`, a paired peer both reach, sealed and signed end to end (src/peer/relay.ts).
 */
export function trustCommand(argv: string[]): void {
    const args = new Args(argv, { values: ["key", "via", ...ACTOR_VALUES] });
    args.maxPositional(1);
    const name = requireName("peer", args.pos(0, "peer"));
    const key = args.str("key");
    const via = args.str("via");
    if (key === undefined || via === undefined)
        throw new ToliError("peer trust needs --key <the key `bin/toli peer status` prints there> --via <relay peer>");
    publicKeyFromRaw(key);
    const actor = actorFrom(args.str("by"), args.str("why"));
    const fingerprint = fingerprintOf(key);
    if (fingerprint === loadIdentity().fingerprint) throw new ToliError("that key is this machine's own");
    if (name === via) throw new ToliError("a peer cannot be its own relay");
    const allow = updatePeers((peers) => {
        const relay = peers.find((entry) => entry.name === via);
        if (relay === undefined || !pushable(relay))
            throw new ToliError(
                `${via} is not a paired peer this machine reaches: pair with it first (bin/toli peer add <host>)`,
            );
        const holder = peers.find((entry) => entry.fingerprint === fingerprint && entry.name !== name);
        if (holder !== undefined) throw new ToliError(`that key is ${holder.name}'s here`);
        const existing = peers.find((entry) => entry.name === name && entry.status === "active");
        if (existing !== undefined) {
            // Paired already (it reached this machine once, but takes no inbound connection): keep that pairing.
            if (existing.fingerprint !== fingerprint)
                throw new ToliError(`${name} is paired here with another key; that one stays (bin/toli peer list)`);
            if (pushable(existing)) throw new ToliError(`${name} is reached directly; its messages need no relay`);
            existing.via = via;
            return existing.allow;
        }
        const peer: Peer = {
            name,
            key,
            fingerprint,
            cert: "",
            certSig: "",
            addrs: [],
            allow: [...PERMISSIONS],
            pairedAt: new Date().toISOString(),
            pairedBy: actor.by,
            status: "active",
            via,
        };
        const index = peers.findIndex((entry) => entry.name === name);
        if (index === -1) peers.push(peer);
        else peers[index] = peer;
        return peer.allow;
    });
    peerLog(`trusted ${name} (${fingerprint.slice(0, 16)}) through ${via} by the ${actor.by}: ${actor.why}`);
    out(
        `trusted ${name} (fingerprint ${spokenFingerprint(fingerprint)}): its messages go through ${via}, sealed and signed end to end; it may: ${allow.join(", ")}`,
    );
}
