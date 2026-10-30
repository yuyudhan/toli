// `bin/toli setup status|notice|snooze|seed-local`: the setup checklist (src/setup/checklist.ts) and the told-once
// notice. `status` always reports every item. `notice` is what session start shows (the digest header, the omp
// extension, the Claude Code SessionStart hook): one line, only on the first run or when a step is missing that was
// not missing the last time the notice was shown or snoozed. state/setup-shown.json remembers that set.
import { createHash } from "node:crypto";
import { Args } from "../core/args.ts";
import { paths } from "../core/paths.ts";
import { now, out, printJson, readJson, ToliError, writeJsonAtomic } from "../core/util.ts";
import { seedLocal } from "../helpers/local.ts";
import { setupRemaining } from "../records/next.ts";
import { pendingIds, type SetupItem, setupChecklist } from "./checklist.ts";

/** state/setup-shown.json: the pending set the user was last told about (or snoozed). */
export type SetupMarker = { pending: string[]; hash: string; at: string; snoozed: boolean };

function hashOf(pending: readonly string[]): string {
    return createHash("sha256").update(pending.join("\n")).digest("hex").slice(0, 16);
}

export function readMarker(): SetupMarker | null {
    const raw = readJson<Partial<SetupMarker> | null>(paths.setupShown(), null);
    if (raw === null || !Array.isArray(raw.pending)) return null;
    return {
        pending: raw.pending.filter((id): id is string => typeof id === "string"),
        hash: typeof raw.hash === "string" ? raw.hash : "",
        at: typeof raw.at === "string" ? raw.at : "",
        snoozed: raw.snoozed === true,
    };
}

function writeMarker(pending: readonly string[], snoozed: boolean): void {
    writeJsonAtomic(paths.setupShown(), {
        pending: [...pending],
        hash: hashOf(pending),
        at: now().toISOString(),
        snoozed,
    } satisfies SetupMarker);
}

/** Whether the notice is due: something is missing and (first run, or an item missing that the marker lacks). */
export function noticeDue(pending: readonly string[], marker: SetupMarker | null): boolean {
    if (pending.length === 0) return false;
    if (marker === null) return true;
    return pending.some((id) => !marker.pending.includes(id));
}

/** Whether the user snoozed setup and nothing new has gone missing since (which would wake the notice again). */
export function setupSnoozed(items: SetupItem[]): boolean {
    const marker = readMarker();
    return marker?.snoozed === true && !noticeDue(pendingIds(items), marker);
}

export function noticeText(remaining: number): string {
    return `${setupRemaining(remaining)} - say "set up toli" (bin/toli setup status lists them)`;
}

/**
 * The told-once notice: the line to show now, or null. Records the current pending set whenever it changed, so a
 * finished step never re-triggers the notice and only a newly missing step does.
 */
export function takeSetupNotice(items: SetupItem[] = setupChecklist()): string | null {
    const pending = pendingIds(items);
    const marker = readMarker();
    const due = noticeDue(pending, marker);
    if (due || marker === null || marker.hash !== hashOf(pending))
        writeMarker(pending, !due && (marker?.snoozed ?? false));
    return due ? noticeText(pending.length) : null;
}

/** The context a lead session gets with the notice: tell the user once, then carry on. */
export function leadNoticeContext(notice: string): string {
    return `[toli setup] Tell the user this once, in one line at the start of your next reply, then carry on: ${notice}. When they say "set up toli", load the toli-setup skill.`;
}

const STATUS_WIDTH = 8;

function renderStatus(items: SetupItem[], marker: SetupMarker | null): string {
    const pending = items.filter((item) => item.status === "missing");
    const optional = items.filter((item) => item.status === "optional");
    const lines = [
        pending.length === 0
            ? `toli setup: complete${optional.length > 0 ? ` (${optional.length} optional step${optional.length === 1 ? "" : "s"} offered)` : ""}`
            : `toli setup: ${pending.length} of ${items.length} steps remain${optional.length > 0 ? `, ${optional.length} optional` : ""} - say "set up toli"`,
        "",
    ];
    for (const item of items) {
        lines.push(`${item.status.padEnd(STATUS_WIDTH)} ${item.id} - ${item.title}: ${item.detail}`);
        if (item.status !== "done") lines.push(`${" ".repeat(STATUS_WIDTH)}   ${item.who}: ${item.fix}`);
    }
    lines.push(
        "",
        marker === null
            ? "notice: not shown yet (session start shows it once)"
            : `notice: last ${marker.snoozed ? "snoozed" : "shown or updated"} ${marker.at} for ${marker.pending.length === 0 ? "nothing pending" : marker.pending.join(", ")}`,
    );
    return lines.join("\n");
}

function snooze(): void {
    const pending = pendingIds(setupChecklist());
    writeMarker(pending, true);
    out(
        pending.length === 0
            ? "nothing pending; the notice stays quiet until a step goes missing"
            : `snoozed: ${pending.length} pending (${pending.join(", ")}); session start stays quiet until a new step is missing`,
    );
}

export function setupCommand(argv: string[]): void {
    const [sub, ...rest] = argv;
    switch (sub) {
        case "status": {
            const args = new Args(rest, { booleans: ["json"] });
            args.maxPositional(0);
            const items = setupChecklist();
            const marker = readMarker();
            if (args.bool("json")) printJson({ remaining: pendingIds(items).length, items, notice: marker });
            else out(renderStatus(items, marker));
            return;
        }
        case "notice": {
            const args = new Args(rest, { booleans: ["json"] });
            args.maxPositional(0);
            const notice = takeSetupNotice();
            if (args.bool("json"))
                printJson({ notice: notice ?? "", context: notice === null ? "" : leadNoticeContext(notice) });
            else if (notice !== null) out(notice);
            return;
        }
        case "snooze":
            new Args(rest).maxPositional(0);
            snooze();
            return;
        case "seed-local":
            new Args(rest).maxPositional(0);
            seedLocal();
            out("local/ seeded (scripts/, hooks/, helpers.json, README.md); existing files left untouched");
            return;
        default:
            throw new ToliError("usage: toli setup status [--json] | notice [--json] | snooze | seed-local");
    }
}
