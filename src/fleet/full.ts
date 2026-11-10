// `bin/toli lead full`: this machine's lead says it takes no more work (docs/sardars.md "Queues decide where work
// goes"). While full, `pick`, `fleet queues` and the other leads' balancing offers pass it over, whatever its queue;
// it may still offer its own queued work away. The mark is state/lead/full.json; it ends at `--until`, or on `--clear`.
import { rmSync } from "node:fs";
import { Args } from "../core/args.ts";
import { paths } from "../core/paths.ts";
import { now, out, printJson, readJson, ToliError, writeJsonAtomic } from "../core/util.ts";

/** Why this machine takes no more work, since when, and until when (null: until `lead full --clear`). */
export type Full = { reason: string; since: string; until: string | null };

/** How long `task handback --full` marks this machine full. */
export const HANDBACK_FULL_MINUTES = 120;

/** The current mark, or null when there is none or it has run out. */
export function currentFull(): Full | null {
    const full = readJson<Full | null>(paths.leadFull(), null);
    if (full === null || typeof full.reason !== "string") return null;
    if (full.until !== null && Date.parse(full.until) <= now().getTime()) return null;
    return full;
}

/** Mark this machine full for `minutes` (null: until cleared). */
export function setFull(reason: string, minutes: number | null): Full {
    const at = now();
    const full: Full = {
        reason,
        since: at.toISOString(),
        until: minutes === null ? null : new Date(at.getTime() + minutes * 60_000).toISOString(),
    };
    writeJsonAtomic(paths.leadFull(), full);
    return full;
}

/** `30m`, `2h`, or an ISO time: when the mark ends. Returns minutes from now. */
function parseUntil(value: string): number {
    const relative = /^(\d+)([mh])$/.exec(value.trim());
    if (relative) {
        const amount = Number(relative[1]);
        if (amount < 1) throw new ToliError("--until must be in the future");
        return relative[2] === "h" ? amount * 60 : amount;
    }
    const at = Date.parse(value);
    if (Number.isNaN(at)) throw new ToliError('--until takes "30m", "2h" or an ISO time');
    const minutes = (at - now().getTime()) / 60_000;
    if (minutes <= 0) throw new ToliError("--until must be in the future");
    return minutes;
}

/** `bin/toli full` text: `full: <reason> (until <time>)`, or that the machine takes work. */
export function fullText(full: Full | null): string {
    if (full === null) return "not full: this machine takes work";
    return `full: ${full.reason} (${full.until === null ? "until lead full --clear" : `until ${full.until}`})`;
}

/** `lead full [--reason "..."] [--until 30m|2h|<ISO time>] | --clear | --status [--json]`. */
export function fullCommand(argv: string[]): void {
    const args = new Args(argv, { values: ["reason", "until"], booleans: ["clear", "status", "json"] });
    args.maxPositional(0);
    if (args.bool("clear")) {
        rmSync(paths.leadFull(), { force: true });
        out("not full: this machine takes work again");
        return;
    }
    if (args.bool("status")) {
        const full = currentFull();
        if (args.bool("json")) printJson(full);
        else out(fullText(full));
        return;
    }
    const until = args.str("until");
    const full = setFull(
        args.str("reason")?.trim() || "no more work for now",
        until === undefined ? null : parseUntil(until),
    );
    out(`${fullText(full)}; pick, fleet queues and the other leads' offers pass this machine over`);
}
