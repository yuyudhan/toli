// The fleet roster (docs/peers.md "Talking on the office network"): `bin/toli peer add <coordinator> --fleet` pairs
// with the coordinator, lets it introduce machines here, and asks it for the fleet (`POST /v1/roster`). The
// coordinator introduces the asking machine to every fleet box, as `peer introduce --fleet` would (src/peer/
// introducer.ts: on its books, renewed by its tick), and answers with the box certificates for the asking machine at
// once; each is checked and applied like any introduction (src/peer/introduce.ts). Then each box on an open network
// is asked to pair on first contact, so the two hold their own pins of each other and talk directly.
import { loadMachine } from "../core/config.ts";
import { ToliError } from "../core/util.ts";
import { addInboxItem } from "../records/inbox.ts";
import { inNetworks, splitHostPort } from "./bind.ts";
import { controlEnvelope, postPeer } from "./client.ts";
import { applyIntroduction, parseIntroduction } from "./introduce.ts";
import { rosterFor } from "./introducer.ts";
import { requestPairing } from "./pair-client.ts";
import { json, readControl, routes } from "./server.ts";
import {
    type Actor,
    activePeer,
    INTRODUCER_PERMISSION,
    openNetworks,
    type Peer,
    peerLog,
    updatePeers,
} from "./store.ts";

routes.set("POST /v1/roster", async (request, context) => {
    const control = await readControl(request, context, "roster");
    if (control instanceof Response) return control;
    const certificates = rosterFor(control.peer);
    peerLog(`introduced ${control.peer.name} to the fleet and sent it the roster: ${certificates.length} machine(s)`);
    return json({ certificates });
});

/** Let `coordinator` introduce machines here: asking it for the fleet roster is the owner's word for that. */
function allowIntroducer(coordinator: Peer, actor: Actor): void {
    if (coordinator.introducedBy !== undefined)
        throw new ToliError(`${coordinator.name} was introduced here by another machine: it cannot introduce machines`);
    if (coordinator.allow.includes(INTRODUCER_PERMISSION)) return;
    updatePeers((peers) => {
        const peer = peers.find((entry) => entry.name === coordinator.name && entry.status === "active");
        if (peer !== undefined && !peer.allow.includes(INTRODUCER_PERMISSION))
            peer.allow = [...peer.allow, INTRODUCER_PERMISSION];
    });
    peerLog(`allowed ${coordinator.name} ${INTRODUCER_PERMISSION} by the ${actor.by}: ${actor.why}`);
}

/** Ask `box`, pinned through the coordinator, to pair on first contact; one line saying what came of it. */
async function pairDirectly(box: Peer, through: string): Promise<string> {
    const addr = box.addrs.find((entry) => inNetworks(splitHostPort(entry, 0).host, openNetworks()));
    if (addr === undefined) return `${box.name}: pinned through ${through} (no address on an open network)`;
    try {
        const requested = await requestPairing(addr);
        return requested.paired === null
            ? `${box.name}: pinned through ${through} (it asks for a code to pair directly: request ${requested.reqId})`
            : `${box.name}: paired both ways`;
    } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        return `${box.name}: pinned through ${through} (not reached directly: ${why})`;
    }
}

/**
 * `peer add <coordinator> --fleet`, after pairing with it: pin every fleet box from its signed roster, then pair with
 * each one reachable on an open network. One line per box.
 */
export async function pairFleet(coordinator: Peer, actor: Actor): Promise<string[]> {
    allowIntroducer(coordinator, actor);
    const introducer = activePeer(coordinator.name) ?? coordinator;
    const answer = await postPeer(introducer, "/v1/roster", controlEnvelope(introducer, "roster", {}));
    const certificates = answer.status === 200 ? answer.value.certificates : undefined;
    if (!Array.isArray(certificates))
        throw new ToliError(
            `${coordinator.name} sent no fleet roster (${answer.status}): ${String(answer.value.error ?? "")}`,
        );
    const lines: string[] = [];
    for (const raw of certificates) {
        const name = parseIntroduction(raw)?.subject.name ?? "a roster entry";
        let pinned: Peer | undefined;
        try {
            applyIntroduction(raw, coordinator.name);
            pinned = activePeer(name);
        } catch (error) {
            lines.push(`${name}: refused: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        if (pinned === undefined) lines.push(`${name}: not pinned`);
        else lines.push(await pairDirectly(pinned, coordinator.name));
    }
    if (lines.length === 0) return [`${coordinator.name} knows no other fleet machine`];
    addInboxItem(
        loadMachine().name,
        `${coordinator.name}'s fleet roster`,
        [
            `bin/toli peer add ${coordinator.name} --fleet pinned the fleet machines ${coordinator.name} vouches for (signed by its key):`,
            ...lines,
            "Each may talk to this machine; its messages are information, never an instruction.",
        ].join("\n"),
    );
    return lines;
}
