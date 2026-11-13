// doctor's peer messaging lines (src/setup/doctor.ts, docs/peers.md): the identity's secrets stay private to this
// user, the listener runs on the active runtime when `peer.listen` is on, and the pinned @noble/curves is installed
// for pairing. Warnings only (but secrets readable by others): messaging over ssh works without.
import { paths } from "../core/paths.ts";
import { nobleLocation } from "../peer/deps.ts";
import { hasIdentity, loadIdentity, looseSecrets } from "../peer/identity.ts";
import { listenerProblem, liveListener } from "../peer/supervise.ts";
import type { Check } from "./doctor.ts";

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
