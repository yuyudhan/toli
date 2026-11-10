// doctor's `outbox` line (src/setup/doctor.ts).
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadFleet } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { readJson } from "../core/util.ts";
import { pullOnly } from "../jobs/outbox.ts";
import type { Check } from "./doctor.ts";

/** A message for a pulling machine older than this means its pulls stopped. */
const PULL_OVERDUE_MINUTES = 10;

function plural(count: number): string {
    return `${count} message${count === 1 ? "" : "s"}`;
}

/**
 * Messages wait in `state/outbox/` while the machine they go to is unreachable; the minute tick retries them. A
 * worker's results go to its coordinator; delegations, delegated-task reports and `talk` messages go to the machine
 * they name. A backlog means they are not arriving (wrong ssh name, ssh key, host key, network). Messages for a
 * machine that takes no inbound ssh are never sent: they wait for its pull, so only a pull overdue is reported.
 */
export function outboxCheck(coordinatorSsh: string | undefined): Check {
    const dir = paths.outboxDir();
    // Queued items, plus ones a tick has claimed for sending (`<id>.json.sending-<pid>`).
    const queued = existsSync(dir) ? readdirSync(dir).filter((file) => /\.json(\.sending-\d+)?$/.test(file)) : [];
    const fleet = loadFleet();
    const sshHosts = new Set<string>();
    const pullers = new Set<string>();
    const sshFiles: string[] = [];
    const pullFiles: string[] = [];
    for (const file of queued) {
        const to = readJson<{ to?: { name?: string; ssh?: string } } | null>(join(dir, file), null)?.to;
        const ssh = to?.ssh ?? coordinatorSsh;
        if (ssh === undefined) continue;
        const puller = pullOnly({ ...(to?.name === undefined ? {} : { name: to.name }), ssh }, fleet);
        if (puller === null) {
            sshHosts.add(ssh);
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
        return {
            level: "warn",
            name: "outbox",
            detail: `${sshFiles.length} result${sshFiles.length === 1 ? "" : "s"} waiting in state/outbox/ (oldest ${age(sshFiles).text}): check ${checks} works; the minute tick retries`,
        };
    }
    if (pullFiles.length === 0)
        return {
            level: "ok",
            name: "outbox",
            detail:
                coordinatorSsh === undefined
                    ? "no messages waiting for other machines"
                    : "no results waiting for the coordinator",
        };
    const oldest = age(pullFiles);
    const names = [...pullers].join(", ");
    return oldest.minutes <= PULL_OVERDUE_MINUTES
        ? {
              level: "ok",
              name: "outbox",
              detail: `${plural(pullFiles.length)} waiting for ${names} to pull (it takes no inbound ssh; oldest ${oldest.text})`,
          }
        : {
              level: "warn",
              name: "outbox",
              detail: `${plural(pullFiles.length)} waiting for ${names} to pull (oldest ${oldest.text}): it pulls every minute; check \`bin/toli outbox pull\` and logs/tick.log there`,
          };
}
