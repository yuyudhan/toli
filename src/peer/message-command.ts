// What a verified message may claim, and the `bin/toli` command it runs here (docs/peers.md "The envelope"):
// `applyBatch` (src/peer/envelope.ts) checks the claim first, then runs the command with the body on stdin.
import { isJsonObject } from "../core/util.ts";
import { loadBacklog } from "../records/backlog.ts";
import { answerers, fleetId, splitFleetId } from "../records/delegation-report.ts";
import { unrecordedReason } from "../records/report-refusal.ts";
import type { Envelope, EnvelopeKind } from "./envelope.ts";
import type { Peer } from "./store.ts";

function parseBody(body: string): Record<string, unknown> | null {
    try {
        const value: unknown = JSON.parse(body);
        return isJsonObject(value) ? value : null;
    } catch {
        return null;
    }
}

/**
 * Whether `peer` may say what this message claims (null when it may, else why not): a delegation, link or share
 * speaks only for its sender; an update comes only from the task's owner and, when it names a task here, only for a
 * delegation recorded on that task, or one that task sent to that peer whose receipt has not landed yet (`sending`);
 * an answer goes only to a task that peer delegated here, or that was forwarded here from work it delegated
 * (`upstream`), or, from this worker's coordinator, to this machine's own task (a hold raised there). An
 * introduction's certificate is checked by `peer introduction` itself (src/peer/introduce.ts).
 */
export function senderClaimRefusal(peer: string, kind: EnvelopeKind, body: string): string | null {
    if (kind === "inbox" || kind === "introduction") return null;
    const value = parseBody(body);
    if (value === null) return `${kind} body is not a JSON object`;
    if (kind === "delegation" || kind === "link")
        return value.from === peer ? null : `${kind} claims to be from ${String(value.from)}, not ${peer}`;
    if (kind === "share") {
        const share = isJsonObject(value.share) ? value.share : null;
        const claimed = value.type === "learning" ? share?.from : value.machine;
        return claimed === peer ? null : `share claims to be from ${String(claimed)}, not ${peer}`;
    }
    if (kind === "update") {
        if (value.owner !== peer) return `update for ${String(value.owner)}'s task sent by ${peer}`;
        if (typeof value.id !== "string") return "update without a task id";
        if (typeof value.forTask !== "string") return null;
        const id = fleetId(peer, value.id);
        const local = loadBacklog().tasks.find((task) => task.id === value.forTask);
        const recorded =
            local?.delegatedTo?.includes(id) === true ||
            local?.slices?.includes(id) === true ||
            local?.sending?.some((sent) => sent.machine === peer && sent.id === value.delegation) === true;
        return recorded ? null : unrecordedReason(String(value.forTask), id);
    }
    if (kind === "answer") {
        if (typeof value.id !== "string" || typeof value.answer !== "string") return "answer without id and answer";
        const id = splitFleetId(value.id).id;
        const task = loadBacklog().tasks.find((entry) => entry.id === id);
        if (task === undefined) return `no task ${id} here`;
        return answerers(task).includes(peer) ? null : `${id} was not delegated here by ${peer}`;
    }
    return `${kind} is not a message`;
}

/** The `bin/toli` command a verified message runs here; stdin is its body. The sender is the verified peer. */
export function applyArgv(peer: Peer, envelope: Envelope): string[] {
    const from = peer.name;
    switch (envelope.kind) {
        case "delegation":
            return ["delegation", "receive", "--from", from];
        case "update":
            return ["delegation", "update", "--from", from];
        case "link":
            return ["delegation", "link", "--from", from];
        case "share":
            return ["share", "receive"];
        case "answer": {
            const value = parseBody(envelope.body) ?? {};
            const id = splitFleetId(String(value.id)).id;
            return ["task", "answer", id, String(value.answer), "--from", from, "--answer-id", envelope.id];
        }
        case "introduction":
            return ["peer", "introduction", "--from", from];
        default:
            return [
                "inbox",
                "add",
                "--from",
                from,
                "--title",
                envelope.title,
                "--via",
                `peer ${from} (fingerprint ${peer.fingerprint.slice(0, 16)})`,
            ];
    }
}
