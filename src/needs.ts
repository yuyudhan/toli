// The Needs-you queue: every held task is one decision waiting on the user. `bin/toli needs` lists them grouped by
// project, blocking and oldest first, with a one-line reply hint each; the digest shows the same list at its top,
// flags holds with no question text (a bug: jawans must hold with a question), and re-surfaces a hold unanswered
// for `needs.staleDays` (config/machine.json, default 7) once, with the option to drop it.
import { Args } from "./args.ts";
import { type HoldOption, loadBacklog, matchOption, type Task, updateBacklog } from "./backlog.ts";
import { machineSettings } from "./config.ts";
import { now, out, printJson } from "./util.ts";

export const DEFAULT_STALE_DAYS = 7;
const DAY_MS = 86_400_000;

export type NeedItem = {
    id: string;
    project: string;
    title: string;
    /** null: held with no question text, which is a bug to fix (re-hold with --question). */
    question: string | null;
    options: HoldOption[];
    recommend: string | null;
    blocks: string | null;
    heldAt: string;
    ageDays: number;
    /** Unanswered for at least the stale threshold. */
    stale: boolean;
    /** Already re-surfaced as stale by an earlier digest. */
    staleSurfaced: boolean;
    /** What the user can type to answer, e.g. `T12: 1`. */
    reply: string;
};

export type NeedsGroup = { project: string; items: NeedItem[] };

export type Needs = { total: number; staleDays: number; groups: NeedsGroup[] };

/** `needs.staleDays` from config/machine.json; a missing or invalid value falls back to the default. */
export function staleDays(): number {
    const days = machineSettings().needs?.staleDays;
    return typeof days === "number" && Number.isFinite(days) && days > 0 ? days : DEFAULT_STALE_DAYS;
}

function replyHint(task: Task): string {
    const options = task.options ?? [];
    if (options.length === 0) return `"${task.id}: <answer>"`;
    const recommended = task.recommend === undefined ? undefined : matchOption(options, task.recommend);
    const number = recommended === undefined ? 1 : options.indexOf(recommended) + 1;
    return `"${task.id}: ${number}" (any option number, or own words)`;
}

function needItem(task: Task, at: Date, days: number): NeedItem {
    const heldAt = task.heldAt ?? task.updatedAt;
    const ageDays = Math.max(0, Math.floor((at.getTime() - Date.parse(heldAt)) / DAY_MS));
    const question = task.question?.trim();
    return {
        id: task.id,
        project: task.project,
        title: task.title,
        question: question ? question : null,
        options: task.options ?? [],
        recommend: task.recommend ?? null,
        blocks: task.blocks ?? null,
        heldAt,
        ageDays,
        stale: ageDays >= days,
        staleSurfaced: task.staleSurfacedAt !== undefined,
        reply: replyHint(task),
    };
}

/** Blocking holds first, then the oldest, then by id. */
function urgency(a: NeedItem, b: NeedItem): number {
    const blocking = Number(b.blocks !== null) - Number(a.blocks !== null);
    if (blocking !== 0) return blocking;
    if (a.heldAt !== b.heldAt) return a.heldAt < b.heldAt ? -1 : 1;
    return Number(a.id.slice(1)) - Number(b.id.slice(1));
}

/** The held tasks as the Needs-you queue: grouped by project, most urgent group and item first. */
export function needsQueue(tasks: Task[], at: Date = now(), days: number = staleDays()): Needs {
    const items = tasks
        .filter((task) => task.status === "held")
        .map((task) => needItem(task, at, days))
        .sort(urgency);
    const groups: NeedsGroup[] = [];
    for (const item of items) {
        const group = groups.find((entry) => entry.project === item.project);
        if (group === undefined) groups.push({ project: item.project, items: [item] });
        else group.items.push(item);
    }
    return { total: items.length, staleDays: days, groups };
}

/**
 * Mark stale holds the digest has not yet re-surfaced and return their ids, so each stale hold is raised once.
 * Re-holding a task clears the mark.
 */
export function takeStaleHolds(needs: Needs): Set<string> {
    const due = new Set(
        needs.groups.flatMap((group) =>
            group.items.filter((item) => item.stale && !item.staleSurfaced).map((item) => item.id),
        ),
    );
    if (due.size === 0) return due;
    const stamp = now().toISOString();
    updateBacklog((backlog) => {
        for (const task of backlog.tasks) {
            if (due.has(task.id) && task.status === "held") task.staleSurfacedAt = stamp;
        }
    });
    return due;
}

function itemLines(item: NeedItem, resurface: ReadonlySet<string>): string[] {
    const facts = [`held ${item.ageDays}d`];
    if (item.blocks !== null) facts.push(`blocks: ${item.blocks}`);
    if (item.question === null)
        return [
            `    ${item.id} ${item.title} (${facts.join("; ")})`,
            `      BUG: held with no question; ask its jawan or re-hold: bin/toli task hold ${item.id} --question "..." --option "<choice> => <then>"`,
        ];
    const lines = [`    ${item.id} ${item.title}: ${item.question} (${facts.join("; ")})`];
    item.options.forEach((option, index) => {
        const mark = option.choice === item.recommend ? " (recommended)" : "";
        lines.push(`      ${index + 1}. ${option.choice} => ${option.outcome}${mark}`);
    });
    if (item.options.length === 0 && item.recommend !== null) lines.push(`      recommended: ${item.recommend}`);
    if (resurface.has(item.id))
        lines.push(
            `      STALE: unanswered ${item.ageDays}d; ask once more, or drop it: bin/toli task drop ${item.id}`,
        );
    lines.push(`      reply ${item.reply}`);
    return lines;
}

/** `Needs you (N):` and its lines, as `bin/toli needs` and the top of the digest print them. */
export function renderNeeds(needs: Needs, resurface: ReadonlySet<string> = new Set()): string[] {
    if (needs.total === 0) return ["Needs you (0):", "  nothing is waiting on the user"];
    const lines = [`Needs you (${needs.total}):`];
    for (const group of needs.groups) {
        lines.push(`  ${group.project}:`);
        for (const item of group.items) lines.push(...itemLines(item, resurface));
    }
    lines.push(`  record each reply verbatim: bin/toli task answer T<n> "<the user's words>", then dispatch it`);
    return lines;
}

/** `toli needs [--json]`: the Needs-you queue. Read-only. */
export function needsCommand(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const needs = needsQueue(loadBacklog().tasks);
    if (args.bool("json")) {
        printJson(needs);
        return;
    }
    const stale = new Set(
        needs.groups.flatMap((group) => group.items.filter((item) => item.stale).map((item) => item.id)),
    );
    out(renderNeeds(needs, stale).join("\n"));
}
