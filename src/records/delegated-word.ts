// A delegated task's question for the user (docs/sardars.md "Questions for the user"): `task escalate` holds the
// `--for` task with it by hand, and `delegation update` does the same on arrival for a held question that asks for the
// user's word (word-holds.ts asksForWord), once per question, so it never waits in the inbox for the lead to escalate.
// A worker's own hold raised to its coordinator (`forUser`, src/records/raise-holds.ts) is the user's question by
// definition and is held the same way. A task held only to carry such a question is closed once the owner's task no
// longer asks it (answered on either machine, dropped, or asking something else).
import { now, ToliError } from "../core/util.ts";
import { loadBacklog, type Task, updateTask } from "./backlog.ts";
import type { DelegationUpdate } from "./delegation-report.ts";
import { asksForWord, heldTask, holdOnce, senderProject } from "./word-holds.ts";

/** Hold task `id` with delegated task `fid`'s open question, which it mirrors (`task escalate`); returns the task. */
export function escalateHold(id: string, fid: string): Task {
    return updateTask(id, (entry) => {
        const state = entry.delegates?.[fid];
        if (state?.status !== "held")
            throw new ToliError(`${fid} has no open question here (bin/toli task list --fleet)`);
        entry.status = "held";
        entry.question = `${fid} asks: ${state.question ?? ""}`;
        if (state.options?.length) entry.options = state.options;
        else delete entry.options;
        if (state.recommend !== undefined) entry.recommend = state.recommend;
        else delete entry.recommend;
        if (state.blocks !== undefined) entry.blocks = state.blocks;
        else delete entry.blocks;
        entry.heldAt = now().toISOString();
        entry.heldFrom = fid;
        delete entry.answer;
        delete entry.staleSurfacedAt;
    });
}

/**
 * A delegated task's held question that asks for the user's word goes into the Needs-you queue at once, once per
 * question: as `task escalate` would hold the `--for` task (when it is queued, active, or already held for this
 * delegation), else as a new held task in its project (the `--for` task's, else the owner's). A worker's raised hold
 * (`forUser`) always does, as a new held task in the owner's project. Either way the user's answer goes to the owner
 * too (`heldFrom`). Returns what happened, or null when the update asks nothing of the user.
 */
export function holdDelegatedWord(update: DelegationUpdate, fid: string, local: Task | undefined): string | null {
    const { status, question, options, recommend, blocks, title } = update.task;
    if (status !== "held" || question === undefined) return null;
    const offered = (options ?? []).map((option) => `${option.choice} => ${option.outcome}`);
    if (
        update.forUser !== true &&
        !asksForWord([question, ...offered, recommend ?? "", blocks ?? ""].join("\n"), false)
    )
        return null;
    const current = local === undefined ? undefined : loadBacklog().tasks.find((task) => task.id === local.id);
    const open = current?.status === "queued" || current?.status === "active" || current?.heldFrom === fid;
    const escalateId = current?.delegates?.[fid]?.status === "held" && open ? current.id : null;
    const project =
        update.project ?? current?.project ?? senderProject(update.owner, `${title}\n${question}`, loadBacklog().tasks);
    const word = {
        question: `${fid} asks: ${question}`,
        options: options ?? [],
        ...(recommend === undefined ? {} : { recommend }),
        ...(blocks === undefined ? {} : { blocks }),
    };
    const note = `held from ${fid}'s question: the user's answer (task answer) goes to ${update.owner} too`;
    const hold =
        escalateId !== null
            ? () => escalateHold(escalateId, fid)
            : project !== null
              ? () => heldTask(project, `${fid} asks for the user's word: ${title}`, word, note, fid)
              : null;
    if (hold === null)
        return `${fid} asks for the user's word, but no project here matches it: bin/toli task answer ${fid} "<answer>" when he answers`;
    const task = holdOnce(update.owner, question, fid, hold);
    return task === null
        ? `${fid}'s question is already held (or answered) here`
        : `${task.id} held for the user's word: ${fid} asks (bin/toli needs)`;
}

/**
 * Close the tasks held here only to carry `fid`'s question (a new held task with `heldFrom`, never a `--for` task,
 * which records the delegation and is released by its write-back) once the owner's update no longer asks it: done
 * when the owner answered it or moved on, dropped when it dropped the task. Returns one line per task closed.
 */
export function releaseHeldWord(update: DelegationUpdate, fid: string): string[] {
    const { status, question } = update.task;
    const asked = status === "held" && question !== undefined ? `${fid} asks: ${question}` : null;
    const closed = status === "dropped" ? "dropped" : "done";
    const lines: string[] = [];
    for (const carrier of loadBacklog().tasks) {
        if (carrier.status !== "held" || carrier.heldFrom !== fid || carrier.delegates?.[fid] !== undefined) continue;
        if (carrier.question === asked) continue;
        updateTask(carrier.id, (entry) => {
            if (entry.status !== "held" || entry.heldFrom !== fid) return;
            entry.status = closed;
            if (closed === "done") entry.doneAt = now().toISOString();
            delete entry.heldFrom;
            entry.notes.push(
                status === "held"
                    ? `${fid} asks another question now; this one no longer waits here`
                    : `${fid} is ${status}: its question no longer waits here`,
            );
        });
        lines.push(`${carrier.id} ${closed}: ${fid} no longer asks its question`);
    }
    return lines;
}
