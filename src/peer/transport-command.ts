// `bin/toli peer flush|stats|ask` (docs/peers.md "Delivery"): send what waits for paired peers now, compare how
// HTTPS and ssh delivered, and ask a peer for its status over HTTPS.
import { existsSync, readFileSync } from "node:fs";
import { Args } from "../core/args.ts";
import { paths } from "../core/paths.ts";
import { out, printJson, ToliError } from "../core/util.ts";
import type { Stat } from "./client.ts";
import { askStatus, delegationHook, type Flush, flushAll, flushPeer, type OnDelivered, pullPeers } from "./deliver.ts";
import { requirePeer } from "./store.ts";

/** `peer flush <peer>|--all [--own <id>] [--json]`: deliver now over HTTPS (the outbox runs this as a subprocess). */
export async function flushCommand(argv: string[]): Promise<void> {
    const args = new Args(argv, { booleans: ["all", "json"], values: ["own"] });
    args.maxPositional(1);
    const own = args.str("own");
    const hook = await delegationHook();
    const onDelivered: OnDelivered = (item, stdout, file) => {
        if (own === undefined || file !== `${own}.json`) hook(item, stdout, file);
    };
    let flushes: Flush[];
    if (args.bool("all")) flushes = await flushAll(onDelivered);
    else flushes = [await flushPeer(requirePeer(args.pos(0, "peer")), onDelivered)];
    if (args.bool("json")) {
        printJson(flushes);
        return;
    }
    if (flushes.length === 0) out("nothing waits for a paired peer");
    for (const flush of flushes)
        out(
            `${flush.peer}: sent ${flush.sent}${flush.unreachable ? `; unreachable: ${flush.unreachable}` : ""}${flush.error ? `; ${flush.error}` : ""}`,
        );
}

function percentile(sorted: number[], fraction: number): number {
    if (sorted.length === 0) return 0;
    return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
}

/** `peer stats [--peer <p>] [--json]`: delivery count, median and p90 milliseconds per transport and peer. */
export function statsCommand(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json"], values: ["peer"] });
    args.maxPositional(0);
    const only = args.str("peer");
    const path = paths.peerStats();
    const stats = existsSync(path)
        ? readFileSync(path, "utf8")
              .split("\n")
              .filter((line) => line.trim() !== "")
              .map((line) => JSON.parse(line) as Stat)
              .filter((stat) => only === undefined || stat.peer === only)
        : [];
    const groups = new Map<string, number[]>();
    for (const stat of stats) {
        const key = `${stat.transport}\t${stat.peer}`;
        groups.set(key, [...(groups.get(key) ?? []), stat.ms]);
    }
    const rows = [...groups].map(([key, values]) => {
        const [transport = "", peer = ""] = key.split("\t");
        const sorted = [...values].sort((a, b) => a - b);
        return {
            transport,
            peer,
            count: sorted.length,
            medianMs: percentile(sorted, 0.5),
            p90Ms: percentile(sorted, 0.9),
        };
    });
    if (args.bool("json")) {
        printJson(rows);
        return;
    }
    if (rows.length === 0) {
        out("no deliveries recorded yet");
        return;
    }
    for (const row of rows)
        out(`${row.transport}\t${row.peer}\t${row.count} sent\tmedian ${row.medianMs} ms\tp90 ${row.p90Ms} ms`);
}

/** `peer ask <peer> status [--json]`: that machine's `resources --json`, over HTTPS (its `status` permission). */
export async function askCommand(argv: string[]): Promise<void> {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(2);
    const peer = requirePeer(args.pos(0, "peer"));
    const what = args.pos(1, "what");
    if (what !== "status") throw new ToliError("usage: toli peer ask <peer> status [--json]");
    const { value, ms } = await askStatus(peer);
    if (args.bool("json")) {
        printJson(value);
        return;
    }
    const queue = value.queue as Record<string, unknown> | undefined;
    out(
        [
            `${peer.name} (${ms} ms over HTTPS): ${value.available === true ? "available" : "not available"}`,
            `load ${String(value.load1)} on ${String(value.cpus)} cpus, ${String(value.memAvailableMB)} MB memory free, ${String(value.diskFreeGB)} GB disk free`,
            `runs ${String(value.activeRuns)} of ${String(value.maxRuns)}${queue === undefined ? "" : `, queue ${JSON.stringify(queue)}`}`,
            ...(Array.isArray(value.reasons) && value.reasons.length > 0
                ? [`why not: ${value.reasons.join("; ")}`]
                : []),
        ].join("\n"),
    );
}

/** `peer pull [--json]`: take what every paired peer holds for this machine (the tick does it when listen is off). */
export async function pullCommand(argv: string[]): Promise<void> {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const reports = await pullPeers();
    if (args.bool("json")) {
        printJson(reports);
        return;
    }
    if (reports.length === 0) out("no paired peer to pull from");
    for (const report of reports)
        out(`${report.peer}: ${report.applied} applied${report.error === undefined ? "" : `; ${report.error}`}`);
}
