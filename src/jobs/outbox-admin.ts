// What waits in the outbox and what was given up (docs/peers.md "The queue"): `outbox list|cancel|expire`, the
// "waiting to send" lines `fleet status` and the digest show, and the waiting alerts the tick posts once per target
// and age threshold (1 hour, 1 day, then each further day). Nothing is dropped silently: a cancelled, expired or
// refused item moves to state/outbox/cancelled/ with its reason, and an inbox item lists it.
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Args, parseMinutes } from "../core/args.ts";
import { loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, out, printJson, readJson, ToliError, waited, withLock, writeJsonAtomic } from "../core/util.ts";
import { addInboxItem } from "../records/inbox.ts";
import { type OutboxItem, type Queued, queuedItems } from "./outbox.ts";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** An item given up, as kept in state/outbox/cancelled/. */
export type Cancelled = OutboxItem & { cancelledAt: string; reason: string };

/** The machine a queued item waits for: its target, or the coordinator for a worker's untargeted results. */
export function waitingFor(item: OutboxItem): string {
    return item.to?.name ?? "the coordinator";
}

function ageOf(item: OutboxItem): number {
    return now().getTime() - (item.queuedAt ?? now().getTime());
}

/**
 * Move queued `<id>.json` files to cancelled/ with `reason` (a file being sent right now is skipped: it is not
 * queued), then post one inbox item here listing them. Returns the ids moved.
 */
export function cancelItems(files: string[], reason: string): string[] {
    const moved: Array<{ id: string; item: OutboxItem }> = [];
    withLock(paths.lock("outbox-cancel"), () => {
        const dir = paths.outboxDir();
        const cancelled = paths.outboxCancelledDir();
        for (const file of files) {
            const claimed = join(dir, `${file}.cancelling-${process.pid}`);
            try {
                renameSync(join(dir, file), claimed);
            } catch {
                continue;
            }
            const item = readJson<OutboxItem | null>(claimed, null);
            if (item !== null) {
                const kept: Cancelled = { ...item, cancelledAt: now().toISOString(), reason };
                writeJsonAtomic(join(cancelled, file), kept);
                moved.push({ id: file.replace(/\.json$/, ""), item });
            }
            rmSync(claimed, { force: true });
        }
    });
    if (moved.length > 0) {
        const lines = moved.map(
            ({ id, item }) => `- ${id}: ${item.kind ?? "inbox"} to ${waitingFor(item)}: ${item.title.slice(0, 120)}`,
        );
        addInboxItem(
            loadMachine().name,
            `${moved.length} outbox item${moved.length === 1 ? "" : "s"} not sent: ${reason}`.slice(0, 200),
            [
                `These were not delivered and will not be retried (${reason}). They are kept in state/outbox/cancelled/.`,
                "",
                ...lines,
            ].join("\n"),
        );
    }
    return moved.map(({ id }) => id);
}

/** The queued items for `target` (a machine name). */
export function itemsFor(target: string): Queued[] {
    return queuedItems().filter(({ item }) => item.to?.name === target);
}

/** One line per machine something waits for: `3 to deepak-mbp, oldest 2 d`. */
export function waitingLines(): string[] {
    const byTarget = new Map<string, { count: number; oldest: number }>();
    for (const { item } of queuedItems()) {
        const target = waitingFor(item);
        const entry = byTarget.get(target) ?? { count: 0, oldest: 0 };
        entry.count += 1;
        entry.oldest = Math.max(entry.oldest, ageOf(item));
        byTarget.set(target, entry);
    }
    return [...byTarget].map(([target, { count, oldest }]) => `${count} to ${target}, oldest ${waited(oldest)}`);
}

/** The thresholds an age has crossed: 0 for 1 hour, 1 for 1 day, n for n days. */
function threshold(ms: number): number {
    if (ms < HOUR_MS) return -1;
    return ms < DAY_MS ? 0 : Math.floor(ms / DAY_MS);
}

/**
 * The tick's waiting alerts: one inbox item here per target whose oldest item crossed a new threshold (1 hour, 1 day,
 * each further day), recorded in state/outbox-alerts.json so it fires once. A target with nothing queued is cleared.
 * Returns the alerts posted.
 */
export function postWaitingAlerts(): string[] {
    return withLock(paths.lock("outbox-alerts"), () => {
        const fired = readJson<Record<string, number>>(paths.outboxAlerts(), {});
        const byTarget = new Map<string, Queued[]>();
        for (const queued of queuedItems()) {
            const target = waitingFor(queued.item);
            byTarget.set(target, [...(byTarget.get(target) ?? []), queued]);
        }
        const posted: string[] = [];
        for (const target of Object.keys(fired)) if (!byTarget.has(target)) delete fired[target];
        for (const [target, items] of byTarget) {
            const oldest = items[0]?.item;
            if (oldest === undefined) continue;
            const age = ageOf(oldest);
            const level = threshold(age);
            if (level < 0 || (fired[target] ?? -1) >= level) continue;
            fired[target] = level;
            const title = `${items.length} message${items.length === 1 ? "" : "s"} to ${target} waiting ${waited(age)}`;
            addInboxItem(
                loadMachine().name,
                title,
                [
                    `${title} (oldest: ${oldest.kind ?? "inbox"} "${oldest.title.slice(0, 120)}").`,
                    "They go out by themselves, in order, once it is reachable (or when it announces itself).",
                    `See them: bin/toli outbox list --to ${target}. Give up on them: bin/toli outbox cancel --to ${target}.`,
                ].join("\n"),
            );
            posted.push(title);
        }
        writeJsonAtomic(paths.outboxAlerts(), fired);
        return posted;
    });
}

function list(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json", "cancelled"], values: ["to"] });
    args.maxPositional(0);
    const to = args.str("to");
    if (args.bool("cancelled")) {
        const dir = paths.outboxCancelledDir();
        const kept = existsSync(dir)
            ? readdirSync(dir)
                  .filter((file) => file.endsWith(".json"))
                  .sort()
                  .map((file) => ({
                      id: file.replace(/\.json$/, ""),
                      ...readJson<Cancelled>(join(dir, file), {} as Cancelled),
                  }))
                  .filter((entry) => to === undefined || entry.to?.name === to)
            : [];
        if (args.bool("json")) printJson(kept.map(({ body: _body, ...entry }) => entry));
        else if (kept.length === 0) out("nothing cancelled");
        else for (const entry of kept) out(`${entry.id}\t${waitingFor(entry)}\t${entry.cancelledAt}\t${entry.reason}`);
        return;
    }
    const items = queuedItems().filter(({ item }) => to === undefined || item.to?.name === to);
    const rows = items.map(({ file, item }) => ({
        id: file.replace(/\.json$/, ""),
        to: waitingFor(item),
        kind: item.kind ?? "inbox",
        title: item.title,
        queuedAt: item.queuedAt === undefined ? null : new Date(item.queuedAt).toISOString(),
        age: waited(ageOf(item)),
    }));
    if (args.bool("json")) {
        printJson(rows);
        return;
    }
    if (rows.length === 0) {
        out("the outbox is empty");
        return;
    }
    for (const row of rows) out(`${row.id}\t${row.to}\t${row.kind}\t${row.age}\t${row.title.slice(0, 80)}`);
}

function cancel(argv: string[]): void {
    const args = new Args(argv, { values: ["to", "why"] });
    args.maxPositional(1);
    const id = args.positional[0];
    const to = args.str("to");
    if ((id === undefined) === (to === undefined))
        throw new ToliError("usage: toli outbox cancel <id> | --to <machine>");
    const files =
        id !== undefined
            ? [`${id.replace(/\.json$/, "")}.json`].filter((file) => existsSync(join(paths.outboxDir(), file)))
            : itemsFor(to ?? "").map(({ file }) => file);
    if (files.length === 0) throw new ToliError(id !== undefined ? `no queued item ${id}` : `nothing queued for ${to}`);
    const moved = cancelItems(files, `cancelled here${args.str("why") ? `: ${args.str("why")}` : ""}`);
    out(`cancelled ${moved.length} item${moved.length === 1 ? "" : "s"}: ${moved.join(", ")}`);
}

function expire(argv: string[]): void {
    const args = new Args(argv, { values: ["older"] });
    args.maxPositional(0);
    const raw = args.str("older");
    const days = raw === undefined ? undefined : /^(\d+)d$/.exec(raw)?.[1];
    const minutes = days !== undefined ? Number(days) * 24 * 60 : parseMinutes(raw);
    if (minutes === undefined) throw new ToliError("usage: toli outbox expire --older <N>d (or minutes)");
    const files = queuedItems()
        .filter(({ item }) => ageOf(item) > minutes * 60_000)
        .map(({ file }) => file);
    if (files.length === 0) {
        out(`nothing queued is older than ${raw}`);
        return;
    }
    const moved = cancelItems(files, `expired: queued more than ${raw}`);
    out(`expired ${moved.length} item${moved.length === 1 ? "" : "s"}: ${moved.join(", ")}`);
}

/** `outbox list|cancel|expire`; returns false for any other subcommand (pull.ts handles pull, pending, ack). */
export function outboxAdminCommand(sub: string | undefined, rest: string[]): boolean {
    if (sub === "list") list(rest);
    else if (sub === "cancel") cancel(rest);
    else if (sub === "expire") expire(rest);
    else return false;
    return true;
}
