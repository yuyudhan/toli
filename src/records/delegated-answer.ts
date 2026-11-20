// Answers to a delegated task's question (docs/sardars.md "Results and questions go back"). On the delegator, `task
// answer <owner>/T<n>` sends one `answer` outbox item per question: none once the owner reported the task done or
// dropped, none a second time before the owner reports again, and one still queued is cancelled when that report
// lands. On the owner, `task answer T<n> --from <delegator>` records it: a late one (the task is no longer held) is a
// note and a wake, and a copy of one already applied (`--answer-id`, a retried delivery) is dropped (T2151).
import { Args } from "../core/args.ts";
import { fleetMachine, loadMachine } from "../core/config.ts";
import { now, out, requireName, stamp, ToliError, warn } from "../core/util.ts";
import { type AnswerBody, parseAnswer, queuedText, sendNow } from "../jobs/outbox.ts";
import { cancelItems } from "../jobs/outbox-admin.ts";
import { queuedItems } from "../jobs/outbox-queue.ts";
import { loadBacklog, type Task, updateTask } from "./backlog.ts";
import { type DelegationUpdate, delegators, fleetId, splitFleetId } from "./delegation-report.ts";
import { matchOption } from "./hold-options.ts";
import { addInboxItem } from "./inbox.ts";

/**
 * `task answer <id> --from <machine>`: another machine's lead answers only a task it delegated here, or one forwarded
 * here from work it delegated (`upstream`); it never speaks for the user here, and never releases this machine's own
 * holds.
 */
export function requireDelegator(task: Task, from: string): void {
    requireName("machine", from);
    const by = task.delegatedBy?.machine;
    if (delegators(task.delegatedBy).includes(from)) return;
    throw new ToliError(
        by === undefined
            ? `${task.id} was not delegated here: only this machine's lead or user answers it, not ${from}`
            : `${task.id} was delegated by ${by}, not ${from}: only it may answer`,
    );
}

/**
 * `task answer` for a task that is not held: false when it is held (answer it as usual). This machine's own answer is
 * refused. The delegator's (`--from`) is never refused or dropped (T1382): when this machine took the hold up again
 * before the answer arrived, it becomes a note on the task and an inbox item that wakes this lead, like a message
 * about the task, so its jawan still hears it.
 */
export function noteLateAnswer(task: Task, from: string | undefined, reply: string): boolean {
    if (task.status === "held") return false;
    if (from === undefined) throw new ToliError(`${task.id} is ${task.status}, not waiting on an answer`);
    requireDelegator(task, from);
    const chosen = matchOption(task.options ?? [], reply);
    const answer = `Q: ${task.question ?? ""}\nA: ${reply}${chosen ? ` (= ${chosen.choice})` : ""}`;
    task.notes.push(`answer from ${from}'s lead while ${task.id} is ${task.status}: ${answer}`);
    addInboxItem(
        from,
        `answer from ${from} for ${task.id} (${task.status})`,
        [
            `${from}'s lead answered ${task.id}'s question after this machine took it up again: ${task.id} is ${task.status}, so the answer did not release it. It is a note on the task now.`,
            "",
            answer,
            "",
            `Pass it to the jawan working on ${task.id}, or put it in its next brief (bin/toli task list).`,
        ].join("\n"),
    );
    out(`${task.id} is ${task.status}: the answer from ${from} is noted on it and its lead woken`);
    return true;
}

/**
 * Why an answer for delegated task `fid` sends nothing: its owner reported it done or dropped, or this machine already
 * answered its current question and the owner has not reported since (a second copy would only arrive as a
 * duplicate). Null when an answer may go. A task the owner takes up again reports a new state, which lifts both.
 */
export function answerRefusal(fid: string): string | null {
    const owner = splitFleetId(fid).machine ?? "";
    for (const task of loadBacklog().tasks) {
        const state = task.delegates?.[fid];
        if (state === undefined) continue;
        if (state.status === "done" || state.status === "dropped")
            return `${fid} is ${state.status} on ${owner} (its report says so): no answer is sent`;
        if (state.status === "held" && state.answered !== undefined)
            return `${fid}'s question is already answered from here (${state.answered.id}, ${state.answered.at}); ${owner} has not reported since, so another answer would only arrive as a duplicate: wait for its update, or bin/toli talk ${owner} "<words>"`;
    }
    return null;
}

/** Record (or, with undefined, clear) this machine's answer to `fid`'s open question on the task that mirrors it. */
function noteAnswered(fid: string, answered: { id: string; at: string } | undefined): void {
    const local = loadBacklog().tasks.find((task) => task.delegates?.[fid]?.status === "held");
    if (local === undefined) return;
    updateTask(local.id, (task) => {
        const state = task.delegates?.[fid];
        if (state?.status !== "held") return;
        if (answered === undefined) delete state.answered;
        else state.answered = answered;
    });
}

/**
 * `task answer <machine>/T<n> "<answer>"` for another machine's task: the owner records it (rule 2). It travels as
 * an `answer` outbox item, over HTTPS to a paired peer or ssh otherwise; an owner that cannot be reached now gets it
 * when it is back (or with its next pull). The item's id travels in its body, so the owner applies it once however
 * often it is delivered; answerRefusal keeps this machine from sending a second one.
 */
export function forwardAnswer(owner: string, argv: string[]): void {
    const args = new Args(argv);
    args.maxPositional(2);
    const id = splitFleetId(args.pos(0, "id")).id;
    const reply = args.pos(1, "answer");
    const target = fleetMachine(owner);
    const self = loadMachine().name;
    const fid = fleetId(owner, id);
    const refusal = answerRefusal(fid);
    if (refusal !== null) throw new ToliError(refusal);
    const answerId = `answer-${id}-${self}-${stamp()}`;
    const body = JSON.stringify({ id, answer: reply, answerId } satisfies AnswerBody);
    // Recorded before the send: the owner's report that the answer released the task may land during it.
    noteAnswered(fid, { id: answerId, at: now().toISOString() });
    const sent = sendNow(self, target, "answer", `answer ${fid}`, body, answerId);
    if (sent.delivered) {
        out(`${owner} recorded the answer for ${fid}:`);
        out(sent.stdout.trimEnd());
        return;
    }
    if (sent.refused !== undefined) noteAnswered(fid, undefined);
    if (!sent.pulled) warn(sent.error);
    out(`answer for ${fid} ${queuedText(owner, sent)}`);
}

/**
 * After `task answer` released an escalated hold here, the same answer goes to the delegated task's owner, unless the
 * owner already reported that task done or dropped, or has this machine's answer (answerRefusal).
 */
export function forwardEscalatedAnswer(heldFrom: string | undefined, reply: string): void {
    if (heldFrom === undefined) return;
    const refusal = answerRefusal(heldFrom);
    if (refusal !== null) {
        out(`recorded here only: ${refusal}`);
        return;
    }
    const { machine, id } = splitFleetId(heldFrom);
    try {
        forwardAnswer(machine ?? "", [id, reply]);
    } catch (error) {
        throw new ToliError(
            `recorded here, but not on ${machine}: ${error instanceof Error ? error.message : String(error)}; retry with bin/toli task answer ${heldFrom} "<answer>"`,
        );
    }
}

/**
 * The owner reported delegated task `fid` done or dropped (`delegation update`): an answer to it still queued here is
 * not needed, so it is cancelled (kept in state/outbox/cancelled/) rather than delivered after the fact.
 */
export function cancelAnswers(update: DelegationUpdate, fid: string): void {
    const { status } = update.task;
    if (status !== "done" && status !== "dropped") return;
    const files = queuedItems()
        .filter(
            ({ item }) =>
                item.kind === "answer" && item.to?.name === update.owner && parseAnswer(item.body).id === update.id,
        )
        .map(({ file }) => file);
    if (files.length > 0) cancelItems(files, `${fid} is ${status} on ${update.owner}: its answer is not needed`);
}
