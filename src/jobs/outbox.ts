// The outbox (state/outbox/): messages for another machine, queued as files and delivered over ssh, so a machine
// that is offline loses nothing. Items without a target go to the coordinator's inbox (a worker's job results, prune
// reports, alerts); items with one go to that fleet machine: a delegation (`bin/toli delegation receive` there) or an
// inbox message (`bin/toli inbox add` there) such as a delegated task's report or a lead's `talk`. Items for a machine
// that takes no inbound ssh (`inbound: false`) are never sent: they wait here until it pulls them (src/jobs/pull.ts).
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
    type Fleet,
    type FleetMachine,
    inboundOff,
    inboundOffText,
    loadFleet,
    type Machine,
    remoteToliCommand,
    sshArgs,
} from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { readJson, run, shellQuote, warn, writeJsonAtomic } from "../core/util.ts";
import { addInboxItem } from "../records/inbox.ts";
import { Reach } from "./reach.ts";

/**
 * `inbox`: `bin/toli inbox add` on the target; `delegation`: `bin/toli delegation receive`; `update`: `bin/toli
 * delegation update`; `link`: `bin/toli delegation link`; `share`: `bin/toli share receive` (the body of all but
 * `inbox` is their JSON); `answer`: `bin/toli task answer <id> <answer> --from <from>` (body: AnswerBody JSON).
 */
export type OutboxKind = "inbox" | "delegation" | "update" | "link" | "share" | "answer";

/** `queuedAt` (ms since the epoch) orders a sender's items; items queued before it existed use the file's mtime. */
export type OutboxItem = {
    from: string;
    title: string;
    body: string;
    to?: FleetMachine;
    kind?: OutboxKind;
    queuedAt?: number;
};

/** An `answer` item's body: the owner's task id and the answer to record there. */
export type AnswerBody = { id: string; answer: string };

/** What a delivered item's target printed, handed to the caller's `onDelivered`. */
export type Delivered = { item: OutboxItem; stdout: string };

export function queueOutbox(machine: Machine, title: string, body: string, id: string): void {
    writeJsonAtomic(join(paths.outboxDir(), `${id}.json`), {
        from: machine.name,
        title,
        body,
        queuedAt: Date.now(),
    } satisfies OutboxItem);
}

const SENDING_STALE_MS = 10 * 60 * 1000;
const DELIVERY_TIMEOUT_MS = 120_000;
/** A queued item's delivery waits this long for a connection; one the tick could not make, it retries later. */
const DELIVERY_CONNECT_SECONDS = 5;

function parseAnswer(body: string): AnswerBody {
    const value: unknown = JSON.parse(body);
    const id = typeof value === "object" && value !== null ? Reflect.get(value, "id") : undefined;
    const answer = typeof value === "object" && value !== null ? Reflect.get(value, "answer") : undefined;
    if (typeof id !== "string" || typeof answer !== "string") throw new Error("answer item without id and answer");
    return { id, answer };
}

/** The `bin/toli` arguments one item runs on its target (over ssh, or here when it was pulled); stdin is its body. */
export function deliveryArgv(item: OutboxItem): string[] {
    if (item.kind === "delegation") return ["delegation", "receive"];
    if (item.kind === "update") return ["delegation", "update"];
    if (item.kind === "link") return ["delegation", "link"];
    if (item.kind === "share") return ["share", "receive"];
    if (item.kind === "answer") {
        const { id, answer } = parseAnswer(item.body);
        return ["task", "answer", id, answer, "--from", item.from];
    }
    return ["inbox", "add", "--from", item.from, "--title", item.title];
}

/** The remote command one item runs on its target. */
function remoteCommand(item: OutboxItem, root: string): string {
    return remoteToliCommand(root, deliveryArgv(item).map(shellQuote).join(" "));
}

/**
 * Whether `target` takes no inbound ssh, by the current list (an item queued before the flag was set carries an old
 * copy of its machine): by name, else by ssh name (a worker's coordinator is `{ssh, root}`).
 */
export function pullOnly(target: { name?: string; ssh: string }, fleet: Fleet = loadFleet()): FleetMachine | null {
    const entry =
        fleet.machines.find((machine) => target.name !== undefined && machine.name === target.name) ??
        fleet.machines.find((machine) => machine.ssh === target.ssh);
    return entry !== undefined && inboundOff(entry) ? entry : null;
}

/** The machine an item goes to: its own target, else (on a worker) the coordinator; undefined when neither. */
export function itemTarget(
    item: OutboxItem | null,
    machine: Machine,
): { name?: string; ssh: string; root: string } | undefined {
    return item?.to ?? (machine.role === "worker" ? machine.coordinator : undefined);
}

/** One queued file and its item. */
export type Queued = { file: string; item: OutboxItem };

/** Queued items (`<id>.json`, never one claimed for sending), oldest first: by `queuedAt`, then mtime, then name. */
export function queuedItems(): Queued[] {
    const dir = paths.outboxDir();
    if (!existsSync(dir)) return [];
    const entries: Array<Queued & { at: number }> = [];
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
        const path = join(dir, file);
        const item = readJson<OutboxItem | null>(path, null);
        if (item === null) continue;
        let at = item.queuedAt;
        if (at === undefined) {
            try {
                at = statSync(path).mtimeMs;
            } catch {
                continue;
            }
        }
        entries.push({ file, item, at });
    }
    entries.sort((a, b) => a.at - b.at || a.file.localeCompare(b.file));
    return entries.map(({ file, item }) => ({ file, item }));
}

/** `held`: items left queued without an ssh call, as their host failed earlier in the pass or is backed off. */
export type DeliveryResult = {
    delivered: number;
    pending: number;
    awaitingPull: number;
    held: number;
    errors: string[];
};

/**
 * Deliver every queued outbox item over ssh, oldest first: targeted items to their machine, the rest to the
 * coordinator (on a worker). Each item is claimed by an atomic rename first, so overlapping ticks never send the same
 * item twice; failures go back to the queue. After a host's first failure its remaining items stay queued for the next
 * pass, in order, and a host `reach` backs off (src/jobs/reach.ts) is not tried at all; one error line names each
 * such host. Items for a machine that takes no inbound ssh stay queued for its pull (`awaitingPull`). `onDelivered`
 * sees each delivered item and what its target printed; delegations are delivered only by a caller that passes it
 * (the minute tick, or the pull's acknowledgement), since their answer must be recorded here.
 */
export function deliverOutbox(
    machine: Machine,
    onDelivered?: (delivered: Delivered) => void,
    reach: Reach = new Reach({ backoff: false }),
): DeliveryResult {
    const dir = paths.outboxDir();
    const result: DeliveryResult = { delivered: 0, pending: 0, awaitingPull: 0, held: 0, errors: [] };
    if (!existsSync(dir)) return result;
    for (const file of readdirSync(dir)) {
        const sending = /^(.*\.json)\.sending-\d+$/.exec(file);
        if (sending && Date.now() - statSync(join(dir, file)).mtimeMs > SENDING_STALE_MS) {
            renameSync(join(dir, file), join(dir, sending[1] as string));
        }
    }
    const fleet = loadFleet();
    const held = new Map<string, { items: number; why: string }>();
    for (const { file, item: peek } of queuedItems()) {
        const queued = join(dir, file);
        const target = itemTarget(peek, machine);
        if (target === undefined || (peek.kind === "delegation" && onDelivered === undefined)) continue;
        if (pullOnly(target, fleet) !== null) {
            result.awaitingPull += 1;
            continue;
        }
        const why = reach.held(target.ssh);
        if (why !== null) {
            const entry = held.get(target.ssh) ?? { items: 0, why };
            entry.items += 1;
            held.set(target.ssh, entry);
            result.held += 1;
            continue;
        }
        const claimed = `${queued}.sending-${process.pid}`;
        try {
            renameSync(queued, claimed);
        } catch {
            continue;
        }
        const item = readJson<OutboxItem>(claimed, { from: machine.name, title: file, body: "" });
        const sent = run([...sshArgs(target.ssh, DELIVERY_CONNECT_SECONDS), remoteCommand(item, target.root)], {
            stdin: item.body,
            timeoutMs: DELIVERY_TIMEOUT_MS,
        });
        if (sent.code === 0) {
            reach.success(target.ssh);
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
            const error = `ssh ${target.ssh} exited ${sent.code}: ${(sent.stderr || sent.stdout).trim()}`;
            reach.failure(target.ssh, error, sent);
            result.errors.push(`${file}: ${error}`);
        }
    }
    for (const [host, { items, why }] of held)
        result.errors.push(`${items} item${items === 1 ? "" : "s"} for ${host} left queued: ${why}`);
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

/**
 * One immediate send: delivered (with what the target printed), or left queued with the reason: for the tick to retry,
 * or (`pulled`) for a target that takes no inbound ssh to pull.
 */
export type SendResult = { delivered: true; stdout: string } | { delivered: false; pulled: boolean; error: string };

/** What a sender prints for an item left queued: who picks it up next. */
export function queuedText(name: string, sent: { pulled: boolean }): string {
    return sent.pulled
        ? `queued for ${name}, which pulls its messages from here every minute (it takes no inbound ssh)`
        : `queued for ${name} (unreachable); the minute tick retries`;
}

/**
 * Send one item to a fleet machine now. It is written to the outbox already claimed by this process, so the tick
 * never sends it at the same time; when the target is unreachable it is released into the queue and the minute tick
 * retries it. For a target that takes no inbound ssh it is only queued: that machine pulls it.
 */
export function sendNow(
    from: string,
    to: FleetMachine,
    kind: OutboxKind,
    title: string,
    body: string,
    id: string,
): SendResult {
    const item: OutboxItem = { from, title, body, to, kind, queuedAt: Date.now() };
    const queued = join(paths.outboxDir(), `${id}.json`);
    const pulled = pullOnly(to);
    if (pulled !== null) {
        writeJsonAtomic(queued, item);
        return { delivered: false, pulled: true, error: inboundOffText(pulled) };
    }
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
    return {
        delivered: false,
        pulled: false,
        error: `ssh ${to.ssh} exited ${sent.code}: ${(sent.stderr || sent.stdout).trim()}`,
    };
}

/** Send one inbox message to another fleet machine now, or queue it for the tick when that machine is unreachable. */
export function sendToMachine(from: string, to: FleetMachine, title: string, body: string, id: string): SendResult {
    return sendNow(from, to, "inbox", title, body, id);
}
