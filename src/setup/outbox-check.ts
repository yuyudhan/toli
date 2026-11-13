// doctor's `outbox` and `pull` lines (src/setup/doctor.ts).
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadFleet, pullsItsMessages } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { readJson } from "../core/util.ts";
import { pullOnly } from "../jobs/outbox.ts";
import type { Pullers, PullLast } from "../jobs/pull.ts";
import { relayedPeer } from "../peer/transport.ts";
import type { Check } from "./doctor.ts";

/** A message for a pulling machine older than this means its pulls stopped. */
const PULL_OVERDUE_MINUTES = 10;
/** Messages for a machine reached by ssh this old suggest it takes no inbound ssh and nobody marked it. */
const SSH_PILEUP_MINUTES = 60;
const MARK_PULL_ONLY = "bin/toli init --name <machine> --role <role> ... --inbound off";

function plural(count: number): string {
    return `${count} message${count === 1 ? "" : "s"}`;
}

/**
 * Messages wait in `state/outbox/` while the machine they go to is unreachable; the minute tick retries them. A
 * worker's results go to its coordinator; delegations, delegated-task reports and `talk` messages go to the machine
 * they name. A backlog means they are not arriving (wrong ssh name, ssh key, host key, network, or a machine that takes
 * no inbound ssh and is not marked so). Messages for a machine that takes no inbound ssh are never sent: they wait
 * for its pull, so only a pull overdue is reported, naming a machine that has never pulled from here.
 */
export function outboxCheck(coordinatorSsh: string | undefined): Check {
    const dir = paths.outboxDir();
    // Queued items, plus ones a tick has claimed for sending (`<id>.json.sending-<pid>`).
    const queued = existsSync(dir) ? readdirSync(dir).filter((file) => /\.json(\.sending-\d+)?$/.test(file)) : [];
    const fleet = loadFleet();
    const sshHosts = new Set<string>();
    const sshNames = new Set<string>();
    const pullers = new Set<string>();
    const sshFiles: string[] = [];
    const pullFiles: string[] = [];
    const relayed = new Set<string>();
    const relayFiles: string[] = [];
    for (const file of queued) {
        const to = readJson<{ to?: { name?: string; ssh?: string } } | null>(join(dir, file), null)?.to;
        const relay = relayedPeer(to?.name);
        if (relay !== undefined) {
            relayed.add(`${relay.name} via ${relay.via}`);
            relayFiles.push(file);
            continue;
        }
        const ssh = to?.ssh ?? coordinatorSsh;
        if (ssh === undefined) continue;
        const puller = pullOnly({ ...(to?.name === undefined ? {} : { name: to.name }), ssh }, fleet);
        if (puller === null) {
            sshHosts.add(ssh);
            const name = to?.name ?? fleet.machines.find((entry) => entry.ssh === ssh)?.name;
            if (name !== undefined) sshNames.add(name);
            sshFiles.push(file);
        } else {
            pullers.add(puller.name);
            pullFiles.push(file);
        }
    }
    const age = (files: string[]): { minutes: number; text: string } => {
        const oldestMs = Math.min(...files.map((file) => statSync(join(dir, file)).mtimeMs));
        const minutes = Math.max(0, Math.round((Date.now() - oldestMs) / 60_000));
        return { minutes, text: minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h` };
    };
    if (sshFiles.length > 0) {
        const checks = [...sshHosts].map((host) => `\`ssh ${host} true\``).join(", ");
        const oldest = age(sshFiles);
        const unmarked =
            oldest.minutes > SSH_PILEUP_MINUTES && sshNames.size > 0
                ? `; if ${[...sshNames].join(", ")} takes no inbound ssh, mark it there (\`${MARK_PULL_ONLY}\`) so it pulls them`
                : "";
        return {
            level: "warn",
            name: "outbox",
            detail: `${sshFiles.length} result${sshFiles.length === 1 ? "" : "s"} waiting in state/outbox/ (oldest ${oldest.text}): check ${checks} works; the minute tick retries${unmarked}`,
        };
    }
    // Items for a peer reached through a relay settle when its signed receipt comes back from there.
    const relayLine =
        relayFiles.length === 0
            ? null
            : `${plural(relayFiles.length)} for ${[...relayed].join(", ")} (oldest ${age(relayFiles).text})`;
    const relayLate = relayFiles.length > 0 && age(relayFiles).minutes > PULL_OVERDUE_MINUTES;
    const relayFix = relayLate
        ? ": the recipient pulls them at the relay every minute; check `bin/toli peer flush --all` here and `bin/toli peer pull` there"
        : "";
    if (pullFiles.length === 0) {
        if (relayLine !== null)
            return { level: relayLate ? "warn" : "ok", name: "outbox", detail: `${relayLine}${relayFix}` };
        return {
            level: "ok",
            name: "outbox",
            detail:
                coordinatorSsh === undefined
                    ? "no messages waiting for other machines"
                    : "no results waiting for the coordinator",
        };
    }
    const relayNote = relayLine === null ? "" : `; ${relayLine}${relayFix}`;
    const oldest = age(pullFiles);
    const names = [...pullers].join(", ");
    if (oldest.minutes <= PULL_OVERDUE_MINUTES)
        return {
            level: relayLate ? "warn" : "ok",
            name: "outbox",
            detail: `${plural(pullFiles.length)} waiting for ${names} to pull (it takes no inbound ssh; oldest ${oldest.text})${relayNote}`,
        };
    const asked = readJson<Pullers>(paths.pullers(), {});
    const never = [...pullers].filter((name) => asked[name] === undefined);
    const why =
        never.length === 0
            ? "it pulls every minute; check `bin/toli outbox pull` and logs/tick.log there"
            : pullsItsMessages()
              ? `${never.join(", ")} has never pulled from here, and cannot: this machine takes no inbound ssh either, so send through a relay both reach (\`bin/toli peer trust <machine> --key <key> --via <relay>\`, docs/peers.md "Relay")`
              : `${never.join(", ")} has never pulled from here: its tick pulls only once it is marked, so run \`${MARK_PULL_ONLY}\` there, then \`bin/toli outbox pull\``;
    return {
        level: "warn",
        name: "outbox",
        detail: `${plural(pullFiles.length)} waiting for ${names} to pull (oldest ${oldest.text}): ${why}${relayNote}`,
    };
}

/**
 * doctor's `pull` line on a machine that takes no inbound ssh (`inbound: false` in its config/machine.json or its own
 * fleet entry): whether it has ever pulled its messages. Null on a machine others ssh into.
 */
export function pullCheck(): Check | null {
    if (!pullsItsMessages()) return null;
    const last = readJson<PullLast | null>(paths.pullLast(), null);
    if (last === null)
        return {
            level: "warn",
            name: "pull",
            detail: "this machine takes no inbound ssh but has never pulled its messages: run `bin/toli outbox pull` and check logs/tick.log (the minute tick pulls)",
        };
    const minutes = Math.max(0, Math.round((Date.now() - last.at) / 60_000));
    return {
        level: "ok",
        name: "pull",
        detail: `takes no inbound ssh, pulls its messages every minute (last from ${last.from}, ${minutes} min ago)`,
    };
}
