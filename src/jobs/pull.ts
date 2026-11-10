// Pulling (docs/fleet.md "Machines that take no inbound ssh"). A machine marked `inbound: false` in the fleet list is
// never ssh-ed into: what the others would deliver to it over ssh (talk, delegations and their updates, inbox items,
// job results, share answers, task answers, queue offers) waits in their outbox (src/jobs/outbox.ts), and its minute
// tick fetches it with `bin/toli outbox pull`. That ssh-es out to each other machine (the allowed direction) and runs
//
//   outbox pending --for <self>   there: the items queued there for this machine, oldest first (stdin: this
//                                 machine's `fleet export`, so the list and the flag reach that machine too)
//   (apply each here)             the same `bin/toli` command an ssh delivery runs there, with the item as stdin
//   outbox ack --for <self>       there: drop the applied items and run their delivery hook (a delegation's answer)
//
// Each sender's items apply in order, and the first that fails stops that sender's batch until the next pull. An item
// applied here is recorded in state/pulled/<sender>.json until its ack lands, so an item pulled again (the ack was
// lost, the sender was offline) is acknowledged again without being applied twice.
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { Args } from "../core/args.ts";
import { type FleetMachine, inboundOff, loadFleet, loadMachine, remoteToliCommand, sshArgs } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import {
    out,
    pidAlive,
    printJson,
    readJson,
    readStdin,
    requireName,
    run,
    runAsync,
    shellQuote,
    ToliError,
    warn,
    writeJsonAtomic,
} from "../core/util.ts";
import { onOutboxDelivered } from "../fleet/delegate.ts";
import { fleetExport, takePullerExport } from "../fleet/fleet-sync.ts";
import { deliveryArgv, itemTarget, type OutboxItem, type Queued, queuedItems } from "./outbox.ts";

/** This checkout's CLI (not paths.toliBin(): TOLI_ROOT may point the data elsewhere, as in tests). */
const TOLI_SCRIPT = resolve(import.meta.dir, "..", "..", "bin", "toli");
const CONNECT_SECONDS = 15;
const REMOTE_TIMEOUT_MS = 120_000;
const APPLY_TIMEOUT_MS = 120_000;
/** An applied item whose ack never landed is forgotten after this long (its sender dropped it long ago). */
const APPLIED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

/** What `outbox pending` prints: the items queued for the puller, oldest first. */
export type PendingBatch = { items: Array<{ id: string; item: OutboxItem }> };

/** What `outbox ack` reads on stdin: each item applied, with what applying it printed (a delegation's answer). */
export type PullAcks = { acks: Array<{ id: string; stdout: string }> };

/** state/pulled/<sender>.json: items applied here whose ack has not landed there yet. */
type Applied = Record<string, { stdout: string; at: number }>;

// The sender's side.

/** The items queued here for `puller`: addressed to it, or (on a worker) untargeted results when it is the coordinator. */
function queuedFor(puller: string): Queued[] {
    const machine = loadMachine();
    const entry = loadFleet().machines.find((candidate) => candidate.name === puller);
    return queuedItems().filter(({ item }) =>
        item.to === undefined
            ? entry !== undefined && itemTarget(item, machine)?.ssh === entry.ssh
            : item.to.name === puller,
    );
}

/** `outbox pending --for <machine>`: print what waits here for it; stdin may carry its `fleet export`. */
function pending(args: Args): void {
    const puller = requireName("machine", args.str("for"));
    const exported = readStdin();
    if (exported.trim() !== "") {
        try {
            takePullerExport(exported, puller);
        } catch (error) {
            warn(`config/fleet.json kept: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    printJson({ items: queuedFor(puller).map(({ file, item }) => ({ id: file, item })) } satisfies PendingBatch);
}

function parseAcks(text: string): PullAcks {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new ToliError("outbox ack needs its JSON on stdin");
    }
    const acks = typeof value === "object" && value !== null ? Reflect.get(value, "acks") : undefined;
    if (!Array.isArray(acks)) throw new ToliError("outbox ack: no acks");
    return {
        acks: acks.map((entry: unknown) => {
            const id = typeof entry === "object" && entry !== null ? Reflect.get(entry, "id") : undefined;
            const stdout = typeof entry === "object" && entry !== null ? Reflect.get(entry, "stdout") : undefined;
            if (typeof id !== "string" || !ITEM_ID.test(id) || typeof stdout !== "string")
                throw new ToliError("outbox ack: malformed ack");
            return { id, stdout };
        }),
    };
}

/** `outbox ack --for <machine>`: drop each item it applied, then run its delivery hook. Unknown ids are skipped. */
function ack(args: Args): void {
    const puller = requireName("machine", args.str("for"));
    const { acks } = parseAcks(readStdin());
    const mine = new Map(queuedFor(puller).map((entry) => [entry.file, entry.item]));
    let acked = 0;
    for (const { id, stdout } of acks) {
        const item = mine.get(id);
        if (item === undefined) continue;
        rmSync(join(paths.outboxDir(), id), { force: true });
        acked += 1;
        try {
            onOutboxDelivered({ item, stdout });
        } catch (error) {
            warn(`${id}: acknowledged, then ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    out(`outbox-acked ${acked}`);
}

// The puller's side.

export type PullReport = { pulled: number; applied: number; acked: number; errors: string[] };

function appliedFile(sender: string): string {
    return join(paths.pulledDir(), `${sender}.json`);
}

function saveApplied(sender: string, applied: Applied): void {
    const cutoff = Date.now() - APPLIED_KEEP_MS;
    const kept = Object.fromEntries(Object.entries(applied).filter(([, entry]) => entry.at >= cutoff));
    if (Object.keys(kept).length === 0) rmSync(appliedFile(sender), { force: true });
    else writeJsonAtomic(appliedFile(sender), kept);
}

function parseBatch(text: string): PendingBatch {
    const value: unknown = JSON.parse(text);
    const items = typeof value === "object" && value !== null ? Reflect.get(value, "items") : undefined;
    if (!Array.isArray(items)) throw new Error("no items");
    for (const entry of items) {
        const id: unknown = Reflect.get(entry, "id");
        const item: unknown = Reflect.get(entry, "item");
        if (typeof id !== "string" || !ITEM_ID.test(id) || typeof item !== "object" || item === null)
            throw new Error("malformed item");
        for (const field of ["from", "title", "body"])
            if (typeof Reflect.get(item, field) !== "string") throw new Error(`item ${id} has no ${field}`);
    }
    return { items } as PendingBatch;
}

/** Apply one sender's batch here in order, stopping at the first failure; returns the acks to send back. */
function applyBatch(sender: FleetMachine, batch: PendingBatch, report: PullReport): PullAcks["acks"] {
    const applied = readJson<Applied>(appliedFile(sender.name), {});
    const acks: PullAcks["acks"] = [];
    for (const { id, item } of batch.items) {
        const done = applied[id];
        if (done !== undefined) {
            acks.push({ id, stdout: done.stdout });
            continue;
        }
        // A machine speaks only for itself (as an ssh delivery's `--from` is held to the key's machine): an item
        // claiming another sender is dropped, never applied.
        if (item.from !== sender.name) {
            report.errors.push(`${sender.name} ${id}: refused and dropped: it claims to be from ${item.from}`);
            acks.push({ id, stdout: "" });
            continue;
        }
        let argv: string[];
        try {
            argv = deliveryArgv(item);
        } catch (error) {
            report.errors.push(`${sender.name} ${id}: ${error instanceof Error ? error.message : String(error)}`);
            break;
        }
        const result = run([process.execPath, TOLI_SCRIPT, ...argv], {
            cwd: paths.root(),
            env: { TOLI_ROOT: paths.root() },
            stdin: item.body,
            timeoutMs: APPLY_TIMEOUT_MS,
        });
        if (result.code !== 0) {
            report.errors.push(
                `${sender.name} ${id}: bin/toli ${argv.slice(0, 2).join(" ")} exited ${result.code}: ${(result.stderr || result.stdout).trim()}`,
            );
            break;
        }
        applied[id] = { stdout: result.stdout, at: Date.now() };
        saveApplied(sender.name, applied);
        report.applied += 1;
        acks.push({ id, stdout: result.stdout });
    }
    return acks;
}

/** Hold the pull lock for this pid, or null when a live pull already holds it. */
function claimPull(): string | null {
    const file = paths.lock("pull");
    try {
        const fd = openSync(file, "wx");
        writeSync(fd, String(process.pid));
        closeSync(fd);
        return file;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let holder = 0;
    try {
        holder = Number(readFileSync(file, "utf8").trim());
    } catch {
        // Released between the open and the read: take it.
    }
    if (pidAlive(holder)) return null;
    writeJsonAtomic(file, process.pid);
    return file;
}

/**
 * Pull from every other fleet machine what waits there for this one, apply it here and acknowledge it there. A
 * machine that does not answer keeps its items for the next pull. Null when another pull is running.
 */
export async function pullFleet(): Promise<PullReport | null> {
    const lock = claimPull();
    if (lock === null) return null;
    try {
        const self = loadMachine().name;
        const senders = loadFleet().machines.filter((entry) => entry.name !== self && !inboundOff(entry));
        const exported = JSON.stringify(fleetExport());
        const report: PullReport = { pulled: 0, applied: 0, acked: 0, errors: [] };
        const remote = (sender: FleetMachine, command: string, stdin: string) =>
            runAsync([...sshArgs(sender.ssh, CONNECT_SECONDS), remoteToliCommand(sender.root, command)], {
                stdin,
                timeoutMs: REMOTE_TIMEOUT_MS,
            });
        const fetched = await Promise.all(
            senders.map((sender) => remote(sender, `outbox pending --for ${shellQuote(self)}`, exported)),
        );
        const acking: Array<Promise<void>> = [];
        senders.forEach((sender, index) => {
            const result = fetched[index];
            if (result === undefined) return;
            if (result.code !== 0 || result.timedOut) {
                const why = result.timedOut ? "timed out" : `exited ${result.code}`;
                report.errors.push(
                    `${sender.name}: ssh ${sender.ssh} ${why}: ${(result.stderr || result.stdout).trim()}`,
                );
                return;
            }
            let batch: PendingBatch;
            try {
                batch = parseBatch(result.stdout);
            } catch (error) {
                report.errors.push(
                    `${sender.name}: bad outbox pending output: ${error instanceof Error ? error.message : String(error)}`,
                );
                return;
            }
            report.pulled += batch.items.length;
            const acks = applyBatch(sender, batch, report);
            if (acks.length === 0) return;
            acking.push(
                remote(
                    sender,
                    `outbox ack --for ${shellQuote(self)}`,
                    JSON.stringify({ acks } satisfies PullAcks),
                ).then((sent) => {
                    if (sent.code !== 0 || sent.timedOut) {
                        report.errors.push(
                            `${sender.name}: ack not sent (ssh ${sender.ssh} exited ${sent.code}); the next pull repeats it`,
                        );
                        return;
                    }
                    const applied = readJson<Applied>(appliedFile(sender.name), {});
                    for (const { id } of acks) delete applied[id];
                    saveApplied(sender.name, applied);
                    report.acked += acks.length;
                }),
            );
        });
        await Promise.all(acking);
        return report;
    } finally {
        rmSync(lock, { force: true });
    }
}

/** Whether this machine takes no inbound ssh, so its tick pulls (its own entry in config/fleet.json). */
export function pullsItsMessages(): boolean {
    const self = loadMachine().name;
    const entry = loadFleet().machines.find((machine) => machine.name === self);
    return entry !== undefined && inboundOff(entry);
}

/** One line for the tick log and `outbox pull`. */
export function pullText(report: PullReport | null): string {
    if (report === null) return "pull: another pull is running";
    return `pull: ${report.pulled} waiting, ${report.applied} applied, ${report.acked} acknowledged${report.errors.length > 0 ? `; ${report.errors.length} problem(s)` : ""}`;
}

/** `outbox pending --for <m>` | `outbox ack --for <m>` (a sender's side) | `outbox pull [--json]` (the puller's). */
export async function outboxCommand(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;
    if (sub === "pending" || sub === "ack") {
        const args = new Args(rest, { values: ["for"] });
        args.maxPositional(0);
        if (sub === "pending") pending(args);
        else ack(args);
        return;
    }
    if (sub === "pull") {
        const args = new Args(rest, { booleans: ["json"] });
        args.maxPositional(0);
        const report = await pullFleet();
        if (args.bool("json")) {
            printJson(report);
            return;
        }
        out(pullText(report));
        for (const error of report?.errors ?? []) out(`- ${error}`);
        return;
    }
    throw new ToliError("usage: toli outbox pull [--json] | pending --for <machine> | ack --for <machine>");
}
