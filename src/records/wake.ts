import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { Args } from "../core/args.ts";
import { paths } from "../core/paths.ts";
import { out, printJson, withLock } from "../core/util.ts";
import { listResults } from "../jobs/jobs.ts";
import { type AckStream, ackedThrough, ackThrough } from "./acks.ts";
import { listInbox } from "./inbox.ts";

/** One result that arrived since the last wake: an inbox message or a job result recorded on this machine. */
export type WakeItem = { kind: "inbox" | "job"; stamp: string; title: string; path: string; body: string };

/** Items shown with their body; the rest are listed by path only so one wake never floods the chat. */
const MAX_FULL_ITEMS = 10;
const BODY_LIMIT = 4000;

/** Items newer than both the user's ack and the last delivery are new; acknowledged items never wake. */
function floor(acked: AckStream, delivered: AckStream): string {
    return [ackedThrough(acked), ackedThrough(delivered)].sort().at(-1) ?? "";
}

function readBody(path: string): string {
    const text = readFileSync(path, "utf8").trimEnd();
    return text.length <= BODY_LIMIT ? text : `${text.slice(0, BODY_LIMIT)}\n[... truncated; full text in ${path}]`;
}

/**
 * Take every result that arrived since the last call and mark it delivered, so each item wakes the session
 * exactly once. The user's ack watermarks are untouched: the digest keeps showing items until acknowledged.
 */
export function takeWake(): WakeItem[] {
    return withLock(paths.lock("wake"), () => {
        const inboxFloor = floor("inbox", "inboxDelivered");
        const inbox = listInbox().filter((item) => item.stamp > inboxFloor);
        const jobsFloor = floor("jobs", "jobsDelivered");
        const jobs = listResults().filter((result) => result.stamp > jobsFloor);
        const lastInbox = inbox.at(-1);
        if (lastInbox) ackThrough("inboxDelivered", lastInbox.stamp);
        const lastJob = jobs.at(-1);
        if (lastJob) ackThrough("jobsDelivered", lastJob.stamp);
        const items: Omit<WakeItem, "body">[] = [
            ...inbox.map((item) => ({
                kind: "inbox" as const,
                stamp: item.stamp,
                title: `${item.from}: ${item.title}`,
                path: item.path,
            })),
            ...jobs.map((result) => ({
                kind: "job" as const,
                stamp: result.stamp,
                title: `job ${result.job} (${result.status})`,
                path: result.path,
            })),
        ];
        return items
            .sort((a, b) => a.stamp.localeCompare(b.stamp))
            .map((item) => ({ ...item, body: readBody(item.path) }));
    });
}

/** The message pushed into the live session for `items`; empty when nothing arrived. */
export function wakeMessage(items: WakeItem[]): string {
    if (items.length === 0) return "";
    const lines = [
        `[toli wake] ${items.length} new result${items.length === 1 ? "" : "s"} arrived.`,
        "Relay each outcome and any decision it needs to the user in plain words, then end the turn.",
        "Follow-up work goes to a jawan (dispatch it); do not do it here. After relaying, acknowledge with",
        "`bin/toli inbox ack` / `bin/toli job ack` so the digest stops listing them.",
    ];
    for (const item of items.slice(0, MAX_FULL_ITEMS))
        lines.push("", `## ${item.title} - ${relative(paths.root(), item.path)}`, "", item.body);
    const rest = items.slice(MAX_FULL_ITEMS);
    if (rest.length > 0) lines.push("", "More (read the file for details):");
    for (const item of rest) lines.push(`- ${item.title} - ${relative(paths.root(), item.path)}`);
    return lines.join("\n");
}

/** `toli wake [--json]`: take new results once; the session extension pushes the message into the chat. */
export function wakeCommand(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const items = takeWake();
    const message = wakeMessage(items);
    if (args.bool("json")) {
        printJson({ items, message });
        return;
    }
    out(message === "" ? "nothing new" : message);
}
