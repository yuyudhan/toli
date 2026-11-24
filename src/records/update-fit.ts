// A delegated task's update within the peer body limit (src/peer/envelope.ts `bodyLimit`): a task with hundreds of
// notes (a fan-out campaign's `--for` task) would otherwise be refused by its delegator on every change, and the
// delegator would lose its status for good. Past the limit only the latest notes that fit travel, and `notesSkipped`
// counts the earlier ones left out; the delegator (src/records/delegation-sync.ts) copies notes by their place in the
// owner's whole list, so none is copied twice, and marks the ones it never got.
import { bodyLimit } from "../peer/envelope.ts";
import type { DelegationUpdate } from "./delegation-report.ts";

/**
 * `update` as it fits the update body limit as JSON. An update already fitted (raise-holds adds fields after) is
 * fitted again from the notes it carries, its `notesSkipped` growing by those it drops.
 */
export function fitUpdate(update: DelegationUpdate): DelegationUpdate {
    const limit = bodyLimit("update");
    if (Buffer.byteLength(JSON.stringify(update)) <= limit) return update;
    const { notes } = update.task;
    const skipped = update.notesSkipped ?? 0;
    // The update without notes, at the largest skipped count it can have; each kept note adds its JSON and a comma.
    const empty = { ...update, task: { ...update.task, notes: [] }, notesSkipped: skipped + notes.length };
    let size = Buffer.byteLength(JSON.stringify(empty));
    let keep = 0;
    for (let index = notes.length - 1; index >= 0; index -= 1) {
        const note = notes[index];
        if (note === undefined) break;
        const cost = Buffer.byteLength(JSON.stringify(note)) + 1;
        if (size + cost > limit) break;
        size += cost;
        keep += 1;
    }
    return {
        ...update,
        task: { ...update.task, notes: notes.slice(notes.length - keep) },
        notesSkipped: skipped + notes.length - keep,
    };
}
