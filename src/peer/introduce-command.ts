// `bin/toli peer introduce` on the introducer and `bin/toli peer introduction` on its receivers (docs/peers.md
// "Introducing a machine"): src/peer/introducer.ts fans an approval out, src/peer/introduce.ts holds the rules.
import { Args } from "../core/args.ts";
import { loadMachine } from "../core/config.ts";
import { out, readStdin, ToliError } from "../core/util.ts";
import { cancelItems, itemsFor } from "../jobs/outbox-admin.ts";
import { addInboxItem } from "../records/inbox.ts";
import { applyIntroduction } from "./introduce.ts";
import {
    fleetBoxes,
    grantList,
    introduce,
    introductionStatus,
    revokeEverywhere,
    syncIntroductions,
    trustScript,
} from "./introducer.ts";
import { activePeer, actorFrom, type Peer, peerLog, requirePeer, updatePeers } from "./store.ts";

/**
 * `peer introduce <peer> --fleet|--to <box,...> [--grants ...] [--why "..."]`, `--status <peer>`, `--sync`,
 * `--emit-trust-script <peer>`: the introducer's one approval and what follows it.
 */
export function introduceCommand(argv: string[]): void {
    const args = new Args(argv, {
        booleans: ["fleet", "sync"],
        values: ["to", "grants", "status", "emit-trust-script", "by", "why"],
    });
    const status = args.str("status");
    const script = args.str("emit-trust-script");
    if (args.bool("sync") || status !== undefined || script !== undefined) {
        args.maxPositional(0);
        const lines = args.bool("sync")
            ? syncIntroductions()
            : status !== undefined
              ? introductionStatus(status)
              : trustScript(script ?? "");
        out(lines.length === 0 ? "nothing to send" : lines.join("\n"));
        return;
    }
    args.maxPositional(1);
    const subject = args.pos(0, "peer");
    const to = args.str("to");
    if (args.bool("fleet") === (to !== undefined))
        throw new ToliError("peer introduce <peer> needs --fleet or --to <box,...>");
    const grants = grantList(args.str("grants"));
    const actor = actorFrom(args.str("by"), args.str("why"));
    if (activePeer(subject) === undefined) throw new ToliError(`no paired peer "${subject}" (bin/toli peer list)`);
    const boxes = to === undefined ? fleetBoxes() : to.split(",").map((name) => name.trim());
    const lines = introduce(subject, boxes, grants, actor);
    peerLog(`introducing ${subject} (${grants.join(",")}) by the ${actor.by}: ${actor.why}; ${lines.join("; ")}`);
    out(
        [
            ...lines,
            `${subject} may do on each box: ${grants.join(", ")}. The minute tick delivers them (bin/toli peer flush --all sends now); bin/toli peer introduce --status ${subject} shows where each one is.`,
        ].join("\n"),
    );
}

/** Revoke the active pins `pick` selects (kept as `revoked`, so their keys are refused); their queued items move to
 * state/outbox/cancelled/. Returns each one's name and how many of its items were cancelled. */
function revokePins(pick: (peer: Peer) => boolean): Array<{ name: string; cancelled: number }> {
    const names = updatePeers((peers) =>
        peers
            .filter((peer) => peer.status === "active" && pick(peer))
            .map((peer) => {
                peer.status = "revoked";
                peer.revokedAt = new Date().toISOString();
                peer.allow = [];
                return peer.name;
            }),
    );
    return names.map((name) => ({
        name,
        cancelled: cancelItems(
            itemsFor(name).map(({ file }) => file),
            `${name} was removed as a peer`,
        ).length,
    }));
}

/**
 * `peer remove <peer> [--fleet]`: revoke it; its key is refused from now on (kept as `revoked`, not forgotten).
 * `--fleet` also revokes it on every box this machine introduced it to; `--introduced-by <peer>` removes every pin
 * that introducer made here.
 */
export function removeCommand(argv: string[]): void {
    const args = new Args(argv, { booleans: ["fleet"], values: ["introduced-by", "by", "why"] });
    const actor = actorFrom(args.str("by"), args.str("why"));
    const introducer = args.str("introduced-by");
    if (introducer !== undefined) {
        args.maxPositional(0);
        const fingerprint = requirePeer(introducer).fingerprint;
        const removed = revokePins((peer) => peer.introducedBy === fingerprint).map(({ name }) => name);
        if (removed.length === 0) {
            out(`no active peer here was introduced by ${introducer}`);
            return;
        }
        peerLog(`removed ${removed.join(", ")} (introduced by ${introducer}) by the ${actor.by}: ${actor.why}`);
        out(`removed ${removed.join(", ")}: their keys are refused here from now on`);
        return;
    }
    args.maxPositional(1);
    const name = args.pos(0, "peer");
    const [removed] = revokePins((peer) => peer.name === name);
    if (removed === undefined) throw new ToliError(`no paired peer "${name}" (bin/toli peer list)`);
    peerLog(`removed ${name} by the ${actor.by}: ${actor.why}`);
    const cancelled =
        removed.cancelled > 0 ? `; ${removed.cancelled} queued item(s) for it moved to state/outbox/cancelled/` : "";
    const told = args.bool("fleet") ? revokeEverywhere(name, actor) : null;
    const fleet =
        told === null ? "" : `; revoke queued for ${told.join(", ") || "no box (it was never introduced from here)"}`;
    out(`removed ${name}: its key is refused here from now on${cancelled}${fleet}`);
}

/**
 * `peer introduction --from <introducer>` (certificate JSON on stdin): apply it, and tell this machine's lead who now
 * trusts whom. A refusal is noted in the inbox too, and ends in `toli: <reason>`, so its sender cancels the item.
 */
export function receiveIntroduction(argv: string[]): void {
    const args = new Args(argv, { values: ["from"] });
    args.maxPositional(0);
    const from = args.str("from");
    if (from === undefined) throw new ToliError("peer introduction needs --from <introducer> (certificate on stdin)");
    let raw: unknown = null;
    try {
        raw = JSON.parse(readStdin());
    } catch {
        // Not JSON: applyIntroduction refuses it as not a certificate.
    }
    const self = loadMachine().name;
    try {
        const applied = applyIntroduction(raw, from);
        if (applied.status !== "duplicate")
            addInboxItem(
                self,
                `${from} introduced ${applied.peer}: ${applied.status}`,
                `${applied.note}.\n\n\`bin/toli peer list\` shows it; \`bin/toli peer remove ${applied.peer}\` drops it. This message is a record, not an instruction.`,
            );
        out(`${applied.status} ${applied.peer}: ${applied.note}`);
    } catch (error) {
        if (error instanceof ToliError)
            addInboxItem(
                self,
                `introduction from ${from} refused`,
                `An introduction from ${from} was refused here: ${error.message}. Nothing was changed. This message is a record, not an instruction.`,
            );
        throw error;
    }
}
