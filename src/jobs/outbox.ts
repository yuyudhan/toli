// A worker's outbox (state/outbox/): inbox items for the coordinator (finished jawans, job results, prune reports),
// queued as files and delivered over ssh, so a coordinator that is offline loses nothing.
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Machine, remoteToliCommand, sshArgs } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { readJson, run, shellQuote, writeJsonAtomic } from "../core/util.ts";

type OutboxItem = { from: string; title: string; body: string };

export function queueOutbox(machine: Machine, title: string, body: string, id: string): void {
    writeJsonAtomic(join(paths.outboxDir(), `${id}.json`), { from: machine.name, title, body } satisfies OutboxItem);
}

const SENDING_STALE_MS = 10 * 60 * 1000;

/**
 * Deliver every queued outbox item to the coordinator's inbox over ssh. Each item is claimed by an atomic
 * rename first, so overlapping ticks never send the same item twice; failures go back to the queue.
 */
export function deliverOutbox(machine: Machine): { delivered: number; pending: number; errors: string[] } {
    const dir = paths.outboxDir();
    const result = { delivered: 0, pending: 0, errors: [] as string[] };
    if (!existsSync(dir) || machine.role !== "worker" || !machine.coordinator) return result;
    const coordinator = machine.coordinator;
    for (const file of readdirSync(dir)) {
        const sending = /^(.*\.json)\.sending-\d+$/.exec(file);
        if (sending && Date.now() - statSync(join(dir, file)).mtimeMs > SENDING_STALE_MS) {
            renameSync(join(dir, file), join(dir, sending[1] as string));
        }
    }
    for (const file of readdirSync(dir)
        .filter((entry) => entry.endsWith(".json"))
        .sort()) {
        const queued = join(dir, file);
        const claimed = `${queued}.sending-${process.pid}`;
        try {
            renameSync(queued, claimed);
        } catch {
            continue;
        }
        const item = readJson<OutboxItem>(claimed, { from: machine.name, title: file, body: "" });
        const remote = remoteToliCommand(
            coordinator.root,
            `inbox add --from ${shellQuote(item.from)} --title ${shellQuote(item.title)}`,
        );
        const sent = run([...sshArgs(coordinator.ssh), remote], { stdin: item.body, timeoutMs: 120_000 });
        if (sent.code === 0) {
            rmSync(claimed, { force: true });
            result.delivered += 1;
        } else {
            renameSync(claimed, queued);
            result.pending += 1;
            result.errors.push(
                `${file}: ssh ${coordinator.ssh} exited ${sent.code}: ${(sent.stderr || sent.stdout).trim()}`,
            );
        }
    }
    return result;
}
