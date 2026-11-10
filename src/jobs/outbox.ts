// The outbox (state/outbox/): messages for another machine, queued as files and delivered over ssh, so a machine
// that is offline loses nothing. Items without a target go to the coordinator's inbox (a worker's job results, prune
// reports, alerts); items with one go to that fleet machine: a delegation (`bin/toli delegation receive` there) or an
// inbox message (`bin/toli inbox add` there) such as a delegated task's report or a lead's `talk`.
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { type FleetMachine, type Machine, remoteToliCommand, sshArgs } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { readJson, run, shellQuote, warn, writeJsonAtomic } from "../core/util.ts";
import { addInboxItem } from "../records/inbox.ts";

/**
 * `inbox`: `bin/toli inbox add` on the target; `delegation`: `bin/toli delegation receive`; `share`: `bin/toli share
 * receive` (the body of the last two is their JSON).
 */
export type OutboxKind = "inbox" | "delegation" | "share";

export type OutboxItem = { from: string; title: string; body: string; to?: FleetMachine; kind?: OutboxKind };

/** What a delivered item's target printed, handed to the caller's `onDelivered`. */
export type Delivered = { item: OutboxItem; stdout: string };

export function queueOutbox(machine: Machine, title: string, body: string, id: string): void {
    writeJsonAtomic(join(paths.outboxDir(), `${id}.json`), { from: machine.name, title, body } satisfies OutboxItem);
}

const SENDING_STALE_MS = 10 * 60 * 1000;
const DELIVERY_TIMEOUT_MS = 120_000;

/** The remote command one item runs on its target. */
function remoteCommand(item: OutboxItem, root: string): string {
    if (item.kind === "delegation") return remoteToliCommand(root, "delegation receive");
    if (item.kind === "share") return remoteToliCommand(root, "share receive");
    return remoteToliCommand(root, `inbox add --from ${shellQuote(item.from)} --title ${shellQuote(item.title)}`);
}

/**
 * Deliver every queued outbox item over ssh: targeted items to their machine, the rest to the coordinator (on a
 * worker). Each item is claimed by an atomic rename first, so overlapping ticks never send the same item twice;
 * failures go back to the queue. `onDelivered` sees each delivered item and what its target printed; delegations are
 * delivered only by a caller that passes it (the minute tick), since their answer must be recorded here.
 */
export function deliverOutbox(
    machine: Machine,
    onDelivered?: (delivered: Delivered) => void,
): { delivered: number; pending: number; errors: string[] } {
    const dir = paths.outboxDir();
    const result = { delivered: 0, pending: 0, errors: [] as string[] };
    if (!existsSync(dir)) return result;
    for (const file of readdirSync(dir)) {
        const sending = /^(.*\.json)\.sending-\d+$/.exec(file);
        if (sending && Date.now() - statSync(join(dir, file)).mtimeMs > SENDING_STALE_MS) {
            renameSync(join(dir, file), join(dir, sending[1] as string));
        }
    }
    const coordinator = machine.role === "worker" ? machine.coordinator : undefined;
    for (const file of readdirSync(dir)
        .filter((entry) => entry.endsWith(".json"))
        .sort()) {
        const queued = join(dir, file);
        const peek = readJson<OutboxItem | null>(queued, null);
        const target = peek?.to ?? coordinator;
        if (target === undefined || (peek?.kind === "delegation" && onDelivered === undefined)) continue;
        const claimed = `${queued}.sending-${process.pid}`;
        try {
            renameSync(queued, claimed);
        } catch {
            continue;
        }
        const item = readJson<OutboxItem>(claimed, { from: machine.name, title: file, body: "" });
        const sent = run([...sshArgs(target.ssh), remoteCommand(item, target.root)], {
            stdin: item.body,
            timeoutMs: DELIVERY_TIMEOUT_MS,
        });
        if (sent.code === 0) {
            rmSync(claimed, { force: true });
            result.delivered += 1;
            try {
                onDelivered?.({ item, stdout: sent.stdout });
            } catch (error) {
                result.errors.push(
                    `${file}: delivered, then ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        } else {
            renameSync(claimed, queued);
            result.pending += 1;
            result.errors.push(
                `${file}: ssh ${target.ssh} exited ${sent.code}: ${(sent.stderr || sent.stdout).trim()}`,
            );
        }
    }
    return result;
}

/** Post one item to this machine's inbox and, on a worker, forward it to the coordinator. Returns the inbox path. */
export function notify(machine: Machine, title: string, body: string, outboxId: string): string {
    const inbox = addInboxItem(machine.name, title, body);
    if (machine.role === "worker") {
        queueOutbox(machine, title, body, outboxId);
        for (const error of deliverOutbox(machine).errors) warn(`outbox: ${error}`);
    }
    return inbox;
}

/** One immediate send: delivered (with what the target printed), or left queued for the tick with the reason. */
export type SendResult = { delivered: true; stdout: string } | { delivered: false; error: string };

/**
 * Send one item to a fleet machine now. It is written to the outbox already claimed by this process, so the tick
 * never sends it at the same time; when the target is unreachable it is released into the queue and the minute tick
 * retries it.
 */
export function sendNow(
    from: string,
    to: FleetMachine,
    kind: OutboxKind,
    title: string,
    body: string,
    id: string,
): SendResult {
    const item: OutboxItem = { from, title, body, to, kind };
    const queued = join(paths.outboxDir(), `${id}.json`);
    const claimed = `${queued}.sending-${process.pid}`;
    writeJsonAtomic(claimed, item);
    const sent = run([...sshArgs(to.ssh), remoteCommand(item, to.root)], {
        stdin: body,
        timeoutMs: DELIVERY_TIMEOUT_MS,
    });
    if (sent.code === 0) {
        rmSync(claimed, { force: true });
        return { delivered: true, stdout: sent.stdout };
    }
    renameSync(claimed, queued);
    return { delivered: false, error: `ssh ${to.ssh} exited ${sent.code}: ${(sent.stderr || sent.stdout).trim()}` };
}

/** Send one inbox message to another fleet machine now, or queue it for the tick when that machine is unreachable. */
export function sendToMachine(from: string, to: FleetMachine, title: string, body: string, id: string): SendResult {
    return sendNow(from, to, "inbox", title, body, id);
}
