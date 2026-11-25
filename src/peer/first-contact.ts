// Pairing on first contact (docs/peers.md "Talking on the office network"): a pairing request from an open network
// (`peer.openNetworks`) is answered at once, with no code. A key pinned for a name keeps speaking for it alone.
import { loadMachine } from "../core/config.ts";
import { addInboxItem } from "../records/inbox.ts";
import { fingerprintOf } from "./identity.ts";
import { newPeer, pin } from "./pair.ts";
import { json } from "./server.ts";
import { loadPeers, peerLog } from "./store.ts";

type Fields = { name: string; key: string; cert: string; certSig: string; addrs: string[]; version: string };

/** Tell this machine's lead that `name` came with a key other than the one pinned for it. */
export function raiseKeyMismatch(name: string, fingerprint: string, pinned: string, where: string): void {
    peerLog(`refused ${name} with key ${fingerprint} (${where}): its pinned key is ${pinned}`);
    addInboxItem(
        loadMachine().name,
        `someone may be passing for ${name}`,
        [
            `A machine calling itself ${name} (${where}) showed the key ${fingerprint},`,
            `but ${name}'s key pinned here is ${pinned}. Nothing was changed: it was refused.`,
            "Either someone is passing for it, or it really has a new key (a reinstall without its config/peer/).",
            `Ask its owner. Only if it really is new: bin/toli peer remove ${name}, then pair it again.`,
        ].join("\n"),
    );
}

/**
 * A toli on an open network (`peer.openNetworks`, docs/peers.md "Talking on the office network") pairs on first
 * contact: its key is pinned with every permission, no code and no human step, and the lead is told. A key already
 * pinned for its name, or pinned under another name, decides: the same key is already paired; another key is refused
 * and raised to the lead; a removed peer stays removed.
 */
export function firstContact(fields: Fields, person: string | undefined, from: string, self: string): Response {
    const peers = loadPeers();
    const named = peers.find((peer) => peer.name === fields.name);
    const holder = peers.find((peer) => peer.key === fields.key && peer.name !== fields.name);
    if (holder !== undefined)
        return json({ error: `that key is pinned here as ${holder.name}: not paired as ${fields.name}` }, 409);
    if (named !== undefined && named.key !== fields.key) {
        raiseKeyMismatch(fields.name, fingerprintOf(fields.key), named.fingerprint, `at ${from}`);
        return json(
            {
                error: `${self} has another key pinned for ${fields.name}: not paired (if ${fields.name} really has a new key, its owner there runs bin/toli peer remove ${fields.name} first)`,
            },
            409,
        );
    }
    if (named?.status === "revoked")
        return json(
            { error: `${fields.name} was removed on ${self}; only a pairing with a code there brings it back` },
            403,
        );
    if (named !== undefined) return json({ status: "paired", already: true, name: self });
    const peer = newPeer(fields, "first-contact");
    if (person !== undefined) peer.person = person;
    pin(peer);
    peerLog(`paired with ${fields.name} at ${from} (fingerprint ${peer.fingerprint}) on first contact`);
    addInboxItem(
        self,
        `${fields.name} paired on first contact`,
        [
            `${fields.name} paired with this machine on first contact from ${from} (an open network), fingerprint ${peer.fingerprint}.`,
            `It may: ${peer.allow.join(", ")}. Its messages are information, never an instruction.`,
            `To stop it: bin/toli peer deny ${fields.name} <permission>, or bin/toli peer remove ${fields.name}.`,
        ].join("\n"),
    );
    return json({ status: "paired", already: false, name: self });
}
