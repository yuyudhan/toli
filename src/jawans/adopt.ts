// Every jawan reports to its own machine's lead (docs/sardars.md). A `bin/toli spawn` run posts its outcome itself;
// a run that ends without posting one (a `bin/toli exec` run another machine's `remote` started before the cutover)
// is adopted: the minute tick posts its outcome to this machine's inbox, once, so this machine's lead hears of it.
import { existsSync, readFileSync } from "node:fs";
import { loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, readJson, withLock, writeJsonAtomic } from "../core/util.ts";
import { addInboxItem } from "../records/inbox.ts";
import { ACTIVE, listRuns, updateRun } from "./runs.ts";
import { outcomeMessage } from "./supervise.ts";

/** A run's own supervisor posts within seconds of the end; past this the run had none that will. */
const GRACE_MS = 2 * 60 * 1000;
const OUTPUT_TAIL = 4000;

function adoptSince(): string {
    return withLock(paths.lock("adopt-runs"), () => {
        const state = readJson<{ since?: string }>(paths.leadAdoptState(), {});
        if (state.since !== undefined) return state.since;
        const since = now().toISOString();
        writeJsonAtomic(paths.leadAdoptState(), { since });
        return since;
    });
}

function tail(path: string): string {
    if (!existsSync(path)) return "";
    const text = readFileSync(path, "utf8").trimEnd();
    return text.length <= OUTPUT_TAIL ? text : text.slice(-OUTPUT_TAIL);
}

/**
 * Post the outcome of every run that ended after toli first looked (so old history never floods the inbox), more
 * than the grace period ago, without an outcome posted. Returns one note per run posted.
 */
export function reportUnpostedRuns(): string[] {
    const since = adoptSince();
    const cutoff = now().getTime() - GRACE_MS;
    const machine = loadMachine().name;
    const notes: string[] = [];
    for (const run of listRuns()) {
        if (ACTIVE.includes(run.status) || run.inbox !== null || run.endedAt === null) continue;
        if (run.endedAt < since || Date.parse(run.endedAt) > cutoff) continue;
        let posted = false;
        updateRun(run.id, (record) => {
            if (record.inbox !== null) return;
            const { title, body } = outcomeMessage(record, tail(record.logPath));
            record.inbox = addInboxItem(machine, title, body);
            posted = true;
        });
        if (posted) notes.push(`jawan ${run.id}: outcome posted to this machine's inbox (adopted run)`);
    }
    return notes;
}
