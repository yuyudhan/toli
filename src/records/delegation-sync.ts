// Write-back of delegated tasks (docs/sardars.md): the delegating machine's `--for` task follows the delegated task
// its owner reports (src/records/delegation-report.ts). `delegation update` applies one report here: the owner's new
// notes are copied, the task's state is recorded under `delegates`, and once every delegation is done (or dropped)
// the `--for` task is too, with the commit and report. A slice (a delegation made while the `--for` task's own jawan
// works on it) only adds its notes, commit and report. A question stays with this machine's lead, who answers it
// (`task answer <owner>/T<n>`) or, when only the user can decide, `task escalate`s it into the Needs-you queue; one
// that asks for the user's word in so many words is held there on arrival (delegated-word.ts), and so is a worker's own
// hold raised to its coordinator (`forUser`, src/records/raise-holds.ts); either is released once the owner's task is
// no longer held with that question.
// `task link` attaches a delegation made without `--for`. Repeats are skipped by the owner's `updatedAt`. Work a
// delegated task forwards on (its own `delegatedTo`, sent as `forwardedTo`) joins the `--for` task's delegations, so
// the originator follows the live owner, which reports here directly through its `upstream` chain.
import { join, relative } from "node:path";
import { Args } from "../core/args.ts";
import { otherFleetMachines } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import {
    isValidName,
    now,
    out,
    readJson,
    requireName,
    ToliError,
    withLock,
    writeJsonAtomic,
    writeTextAtomic,
} from "../core/util.ts";
import { fullText, HANDBACK_FULL_MINUTES, setFull } from "../fleet/full.ts";
import { cancelQueuedRunsOf, loadBacklog, type Task, updateTask } from "./backlog.ts";
import { cancelAnswers } from "./delegated-answer.ts";
import { escalateHold, holdDelegatedWord, releaseHeldWord } from "./delegated-word.ts";
import { linkTaskCommand } from "./delegation-link.ts";
import {
    type DelegateState,
    type DelegationUpdate,
    fleetId,
    landSending,
    REPORTED,
    splitFleetId,
    type Upstream,
} from "./delegation-report.ts";
import { addInboxItem } from "./inbox.ts";
import { delegateWait, rewait, sliceOpen } from "./slice-wait.ts";
import { waitsForSlot } from "./slot-wait.ts";

/** The last update seen per fleet id (state/delegates.json): decides once whether an update wakes this lead. */
type SeenFile = Record<string, { updatedAt: string; status: string; question?: string }>;

export function parseJson<T>(text: string, what: string): T {
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new ToliError(`${what}: the body is not JSON`);
    }
}

/** The `--for` task an update belongs to: the one it names, else the one that lists its fleet id. */
function localTaskFor(update: DelegationUpdate, id: string): Task | undefined {
    const tasks = loadBacklog().tasks;
    const named = update.forTask === undefined ? undefined : tasks.find((task) => task.id === update.forTask);
    return named ?? tasks.find((task) => task.delegatedTo?.includes(id) || task.slices?.includes(id));
}

/** Where a delegated task's report is kept on this machine, relative to the root. */
function saveReport(id: string, text: string): string {
    const path = join(paths.root(), "data", "reports", "delegated", `${id.replace("/", "-")}.md`);
    writeTextAtomic(path, `${text}\n`);
    return relative(paths.root(), path);
}

/** Copy one update onto the `--for` task; false when it is a repeat of what the task already has. */
function mirror(local: Task, id: string, update: DelegationUpdate): boolean {
    let applied = false;
    updateTask(local.id, (task) => {
        const seen = task.delegates?.[id];
        if (seen !== undefined && seen.updatedAt >= update.task.updatedAt) return;
        applied = true;
        const { status, updatedAt, notes, question, options, recommend, blocks, commit, handedBack } = update.task;
        const slice = task.slices?.includes(id) === true;
        if (!slice && !task.delegatedTo?.includes(id)) task.delegatedTo = [...(task.delegatedTo ?? []), id];
        if (update.delegation !== undefined) landSending(task, update.owner, update.delegation);
        for (const note of notes.slice(seen?.notes ?? 0))
            if (!note.startsWith("delegated by ")) task.notes.push(`${id}: ${note}`);
        const onward = slice ? [] : (update.forwardedTo ?? []).filter((entry) => entry !== id);
        for (const entry of onward.filter((fid) => !task.delegatedTo?.includes(fid))) {
            task.delegatedTo = [...(task.delegatedTo ?? []), entry];
            task.notes.push(`${id} forwarded the work to ${entry}`);
            workOnBy(task, entry);
        }
        if (handedBack !== undefined && seen?.handedBack === undefined)
            task.notes.push(`${id} handed the work back: ${handedBack}`);
        else if (seen?.status !== status)
            task.notes.push(
                status === "dropped" && onward.length > 0
                    ? `${id} is forwarded to ${onward.join(", ")}`
                    : `${id} is ${status}`,
            );
        const state: DelegateState = { status, updatedAt, notes: notes.length };
        if (status === "held") Object.assign(state, { question, options, recommend, blocks });
        // The same open question again (a note added while it waits): this machine's answer to it still stands.
        if (status === "held" && seen?.status === "held" && seen.question === question && seen.answered)
            state.answered = seen.answered;
        if (commit !== undefined) state.commit = commit;
        if (handedBack !== undefined) state.handedBack = handedBack;
        if (onward.length > 0 || seen?.forwarded === true) state.forwarded = true;
        task.delegates = { ...task.delegates, [id]: state };
        if (status === "done" && update.report !== null) {
            const report = saveReport(id, update.report);
            if (slice) task.notes.push(`${id} report: ${report}`);
            else task.report = report;
        }
        if (slice && status === "done" && commit !== undefined && seen?.commit !== commit)
            task.notes.push(`${id} commit: ${commit}`);
        settle(task, id, status, commit, slice);
        if (slice) rewait(task);
    });
    return applied;
}

/**
 * The `--for` task's own status after a delegate's change: done when a delegation finishes and every other one not
 * dropped is done too, dropped when all are dropped, queued again (for another Sardar or this one) when every
 * delegation was handed back, or when one is handed back and the rest are done or dropped. A dropped delegation never
 * closes the task: with the rest done, the task stays as it is for its lead (T1976). A delegation dropped after
 * forwarding the work on counts only through the delegations it forwarded to, so when those are handed back the task
 * is queued again, never dropped. A slice only releases the hold it escalated; the task's own jawan decides the rest.
 */
function settle(
    task: Task,
    id: string,
    status: DelegateState["status"],
    commit: string | undefined,
    slice: boolean,
): void {
    if (task.status === "held" && task.heldFrom === id && status !== "held") {
        task.status = "active";
        delete task.heldFrom;
        task.notes.push(`${id} no longer waits on the escalated question`);
    }
    if (slice || (task.status !== "queued" && task.status !== "active")) return;
    const live = (task.delegatedTo ?? []).filter((entry) => {
        const state = task.delegates?.[entry];
        return state?.handedBack === undefined && !(state?.status === "dropped" && state.forwarded === true);
    });
    const open = live
        .map((entry) => task.delegates?.[entry]?.status ?? "active")
        .filter((entry) => entry !== "dropped");
    const finished = open.every((entry) => entry === "done");
    if (live.length === 0 || (finished && task.delegates?.[id]?.handedBack !== undefined)) {
        task.status = "queued";
        delete task.agent;
        delete task.dispatchedAt;
    } else if (open.length === 0) task.status = "dropped";
    else if (finished) {
        if (status !== "done") return;
        task.status = "done";
        task.doneAt = now().toISOString();
        if (commit !== undefined) task.commit = commit;
        delete task.waitingOn;
    } else task.status = "active";
}

/** Record that this update was seen; returns whether it is a new outcome to wake this lead for. */
function claimWake(id: string, update: DelegationUpdate): boolean {
    return withLock(paths.lock("delegates"), () => {
        const seen = readJson<SeenFile>(paths.delegatesSeen(), {});
        const before = seen[id];
        if (before !== undefined && before.updatedAt >= update.task.updatedAt) return false;
        const { status, updatedAt, question } = update.task;
        seen[id] = { updatedAt, status, ...(question === undefined ? {} : { question }) };
        writeJsonAtomic(paths.delegatesSeen(), seen);
        if (!REPORTED.includes(status)) return false;
        return before?.status !== status || (status === "held" && before.question !== question);
    });
}

/** `delegation update` (update JSON on stdin): what the owner of a delegated task runs here over ssh. */
export function applyUpdate(update: DelegationUpdate): string {
    const id = fleetId(update.owner, update.id);
    const local = update.forUser === true ? undefined : localTaskFor(update, id);
    const applied = local !== undefined && mirror(local, id, update);
    if (applied) cancelAnswers(update, id);
    // Only an update newer than the last one seen may close a carried question; an older one arriving late must not.
    const seen = readJson<SeenFile>(paths.delegatesSeen(), {})[id];
    const released = seen !== undefined && seen.updatedAt >= update.task.updatedAt ? [] : releaseHeldWord(update, id);
    const word = holdDelegatedWord(update, id, local);
    if (claimWake(id, update)) {
        const after = local === undefined ? undefined : loadBacklog().tasks.find((task) => task.id === local.id);
        const yours = after === undefined ? [] : ["", `Your task ${after.id} is ${after.status} (bin/toli task list).`];
        const held = word === null ? [] : ["", word];
        addInboxItem(update.owner, update.message.title, [update.message.body, ...yours, ...held].join("\n"));
    }
    const line = `delegation-updated ${id}${local === undefined ? "" : ` ${local.id}${applied ? "" : " (already recorded)"}`}`;
    return [line, ...released, ...(word === null ? [] : [word])].join("\n");
}

/** `task escalate <machine>/T<n>`: a delegated task's question needs the user; hold the `--for` task with it. */
function escalate(argv: string[]): void {
    const args = new Args(argv);
    args.maxPositional(1);
    const { machine, id } = splitFleetId(args.pos(0, "fleet id"));
    if (machine === null) throw new ToliError("task escalate needs a delegated task's fleet id: <machine>/T<n>");
    const fid = fleetId(machine, id);
    const local = loadBacklog().tasks.find((task) => task.delegates?.[fid] !== undefined);
    if (local === undefined || local.delegates?.[fid]?.status !== "held")
        throw new ToliError(`${fid} has no open question here (bin/toli task list --fleet)`);
    const task = escalateHold(local.id, fid);
    out(`${task.id}\theld\t${task.title}\t(question: ${task.question})`);
    out(
        `in the Needs-you queue; the user's answer (bin/toli task answer ${task.id} "<answer>") goes to ${machine} too`,
    );
}

/**
 * Whether the task's own jawan works on it: active or held with an agent that is not one of its delegations. A
 * delegation made then is a slice of that work. A task parked for a free slot here (src/records/slot-wait.ts) has no
 * own jawan, whatever agent it still names: a delegation of it (a taken balancing offer) is its delegation.
 */
function ownJawan(task: Task): boolean {
    return (
        (task.status === "active" || task.status === "held") &&
        task.agent !== undefined &&
        !(task.delegatedTo ?? []).includes(task.agent) &&
        !waitsForSlot(
            task,
            otherFleetMachines().map((machine) => machine.name),
        )
    );
}

/**
 * The chain a delegation of `task` (`delegate --for`, `task link`) carries when it forwards work another machine
 * delegated here: that delegator's task and every one above it, origin first. Empty for this machine's own task, one
 * delegated without `--for`, and a slice (the task's own jawan keeps the work here). Empty too when `task` is itself
 * a slice of its delegator's task (`delegatedBy.slice`): that task follows only `task`, records no delegation of the
 * forwarded work, and would refuse its reports (T2045).
 */
export function forwardChain(task: Task | undefined): Upstream[] {
    const by = task?.delegatedBy;
    if (task === undefined || by?.task === undefined || by.slice === true || ownJawan(task)) return [];
    return [...(by.upstream ?? []), { machine: by.machine, task: by.task }];
}

/**
 * Whether a delegation for `task` (`delegate --for`) is a slice of it: its own jawan works on it, so the delegation
 * only reports back (recordDelegation). The delegation says so, and work the delegated task forwards on then reports
 * to that task alone (forwardChain).
 */
export function delegatesSlice(task: Task | undefined): boolean {
    return task !== undefined && ownJawan(task);
}

/**
 * Record `fid` (a new delegation or a link) on the `--for` task, with `note`. While the task's own jawan works on it,
 * `fid` is a slice (`slices`): its outcome is noted and wakes this lead, and the task stays with its jawan, waiting on
 * the slice (`waitingOn`) until that is through, since the work is held on the other machine meanwhile (T1427).
 * Otherwise it is the task's delegation (`delegatedTo`): the task works through it and is done once every delegation is.
 */
export function recordDelegation(task: Task, fid: string, note: string): void {
    // Its owner's report can land first (it handed the work back on arrival): the task then stays as that left it.
    const handedBack = task.delegates?.[fid]?.handedBack;
    if (handedBack !== undefined) {
        if (!task.delegatedTo?.includes(fid) && !task.slices?.includes(fid))
            task.delegatedTo = [...(task.delegatedTo ?? []), fid];
        task.notes.push(`${note} (handed back already: ${handedBack})`);
        return;
    }
    if (task.slices?.includes(fid) || (!task.delegatedTo?.includes(fid) && ownJawan(task))) {
        if (!task.slices?.includes(fid)) task.slices = [...(task.slices ?? []), fid];
        task.notes.push(`${note} (a slice: ${task.id} stays with its own jawan)`);
        if (task.status === "active" && sliceOpen(task, fid)) task.waitingOn = delegateWait(fid);
        return;
    }
    if (!task.delegatedTo?.includes(fid)) task.delegatedTo = [...(task.delegatedTo ?? []), fid];
    task.notes.push(note);
    workOnBy(task, fid);
}

/**
 * The `--for` task now works through `fid` (a new delegation or a link): queued and active become active with it as
 * the jawan, and a done or dropped task (its earlier delegation finished or was given up) is reopened.
 */
function workOnBy(task: Task, fid: string): void {
    if (task.status === "held") return;
    if (task.status === "done" || task.status === "dropped") {
        task.notes.push(`reopened (was ${task.status}): it works through ${fid} now`);
        delete task.doneAt;
    }
    task.status = "active";
    task.startedAt ??= now().toISOString();
    task.agent = fid;
    task.dispatchedAt = now().toISOString();
}

/**
 * Give task `id`, which another machine delegated here, back to it with `reason`: it is dropped here, and its report
 * queues the delegator's `--for` task again with the reason, never dropping it.
 */
export function handBack(id: string, reason: string): Task {
    return updateTask(id, (entry) => {
        if (entry.delegatedBy === undefined)
            throw new ToliError(`${entry.id} was not delegated here: drop it instead (bin/toli task drop ${entry.id})`);
        if (entry.status === "done" || entry.status === "dropped")
            throw new ToliError(`${entry.id} is ${entry.status}`);
        entry.status = "dropped";
        entry.handedBack = reason;
        entry.notes.push(`handed back to ${entry.delegatedBy.machine}: ${reason}`);
        delete entry.waitingOn;
    });
}

/**
 * `task handback <id> --reason "..." [--full]`: give a task another machine delegated here back to it (overloaded,
 * not cloned, wrong machine). `--full` also marks this machine full for two hours (`lead full`), so no lead offers it
 * more work.
 */
function handback(argv: string[]): void {
    const args = new Args(argv, { values: ["reason"], booleans: ["full"] });
    args.maxPositional(1);
    const reason = args.str("reason")?.trim();
    if (!reason) throw new ToliError('task handback needs --reason "..."');
    const task = handBack(args.pos(0, "id"), reason);
    out(`${task.id}\thanded back to ${task.delegatedBy?.machine}: ${reason}`);
    cancelQueuedRunsOf(task.id, "handed back");
    if (args.bool("full")) out(fullText(setFull(`handed back ${task.id}: ${reason}`, HANDBACK_FULL_MINUTES)));
}

/** `task link`, `task escalate` and `task handback`; returns whether `sub` was one of them. */
export function delegationTaskCommand(sub: string, rest: string[]): boolean {
    if (linkTaskCommand(sub, rest)) return true;
    if (sub === "escalate") escalate(rest);
    else if (sub === "handback") handback(rest);
    else return false;
    return true;
}

export function parseUpdate(text: string): DelegationUpdate {
    const update = parseJson<DelegationUpdate>(text, "delegation update");
    if (typeof update.owner !== "string" || typeof update.id !== "string" || typeof update.task?.updatedAt !== "string")
        throw new ToliError("delegation update: needs owner, id and task");
    const delegation: unknown = update.delegation;
    if (delegation !== undefined && (typeof delegation !== "string" || !isValidName(delegation)))
        throw new ToliError("delegation update: delegation must be a delegation id");
    const forUser: unknown = update.forUser;
    if (forUser !== undefined && forUser !== true) throw new ToliError("delegation update: forUser must be true");
    const project: unknown = update.project;
    if (project !== undefined && (typeof project !== "string" || !isValidName(project)))
        throw new ToliError("delegation update: project must be a project name");
    const forwards: unknown = update.forwardedTo;
    if (forwards === undefined) return update;
    if (!Array.isArray(forwards)) throw new ToliError("delegation update: forwardedTo must be a list of fleet ids");
    for (const entry of forwards) {
        const { machine, id } = splitFleetId(typeof entry === "string" ? entry : "");
        if (machine === null || !/^T\d+$/.test(id))
            throw new ToliError(`delegation update: forwardedTo holds ${JSON.stringify(entry)}, not <machine>/T<n>`);
        requireName("machine", machine);
    }
    return update;
}
