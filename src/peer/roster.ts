// The fleet roster (docs/peers.md "Talking on the office network"): `bin/toli peer add <coordinator> --fleet` pairs
// with the coordinator, lets it introduce machines here, and asks it for every fleet box it has pinned
// (`POST /v1/roster`). The coordinator answers with one introduction certificate per box, signed by its key and
// addressed to the asking machine alone; each is checked and applied like any introduction (src/peer/introduce.ts),
// so a box is pinned through the coordinator at once. Then each box on an open network is asked to pair on first
// contact, so it pins this machine too and the two talk directly.
import { loadMachine } from "../core/config.ts";
import { now, ToliError } from "../core/util.ts";
import { inNetworks, splitHostPort } from "./bind.ts";
import { controlEnvelope, postPeer } from "./client.ts";
import { loadIdentity } from "./identity.ts";
import { applyIntroduction, introId, parseIntroduction, pinExpiry, signIntroduction, subjectOf } from "./introduce.ts";
import { fleetBoxes } from "./introducer.ts";
import { requestPairing } from "./pair-client.ts";
import { json, readControl, routes } from "./server.ts";
import {
    type Actor,
    activePeer,
    expired,
    INTRODUCER_PERMISSION,
    loadPeers,
    openNetworks,
    PERMISSIONS,
    type Peer,
    peerLog,
    updatePeers,
} from "./store.ts";

routes.set("POST /v1/roster", async (request, context) => {
    const control = await readControl(request, context, "roster");
    if (control instanceof Response) return control;
    const fleet = new Set(fleetBoxes());
    const at = now().toISOString();
    const identity = loadIdentity();
    const certificates = loadPeers()
        .filter(
            (peer) =>
                peer.status === "active" &&
                fleet.has(peer.name) &&
                peer.name !== control.peer.name &&
                peer.cert !== "" &&
                !expired(peer),
        )
        .map((peer) =>
            signIntroduction(identity, {
                id: introId(),
                op: "introduce",
                audience: control.peer.fingerprint,
                subject: subjectOf(peer),
                grants: [...PERMISSIONS],
                notAfter: pinExpiry(),
                replaces: null,
                approval: { by: loadMachine().name, why: `fleet roster for ${control.peer.name}`, at },
            }),
        );
    peerLog(`sent ${control.peer.name} the fleet roster: ${certificates.length} machine(s)`);
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
    return lines.length === 0 ? [`${coordinator.name} knows no other fleet machine`] : lines;
}
