// Write-back of delegated tasks (docs/sardars.md): the delegating machine's `--for` task follows the delegated task
// its owner reports (src/records/delegation-report.ts). `delegation update` applies one report here: the owner's new
// notes are copied, the task's state is recorded under `delegates`, and once every delegation is done (or dropped)
// the `--for` task is too, with the commit and report. A slice (a delegation made while the `--for` task's own jawan
// works on it) only adds its notes, commit and report. A question stays with this machine's lead, who answers it
// (`task answer <owner>/T<n>`) or, when only the user can decide, `task escalate`s it into the Needs-you queue.
// `task link` attaches a delegation made without `--for`. Repeats are skipped by the owner's `updatedAt`.
import { join, relative } from "node:path";
import { Args } from "../core/args.ts";
import { fleetMachine, loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, out, readJson, stamp, ToliError, withLock, writeJsonAtomic, writeTextAtomic } from "../core/util.ts";
import { fullText, HANDBACK_FULL_MINUTES, setFull } from "../fleet/full.ts";
import { sendNow } from "../jobs/outbox.ts";
import { loadBacklog, type Task, updateTask } from "./backlog.ts";
import { type DelegateState, type DelegationUpdate, fleetId, REPORTED, splitFleetId } from "./delegation-report.ts";
import { forwardAnswer } from "./fleet-tasks.ts";
import { addInboxItem } from "./inbox.ts";

/** What `task link` sends the owner (JSON on `delegation link`'s stdin). */
export type DelegationLink = { from: string; task: string; id: string };

/** The last update seen per fleet id (state/delegates.json): decides once whether an update wakes this lead. */
type SeenFile = Record<string, { updatedAt: string; status: string; question?: string }>;

function parseJson<T>(text: string, what: string): T {
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
        for (const note of notes.slice(seen?.notes ?? 0))
            if (!note.startsWith("delegated by ")) task.notes.push(`${id}: ${note}`);
        if (handedBack !== undefined && seen?.handedBack === undefined)
            task.notes.push(`${id} handed the work back: ${handedBack}`);
        else if (seen?.status !== status) task.notes.push(`${id} is ${status}`);
        const state: DelegateState = { status, updatedAt, notes: notes.length };
        if (status === "held") Object.assign(state, { question, options, recommend, blocks });
        if (commit !== undefined) state.commit = commit;
        if (handedBack !== undefined) state.handedBack = handedBack;
        task.delegates = { ...task.delegates, [id]: state };
        if (status === "done" && update.report !== null) {
            const report = saveReport(id, update.report);
            if (slice) task.notes.push(`${id} report: ${report}`);
            else task.report = report;
        }
        if (slice && status === "done" && commit !== undefined && seen?.commit !== commit)
            task.notes.push(`${id} commit: ${commit}`);
        settle(task, id, status, commit, slice);
    });
    return applied;
}

/**
 * The `--for` task's own status after a delegate's change: done when every delegation not dropped is done, dropped
 * when all are dropped, queued again (for another Sardar or this one) when every delegation was handed back. A slice
 * only releases the hold it escalated; the task's own jawan decides the rest.
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
    const live = (task.delegatedTo ?? []).filter((entry) => task.delegates?.[entry]?.handedBack === undefined);
    const open = live
        .map((entry) => task.delegates?.[entry]?.status ?? "active")
        .filter((entry) => entry !== "dropped");
    if (live.length === 0) {
        task.status = "queued";
        delete task.agent;
        delete task.dispatchedAt;
    } else if (open.length === 0) task.status = "dropped";
    else if (open.every((entry) => entry === "done")) {
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
    const local = localTaskFor(update, id);
    const applied = local !== undefined && mirror(local, id, update);
    if (claimWake(id, update)) {
        const after = local === undefined ? undefined : loadBacklog().tasks.find((task) => task.id === local.id);
        const yours = after === undefined ? [] : ["", `Your task ${after.id} is ${after.status} (bin/toli task list).`];
        addInboxItem(update.owner, update.message.title, [update.message.body, ...yours].join("\n"));
    }
    return `delegation-updated ${id}${local === undefined ? "" : ` ${local.id}${applied ? "" : " (already recorded)"}`}`;
}

/** `delegation link` (link JSON on stdin), on the owner: the task now reports to `from`'s task, starting now. */
export function receiveLink(link: DelegationLink): string {
    const id = splitFleetId(link.id).id;
    const task = updateTask(id, (entry) => {
        const by = entry.delegatedBy;
        if (by !== undefined && by.machine !== link.from)
            throw new ToliError(`${entry.id} was delegated by ${by.machine}, not ${link.from}`);
        entry.delegatedBy = {
            machine: link.from,
            task: link.task,
            id: by?.id ?? `link-${link.from}-${link.task}`,
            ...(by?.key === undefined ? {} : { key: by.key }),
            at: by?.at ?? now().toISOString(),
        };
        // A new note is a change the delegator gets, so this sends the task back as it is now.
        entry.notes.push(`linked to ${link.from}/${link.task}`);
    });
    return `delegation-linked ${fleetId(loadMachine().name, task.id)} to ${link.from}/${link.task}`;
}

/** `task link <T<n>> <machine>/T<n>`: make another machine's task (delegated without `--for`) report to this one. */
function link(argv: string[]): void {
    const args = new Args(argv);
    args.maxPositional(2);
    const local = args.pos(0, "task").toUpperCase();
    const { machine, id } = splitFleetId(args.pos(1, "fleet id"));
    const self = loadMachine().name;
    if (machine === null || machine === self)
        throw new ToliError("task link needs another machine's task: <machine>/T<n>");
    const target = fleetMachine(machine);
    const fid = fleetId(machine, id);
    updateTask(local, (task) => recordDelegation(task, fid, `linked to ${fid}`));
    const body = JSON.stringify({ from: self, task: local, id } satisfies DelegationLink);
    const sent = sendNow(
        self,
        target,
        "link",
        `link ${fid} to ${self}/${local}`,
        body,
        `link-${local}-${stamp(now())}`,
    );
    out(
        sent.delivered
            ? `${local} linked to ${fid}: ${sent.stdout.trim()}`
            : `${local} linked to ${fid} here; ${machine} gets the link ${sent.pulled ? "with its next pull" : "from the minute tick"} (${sent.error})`,
    );
}

/** `task escalate <machine>/T<n>`: a delegated task's question needs the user; hold the `--for` task with it. */
function escalate(argv: string[]): void {
    const args = new Args(argv);
    args.maxPositional(1);
    const { machine, id } = splitFleetId(args.pos(0, "fleet id"));
    if (machine === null) throw new ToliError("task escalate needs a delegated task's fleet id: <machine>/T<n>");
    const fid = fleetId(machine, id);
    const local = loadBacklog().tasks.find((task) => task.delegates?.[fid] !== undefined);
    const state = local?.delegates?.[fid];
    if (local === undefined || state?.status !== "held")
        throw new ToliError(`${fid} has no open question here (bin/toli task list --fleet)`);
    const task = updateTask(local.id, (entry) => {
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
    out(`${task.id}\theld\t${task.title}\t(question: ${task.question})`);
    out(
        `in the Needs-you queue; the user's answer (bin/toli task answer ${task.id} "<answer>") goes to ${machine} too`,
    );
}

/** After `task answer` released an escalated hold here, the same answer goes to the delegated task's owner. */
export function forwardEscalatedAnswer(heldFrom: string | undefined, reply: string): void {
    if (heldFrom === undefined) return;
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
 * Whether the task's own jawan works on it: active or held with an agent that is not one of its delegations. A
 * delegation made then is a slice of that work.
 */
function ownJawan(task: Task): boolean {
    return (
        (task.status === "active" || task.status === "held") &&
        task.agent !== undefined &&
        !(task.delegatedTo ?? []).includes(task.agent)
    );
}

/**
 * Record `fid` (a new delegation or a link) on the `--for` task, with `note`. While the task's own jawan works on it,
 * `fid` is a slice (`slices`): its outcome is noted and wakes this lead, and the task stays with its jawan. Otherwise
 * it is the task's delegation (`delegatedTo`): the task works through it and is done once every delegation is.
 */
export function recordDelegation(task: Task, fid: string, note: string): void {
    if (task.slices?.includes(fid) || (!task.delegatedTo?.includes(fid) && ownJawan(task))) {
        if (!task.slices?.includes(fid)) task.slices = [...(task.slices ?? []), fid];
        task.notes.push(`${note} (a slice: ${task.id} stays with its own jawan)`);
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
 * `task handback <id> --reason "..." [--full]`: give a task another machine delegated here back to it (overloaded,
 * not cloned, wrong machine). It is dropped here; the delegator's `--for` task goes back to queued with the reason,
 * never dropped. `--full` also marks this machine full for two hours (`lead full`), so no lead offers it more work.
 */
function handback(argv: string[]): void {
    const args = new Args(argv, { values: ["reason"], booleans: ["full"] });
    args.maxPositional(1);
    const reason = args.str("reason")?.trim();
    if (!reason) throw new ToliError('task handback needs --reason "..."');
    const task = updateTask(args.pos(0, "id"), (entry) => {
        if (entry.delegatedBy === undefined)
            throw new ToliError(`${entry.id} was not delegated here: drop it instead (bin/toli task drop ${entry.id})`);
        if (entry.status === "done" || entry.status === "dropped")
            throw new ToliError(`${entry.id} is ${entry.status}`);
        entry.status = "dropped";
        entry.handedBack = reason;
        entry.notes.push(`handed back to ${entry.delegatedBy.machine}: ${reason}`);
        delete entry.waitingOn;
    });
    out(`${task.id}\thanded back to ${task.delegatedBy?.machine}: ${reason}`);
    if (args.bool("full")) out(fullText(setFull(`handed back ${task.id}: ${reason}`, HANDBACK_FULL_MINUTES)));
}

/** `task link`, `task escalate` and `task handback`; returns whether `sub` was one of them. */
export function delegationTaskCommand(sub: string, rest: string[]): boolean {
    if (sub === "link") link(rest);
    else if (sub === "escalate") escalate(rest);
    else if (sub === "handback") handback(rest);
    else return false;
    return true;
}

export function parseUpdate(text: string): DelegationUpdate {
    const update = parseJson<DelegationUpdate>(text, "delegation update");
    if (typeof update.owner !== "string" || typeof update.id !== "string" || typeof update.task?.updatedAt !== "string")
        throw new ToliError("delegation update: needs owner, id and task");
    return update;
}

export function parseLink(text: string): DelegationLink {
    const link = parseJson<DelegationLink>(text, "delegation link");
    if (typeof link.from !== "string" || typeof link.task !== "string" || typeof link.id !== "string")
        throw new ToliError("delegation link: needs from, task and id");
    return link;
}
