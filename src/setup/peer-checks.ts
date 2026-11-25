// doctor's peer messaging lines (src/setup/doctor.ts, docs/peers.md): the identity's secrets stay private to this
// user, the listener runs on the active runtime when `peer.listen` is on, the pinned @noble/curves is installed for
// pairing, and no peer marked pull-only has stopped pulling. Warnings only (but secrets readable by others): messaging
// over ssh works without.
import { paths } from "../core/paths.ts";
import { readJson } from "../core/util.ts";
import type { Pullers } from "../jobs/pull.ts";
import { nobleLocation } from "../peer/deps.ts";
import { hasIdentity, loadIdentity, looseSecrets } from "../peer/identity.ts";
import { loadPeers } from "../peer/store.ts";
import { listenerProblem, liveListener } from "../peer/supervise.ts";
import type { Check } from "./doctor.ts";
import { introduceChecks } from "./introduce-checks.ts";

/** A peer marked pull-only that has not pulled here for longer than this has likely stopped pulling. */
const PULL_ONLY_QUIET_MINUTES = 10;

/** A configured listener that is down (or stuck on a replaced runtime) is a warning: peers fall back to ssh or pull. */
function listenerCheck(): Check {
    const problem = listenerProblem();
    if (problem !== null) return { level: "warn", name: "peer-listener", detail: problem };
    const running = liveListener();
    return running === null
        ? { level: "ok", name: "peer-listener", detail: "off (this machine pulls from its peers)" }
        : {
              level: "ok",
              name: "peer-listener",
              detail: `running (pid ${running.pid}) on ${running.addrs.join(", ") || "no private address yet"}`,
          };
}

/**
 * A peer marked pull-only (`inbound: false`) is never pushed to by a send, only by the tick's retry: one that no longer
 * pulls was likely marked by a pull made while its listener was off (an older toli's announce does not clear that), or
 * is asleep. Null when every pull-only peer pulled here within PULL_ONLY_QUIET_MINUTES.
 */
function pullOnlyCheck(): Check | null {
    const asked = readJson<Pullers>(paths.pullers(), {});
    const quiet = loadPeers()
        .filter((peer) => peer.status === "active" && peer.inbound === false && peer.via === undefined)
        .map((peer) => ({ name: peer.name, at: asked[peer.name] }))
        .filter(({ at }) => at === undefined || Date.now() - at > PULL_ONLY_QUIET_MINUTES * 60_000);
    if (quiet.length === 0) return null;
    const lines = quiet.map(({ name, at }) =>
        at === undefined
            ? `${name} (never pulled here)`
            : `${name} (last pull ${Math.round((Date.now() - at) / 60_000)} min ago)`,
    );
    return {
        level: "warn",
        name: "peer-pull-only",
        detail: `marked pull-only (a send to it only queues for its pull) but not pulling here: ${lines.join(", ")}; if its listener runs, the mark is stale: run \`bin/toli peer pull\` there once to clear it`,
    };
}

export function peerChecks(): Check[] {
    const checks: Check[] = [];
    if (!hasIdentity())
        checks.push({
            level: "warn",
            name: "peer",
            detail: "no peer identity: bin/toli peer init (the listener makes it too)",
        });
    else {
        const loose = looseSecrets();
        checks.push(
            loose.length === 0
                ? {
                      level: "ok",
                      name: "peer",
                      detail: `identity ${loadIdentity().fingerprint.slice(0, 16)}..., secrets at 0600`,
                  }
                : { level: "fail", name: "peer", detail: `readable by others: ${loose.join(", ")} (chmod 600 them)` },
            listenerCheck(),
        );
        const pullOnly = pullOnlyCheck();
        if (pullOnly !== null) checks.push(pullOnly);
        checks.push(...introduceChecks());
    }
    checks.push(
        nobleLocation() === null
            ? {
                  level: "warn",
                  name: "peer-deps",
                  detail: `@noble/curves missing (pairing needs it): bun install --production --frozen-lockfile in ${paths.root()}`,
              }
            : { level: "ok", name: "peer-deps", detail: "@noble/curves installed" },
    );
    return checks;
}
