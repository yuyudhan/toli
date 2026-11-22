// `bin/toli fleet queues` and the lead service's balancing pass. Work goes to the machine with the shortest queue
// (src/fleet/pick.ts rankMachines); between leads, a machine whose queue is `lead.balanceGap` deeper than the shortest
// offers its queued work to that machine's lead, and a machine with an empty queue asks the deepest one for work
// (docs/sardars.md "Queues decide where work goes").
import { Args } from "../core/args.ts";
import { fleetMachine, loadMachine, type Machine, otherFleetMachines } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import {
    now,
    out,
    printJson,
    readJson,
    shellQuote,
    stamp,
    ToliError,
    withLock,
    writeJsonAtomic,
} from "../core/util.ts";
import { sendToMachine } from "../jobs/outbox.ts";
import { addInboxItem } from "../records/inbox.ts";
import { briefPath } from "../records/stale.ts";
import { fleetStatus } from "./fleet-probe.ts";
import { rankMachines, refusesShip, verifyOnlyText } from "./pick.ts";
import { perSlot, type Queue, queueText, slotText, waitingTasks } from "./queue.ts";
import type { FleetEntry } from "./resources.ts";

const DEFAULT_BALANCE_MINUTES = 30;
const DEFAULT_BALANCE_GAP = 3;

/** `lead.balanceMinutes`: how often the lead service compares queues across the fleet. */
export function balanceMinutes(machine: Machine): number {
    const raw: unknown = machine.lead?.balanceMinutes;
    if (raw === undefined) return DEFAULT_BALANCE_MINUTES;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)
        throw new ToliError("config/machine.json lead.balanceMinutes must be a positive number");
    return raw;
}

/** `lead.balanceGap`: how much deeper than the shortest queue a machine's must be before work is offered or asked. */
export function balanceGap(machine: Machine): number {
    const raw: unknown = machine.lead?.balanceGap;
    if (raw === undefined) return DEFAULT_BALANCE_GAP;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0)
        throw new ToliError("config/machine.json lead.balanceGap must be a positive integer");
    return raw;
}

/** One machine in `fleet queues`; `queue` is null when it is unreachable or its toli reports none. */
type QueueRow = {
    machine: string;
    local: boolean;
    reachable: boolean;
    queue: Queue | null;
    /** Queue depth per jawan slot: what ranks it. */
    load: number | null;
    /** Its jawan slots (`capacity.maxRuns`), which native subagent jawans share with spawn runs. */
    slots: number | null;
    reasons: string[];
    /** The projects it takes no ship work for (`project set <p> --role verify-only` there). */
    verifyOnly: string[];
    /** An unreachable machine's last snapshot seen here: when it was taken and its queue then (stale, never ranked). */
    lastSeen: { at: string; queue: Queue | null } | null;
};

/** A machine with a known queue, for comparing depths. */
type Known = { machine: string; local: boolean; queue: Queue };

/** Every machine, lightest queue per slot first (the pick ranking without a project), full and unreachable last. */
function queueRows(entries: FleetEntry[]): QueueRow[] {
    const ranking = rankMachines(entries);
    const order = [...ranking.candidates, ...ranking.rejected].map((entry) => entry.machine);
    return order.flatMap((name) => {
        const entry = entries.find((candidate) => candidate.machine === name);
        if (entry === undefined) return [];
        const queue = entry.resources?.queue ?? null;
        return [
            {
                machine: entry.machine,
                local: entry.local,
                reachable: entry.resources !== null,
                queue,
                load: queue === null || entry.resources === null ? null : perSlot(queue.depth, entry.resources.maxRuns),
                slots: entry.resources?.maxRuns ?? null,
                reasons: entry.resources === null ? entry.reasons : [],
                verifyOnly: entry.resources?.verifyOnly ?? [],
                lastSeen: entry.lastSeen === undefined ? null : { at: entry.lastSeen.at, queue: entry.lastSeen.queue },
            },
        ];
    });
}

/**
 * The rows whose queue is known, still lightest first. A full machine (`lead full`) is left out, so no offer goes to
 * it and no work is asked of it; this machine stays in even when full (it may still offer its work away).
 */
function knownQueues(rows: QueueRow[]): Known[] {
    return rows.flatMap((row) =>
        row.queue === null || (row.queue.full !== undefined && !row.local)
            ? []
            : [{ machine: row.machine, local: row.local, queue: row.queue }],
    );
}

/** The first of the deepest queues. */
function deepestQueue(rows: Known[]): Known | undefined {
    return rows.reduce<Known | undefined>(
        (deepest, row) => (deepest === undefined || row.queue.depth > deepest.queue.depth ? row : deepest),
        undefined,
    );
}

/** `; <machine> takes no ship work for <p>, <q>` when it marked projects verify-only, else nothing. */
function noShipText(machine: string, verifyOnly: string[]): string {
    return verifyOnly.length === 0 ? "" : `; ${machine} takes no ship work for ${verifyOnly.join(", ")} (verify-only)`;
}

/** The delegation `fleet queues` suggests when the longest known queue is at least `gap` deeper than the shortest. */
function queueSuggestion(rows: QueueRow[], gap: number): string | null {
    const depths = knownQueues(rows);
    const shortest = depths[0];
    const longest = deepestQueue(depths);
    if (shortest === undefined || longest === undefined) return null;
    const difference = longest.queue.depth - shortest.queue.depth;
    if (difference < gap) return null;
    const verifyOnly = rows.find((row) => row.machine === shortest.machine)?.verifyOnly ?? [];
    return [
        `suggestion: ${longest.machine}'s queue (${longest.queue.depth}) is ${difference} deeper than`,
        `${shortest.machine}'s (${shortest.queue.depth}); on ${longest.machine}, hand queued work over with`,
        `bin/toli delegate ${shortest.machine} "<title>" --brief <file> [--project <p>]${noShipText(shortest.machine, verifyOnly)}`,
    ].join(" ");
}

function rowLine(row: QueueRow): string {
    const name = `${row.machine}${row.local ? " (this machine)" : ""}`;
    if (!row.reachable) {
        const reasons = row.reasons.join("; ") || "unreachable";
        if (row.lastSeen === null) return `${name}: ${reasons}`;
        return `${name}: ${reasons}; stale, last seen ${row.lastSeen.at}: ${queueText(row.lastSeen.queue)}`;
    }
    if (row.queue === null) return `${name}: queue unknown (its toli reports no queue)`;
    const slots = row.slots === null ? "" : `, ${slotText(row.queue, row.slots)}`;
    const verifyOnly = row.verifyOnly.length === 0 ? "" : `, verify-only ${row.verifyOnly.join(",")}`;
    return `${name}: ${queueText(row.queue)}, ${row.load} per jawan slot${slots}${verifyOnly}`;
}

/** `toli fleet queues [--json]`: every machine's queue, shortest first, then a suggested delegation if one is due. */
export async function queuesCommand(argv: string[]): Promise<void> {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const gap = balanceGap(loadMachine());
    const rows = queueRows(await fleetStatus());
    const suggestion = queueSuggestion(rows, gap);
    if (args.bool("json")) {
        printJson({ machines: rows, suggestion });
        return;
    }
    for (const row of rows) out(rowLine(row));
    if (suggestion !== null) out(suggestion);
}

// ---------------------------------------------------------------- balancing between leads

/** What one balancing pass sent: an offer to this machine's own lead, or an ask to another machine's lead. */
type BalanceSent = { kind: "offer" | "ask"; machine: string; at: string };

/**
 * `state/lead/balance.json`: when the last pass ran (its period starts there), what that pass sent, and per machine
 * the task ids of the last offer posted for it (an offer of the same set to the same machine is not posted again).
 */
type BalanceState = { lastPass?: string; sent?: BalanceSent[]; offered?: Record<string, string[]> };

/** Claim this period's pass: false when the previous pass is less than `minutes` old. */
function claimPeriod(minutes: number): boolean {
    return withLock(paths.lock("lead-balance"), () => {
        const state = readJson<BalanceState>(paths.leadBalanceState(), {});
        const last = state.lastPass === undefined ? Number.NaN : Date.parse(state.lastPass);
        const at = now();
        if (Number.isFinite(last) && at.getTime() - last < minutes * 60_000) return false;
        const claimed: BalanceState = { ...state, lastPass: at.toISOString(), sent: [] };
        writeJsonAtomic(paths.leadBalanceState(), claimed);
        return true;
    });
}

function recordSent(sent: BalanceSent, offered?: string[]): void {
    withLock(paths.lock("lead-balance"), () => {
        const state = readJson<BalanceState>(paths.leadBalanceState(), {});
        const next: BalanceState = {
            ...state,
            sent: [...(state.sent ?? []), sent],
            ...(offered === undefined ? {} : { offered: { ...state.offered, [sent.machine]: offered } }),
        };
        writeJsonAtomic(paths.leadBalanceState(), next);
    });
}

/** Whether the last offer posted for `machine` listed exactly the tasks `ids` (sorted). */
function alreadyOffered(machine: string, ids: string[]): boolean {
    const last = readJson<BalanceState>(paths.leadBalanceState(), {}).offered?.[machine];
    return last !== undefined && last.length === ids.length && last.every((id, index) => id === ids[index]);
}

/** One task an offer lists: its id and its `bin/toli delegate` line. */
type OfferLine = { id: string; line: string };

/**
 * The delegate command for each of this machine's tasks waiting for a jawan that `target` can take, with its brief
 * when it has one. A task bound to this machine stays out: delegated here by another machine (work is never bounced
 * or delegated on by the balancer; this covers verify work `target` itself delegated), pinned here (`task pin`), of a
 * project `target` has no clone of (its published `projects`: a machine that registered only some projects takes
 * only those, and an unsolicited offer never asks it to clone one), or ship work of a project `target` marked
 * verify-only (verify work goes, with `--verify`). A scout task's command keeps its shape.
 */
function delegateLines(target: FleetEntry): OfferLine[] {
    const cloned = new Set(target.resources?.projects ?? []);
    return waitingTasks()
        .filter(
            (task) =>
                task.delegatedBy === undefined &&
                task.pinned === undefined &&
                (task.project === "" || cloned.has(task.project)) &&
                !(
                    task.shape === "ship" &&
                    task.verify !== true &&
                    target.resources !== null &&
                    refusesShip(target.resources, task.project)
                ),
        )
        .map((task) => {
            const brief = briefPath(task.project, task.id);
            const line = [
                `  ${task.id}: bin/toli delegate ${target.machine} ${shellQuote(task.title)}`,
                `--brief ${brief === null ? "<file>" : shellQuote(brief)}`,
                ...(task.project === "" ? [] : [`--project ${shellQuote(task.project)}`]),
                ...(task.shape === "ship" ? [] : [`--shape ${task.shape}`]),
                ...(task.verify === true ? ["--verify"] : []),
            ].join(" ");
            return { id: task.id, line };
        });
}

/** The first other machine, lightest queue first, at least `gap` below `depth` that can take some queued task. */
function offerTarget(
    others: Known[],
    entries: FleetEntry[],
    depth: number,
    gap: number,
): { row: Known; lines: OfferLine[] } | undefined {
    for (const row of others) {
        if (depth < row.queue.depth + gap) continue;
        const target = entries.find((entry) => entry.machine === row.machine);
        const lines = target === undefined ? [] : delegateLines(target);
        if (lines.length > 0) return { row, lines };
    }
    return undefined;
}

/**
 * One balancing pass of the lead service, due every `lead.balanceMinutes` (the period is claimed under a lock, so
 * overlapping passes send nothing twice). Null when not due, when there is no other fleet machine, or when the queues
 * are within `lead.balanceGap` of each other. When this machine's depth (its native subagent jawans included) is at
 * least the gap above the shortest other known queue, it offers its queued work to the first machine, lightest queue
 * first, still at least the gap below it that can take some of it: an offer in its own inbox (waking its lead) with a
 * `bin/toli delegate` command per such task, posted once per change (the same task set offered to the same machine
 * last time is not posted again). When its queue is empty and another machine's is at least the gap deep, it asks
 * that machine's lead for work. Returns the line to log.
 */
export async function balancePass(): Promise<string | null> {
    const machine = loadMachine();
    if (otherFleetMachines().length === 0) return null;
    const minutes = balanceMinutes(machine);
    const gap = balanceGap(machine);
    if (!claimPeriod(minutes)) return null;
    const entries = await fleetStatus();
    const rows = knownQueues(queueRows(entries));
    const self = rows.find((row) => row.local);
    const others = rows.filter((row) => !row.local);
    const shortest = others[0];
    const deepest = deepestQueue(others);
    if (self === undefined || shortest === undefined || deepest === undefined) return null;
    const depth = self.queue.depth;
    if (depth === 0 && self.queue.full !== undefined) return null;
    if (depth >= shortest.queue.depth + gap) {
        const offer = offerTarget(others, entries, depth, gap);
        if (offer === undefined) return null;
        const { row: target, lines } = offer;
        const ids = lines.map((line) => line.id).sort();
        if (alreadyOffered(target.machine, ids)) return null;
        const body = [
            `${machine.name}'s queue is ${depth} deep; ${target.machine}'s is ${target.queue.depth}`,
            `(lead.balanceGap ${gap}). Hand queued work to ${target.machine}'s lead:`,
            "",
            ...lines.map((line) => line.line),
        ];
        addInboxItem(machine.name, `queue: offer work to ${target.machine}`, body.join("\n"));
        recordSent({ kind: "offer", machine: target.machine, at: now().toISOString() }, ids);
        return `queue: offered work to ${target.machine} (${machine.name} ${depth}, ${target.machine} ${target.queue.depth})`;
    }
    if (depth !== 0 || deepest.queue.depth < gap) return null;
    const verifyOnly = entries.find((entry) => entry.local)?.resources?.verifyOnly ?? [];
    const body = [
        `${machine.name}'s queue is empty; ${deepest.machine}'s is ${deepest.queue.depth} deep (lead.balanceGap ${gap}).`,
        `Hand queued work over with: bin/toli delegate ${machine.name} "<title>" --brief <file> [--project <p>]`,
        ...verifyOnly.map((project) => `No ship work of ${project}: ${machine.name} is ${verifyOnlyText(project)}.`),
        `Reply with: bin/toli talk ${machine.name} "<reply>"`,
    ];
    const sent = sendToMachine(
        machine.name,
        fleetMachine(deepest.machine),
        `queue: ${machine.name} has an empty queue`,
        body.join("\n"),
        `ask-${machine.name}-${stamp()}`,
    );
    recordSent({ kind: "ask", machine: deepest.machine, at: now().toISOString() });
    const delivery = sent.delivered
        ? "delivered"
        : sent.pulled
          ? "queued for its pull"
          : `queued for the tick: ${sent.error}`;
    return `queue: asked ${deepest.machine} for work (${machine.name} 0, ${deepest.machine} ${deepest.queue.depth}; ${delivery})`;
}
