// The outbox (state/outbox/): messages for another machine, queued as files and delivered so a machine that is
// offline loses nothing. Items without a target go to the coordinator's inbox (a worker's job results, prune
// reports, alerts); items with one go to that machine: a delegation (`bin/toli delegation receive` there) or an
// inbox message (`bin/toli inbox add` there) such as a delegated task's report or a lead's `talk`. A paired peer gets
// its items over HTTPS first (src/peer/deliver.ts, docs/peers.md); other machines, and a peer HTTPS cannot reach
// while `peer.sshFallback` is on, get them over ssh. Items for a machine that takes no inbound ssh (`inbound: false`)
// and no HTTPS wait here until it pulls them (src/jobs/pull.ts, or /v1/outbox/pending).
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
import { recordStat } from "../peer/client.ts";
import { flushSync, httpPeer, sshFallback } from "../peer/transport.ts";
import { addInboxItem } from "../records/inbox.ts";
import { cancelItems } from "./outbox-admin.ts";
import { Reach } from "./reach.ts";
import { refusalOf } from "./refusal.ts";

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

/**
 * The `bin/toli` arguments one item runs on its target (over ssh, or here when it was pulled); stdin is its body.
 * `verified`: the sender as this machine checked it (a pull): delegation records must then speak for that machine.
 * Left out for an ssh push, whose target may run a toli without `--from` on those commands.
 */
export function deliveryArgv(item: OutboxItem, verified?: string): string[] {
    const from = verified === undefined ? [] : ["--from", verified];
    if (item.kind === "delegation") return ["delegation", "receive", ...from];
    if (item.kind === "update") return ["delegation", "update", ...from];
    if (item.kind === "link") return ["delegation", "link", ...from];
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
 * copy of its machine): by name, else by ssh name (a worker's coordinator is `{ssh, root}`). A paired peer outside
 * the fleet list has no ssh name at all: it is reached over HTTPS or pulls.
 */
export function pullOnly(target: { name?: string; ssh: string }, fleet: Fleet = loadFleet()): FleetMachine | null {
    if (target.ssh === "") return { name: target.name ?? "", ssh: "", root: "", inbound: false };
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
    // Paired peers first, over HTTPS (one subprocess for all of them); what it could not reach may go over ssh.
    const queuedNow = queuedItems();
    const unreachable = new Map<string, string>();
    if (queuedNow.some(({ item }) => httpPeer(item.to?.name) !== undefined)) {
        for (const flush of flushSync(null)) {
            result.delivered += flush.sent;
            if (flush.unreachable !== undefined) unreachable.set(flush.peer, flush.unreachable);
            if (flush.error !== undefined) result.errors.push(`${flush.peer}: ${flush.error}`);
        }
    }
    for (const { file, item: peek } of queuedItems()) {
        const queued = join(dir, file);
        const target = itemTarget(peek, machine);
        if (target === undefined || (peek.kind === "delegation" && onDelivered === undefined)) continue;
        if (httpPeer(target.name) !== undefined) {
            const why = target.name === undefined ? undefined : unreachable.get(target.name);
            if (why === undefined || !sshFallback() || target.ssh === "" || pullOnly(target, fleet) !== null) {
                result.pending += 1;
                continue;
            }
        }
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
        const started = performance.now();
        const sent = run([...sshArgs(target.ssh, DELIVERY_CONNECT_SECONDS), remoteCommand(item, target.root)], {
            stdin: item.body,
            timeoutMs: DELIVERY_TIMEOUT_MS,
        });
        recordSsh(target.name, file.replace(/\.json$/, ""), item, started, sent.code);
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
            const refused = refusalOf(sent);
            if (refused !== null) {
                // The receiver answered: it is reachable, and this item alone is wrong. Later items still go.
                reach.success(target.ssh);
                renameSync(claimed, queued);
                cancelItems([file], `${target.name ?? target.ssh} refused it: ${refused}`);
                result.errors.push(`${file}: ${target.name ?? target.ssh} refused it: ${refused} (cancelled)`);
                continue;
            }
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
 * One immediate send: delivered (with what the target printed), or not with the reason: left queued for the tick to
 * retry, queued (`pulled`) for a target that takes no inbound ssh to pull, or (`cancelled`) refused by the peer and
 * kept in state/outbox/cancelled/.
 */
export type SendResult =
    | { delivered: true; stdout: string }
    | { delivered: false; pulled: boolean; error: string; refused?: string };

/** What a sender prints for an item not delivered: who picks it up next, or that it was refused. */
export function queuedText(name: string, sent: { pulled: boolean; refused?: string }): string {
    if (sent.refused !== undefined)
        return `not sent: ${name} refused it: ${sent.refused} (kept in state/outbox/cancelled/)`;
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
    const peer = httpPeer(to.name);
    let httpsFailed: string | null = null;
    if (peer !== undefined) {
        writeJsonAtomic(queued, item);
        const flushed = flushSync(peer.name, id)[0];
        const receipt = flushed?.receipts.find((entry) => entry.id === id);
        if (receipt?.status === "applied" || receipt?.status === "duplicate")
            return { delivered: true, stdout: receipt.stdout };
        if (receipt?.status === "refused")
            return {
                delivered: false,
                pulled: false,
                refused: receipt.reason ?? "no reason",
                error: `${peer.name} refused it: ${receipt.reason ?? "no reason"} (kept in state/outbox/cancelled/)`,
            };
        if (receipt !== undefined || flushed?.unreachable === undefined)
            return {
                delivered: false,
                pulled: false,
                error: `${peer.name} ${receipt?.status ?? "did not take it"}: ${receipt?.reason ?? flushed?.error ?? "no receipt"}`,
            };
        httpsFailed = `HTTPS: ${flushed.unreachable}`;
        if (pulled !== null || !sshFallback() || to.ssh === "")
            return { delivered: false, pulled: pulled !== null, error: httpsFailed };
        try {
            renameSync(queued, `${queued}.sending-${process.pid}`);
        } catch {
            return { delivered: false, pulled: false, error: httpsFailed };
        }
    } else if (pulled !== null) {
        writeJsonAtomic(queued, item);
        return { delivered: false, pulled: true, error: inboundOffText(pulled) };
    }
    const claimed = `${queued}.sending-${process.pid}`;
    if (peer === undefined) writeJsonAtomic(claimed, item);
    const started = performance.now();
    const sent = run([...sshArgs(to.ssh), remoteCommand(item, to.root)], {
        stdin: body,
        timeoutMs: DELIVERY_TIMEOUT_MS,
    });
    recordSsh(to.name, id, item, started, sent.code);
    if (sent.code === 0) {
        rmSync(claimed, { force: true });
        return { delivered: true, stdout: sent.stdout };
    }
    const refused = refusalOf(sent);
    if (refused !== null) {
        renameSync(claimed, queued);
        cancelItems([`${id}.json`], `${to.name ?? to.ssh} refused it: ${refused}`);
        return { delivered: false, pulled: false, refused, error: `${to.name ?? to.ssh} refused it: ${refused}` };
    }
    renameSync(claimed, queued);
    const sshError = `ssh ${to.ssh} exited ${sent.code}: ${(sent.stderr || sent.stdout).trim()}`;
    return { delivered: false, pulled: false, error: httpsFailed === null ? sshError : `${httpsFailed}; ${sshError}` };
}

/** Time one ssh delivery to a named machine, for comparing it with HTTPS (`bin/toli peer stats`). */
function recordSsh(name: string | undefined, id: string, item: OutboxItem, started: number, code: number): void {
    if (name === undefined) return;
    recordStat({
        peer: name,
        id,
        kind: item.kind ?? "inbox",
        transport: "ssh",
        ms: Math.round(performance.now() - started),
        outcome: code === 0 ? "applied" : `exit ${code}`,
    });
}

/** Send one inbox message to another fleet machine now, or queue it for the tick when that machine is unreachable. */
export function sendToMachine(from: string, to: FleetMachine, title: string, body: string, id: string): SendResult {
    return sendNow(from, to, "inbox", title, body, id);
}
