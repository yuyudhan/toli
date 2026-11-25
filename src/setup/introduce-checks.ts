// doctor's introduction lines (docs/peers.md "Introducing a machine"): a worker with no peer allowed to introduce
// machines (each new machine then needs a pairing code here), introduced pins about to expire, and items this
// machine holds as a relay for a recipient it reaches that nobody collects. Warnings only.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { INTRODUCER_PERMISSION, loadPeers, peerByFingerprint, pushable } from "../peer/store.ts";
import type { Check } from "./doctor.ts";

/** An introduced pin this close to its `notAfter` is named, so its introducer's renewal can be checked. */
const EXPIRY_WARN_MS = 14 * 24 * 60 * 60_000;

/** Items a relay holds for a recipient it reaches are normally gone within a minute (its nudge, its tick's pull). */
const HELD_QUIET_MINUTES = 10;

/** On a worker with peers: which peer may introduce machines here, or how to grant one. */
function introducerCheck(): Check | null {
    const active = loadPeers().filter((peer) => peer.status === "active");
    if (loadMachine().role !== "worker" || active.length === 0) return null;
    const introducers = active.filter((peer) => peer.allow.includes(INTRODUCER_PERMISSION)).map((peer) => peer.name);
    return introducers.length > 0
        ? { level: "ok", name: "peer-introducer", detail: `${introducers.join(", ")} introduces machines here` }
        : {
              level: "warn",
              name: "peer-introducer",
              detail: `no peer may introduce machines here, so each new machine needs a pairing code: bin/toli peer allow <coordinator> ${INTRODUCER_PERMISSION} --why "fleet introducer"`,
          };
}

/** Introduced pins that expire within EXPIRY_WARN_MS: their introducer renews them (`peer introduce --sync`). */
function expiryCheck(): Check | null {
    const soon = loadPeers().filter(
        (peer) =>
            peer.status === "active" &&
            peer.notAfter !== undefined &&
            Date.parse(peer.notAfter) - Date.now() < EXPIRY_WARN_MS,
    );
    if (soon.length === 0) return null;
    const names = soon.map((peer) => `${peer.name} (expires ${peer.notAfter?.slice(0, 10)})`);
    return {
        level: "warn",
        name: "peer-expiry",
        detail: `introduced pins about to expire: ${names.join(", ")}; their introducer renews them on its tick (bin/toli peer introduce --sync there)`,
    };
}

/** Recipients this relay reaches itself whose held items wait over HELD_QUIET_MINUTES: they are not pulling. */
function relayHeldCheck(): Check | null {
    const root = join(paths.peerRelayDir(), "held");
    if (!existsSync(root)) return null;
    const stale: string[] = [];
    for (const recipient of readdirSync(root)) {
        const peer = peerByFingerprint(recipient)?.peer;
        if (peer === undefined || peer.status !== "active" || !pushable(peer)) continue;
        const dir = join(root, recipient);
        const ages = readdirSync(dir)
            .filter((file) => file.endsWith(".json"))
            .map((file) => Date.now() - statSync(join(dir, file)).mtimeMs);
        const oldest = Math.max(0, ...ages);
        if (ages.length === 0 || oldest < HELD_QUIET_MINUTES * 60_000) continue;
        const items = ages.length === 1 ? "1 item" : `${ages.length} items`;
        stale.push(`${peer.name} (${items}, oldest ${Math.round(oldest / 60_000)} min)`);
    }
    if (stale.length === 0) return null;
    return {
        level: "warn",
        name: "peer-relay-held",
        detail: `held here as a relay for a peer this machine reaches, and not collected: ${stale.join(", ")}; check its listener and tick there (bin/toli peer pull)`,
    };
}

export function introduceChecks(): Check[] {
    return [introducerCheck(), expiryCheck(), relayHeldCheck()].filter((check): check is Check => check !== null);
}
