// `task link` (docs/sardars.md): attach another machine's task, delegated without `--for`, to one of this machine's
// tasks. This machine records it as a delegation (src/records/delegation-sync.ts `recordDelegation`) and sends the
// owner a link; the owner's task then names this task as its delegator and reports to it. The owner refuses a link
// from any machine other than the one that delegated its task. A link that forwards work delegated here carries the
// chain above it (`upstream`), like `delegate --for`.
import { Args } from "../core/args.ts";
import { fleetMachine, loadMachine } from "../core/config.ts";
import { now, out, stamp, ToliError } from "../core/util.ts";
import { sendNow } from "../jobs/outbox.ts";
import { type Task, updateTask } from "./backlog.ts";
import { fleetId, parseUpstream, splitFleetId, type Upstream } from "./delegation-report.ts";
import { forwardChain, parseJson, recordDelegation } from "./delegation-sync.ts";

/** What `task link` sends the owner (JSON on `delegation link`'s stdin). */
export type DelegationLink = { from: string; task: string; id: string; upstream?: Upstream[] };

/** `task link`; returns whether `sub` was it. */
export function linkTaskCommand(sub: string, rest: string[]): boolean {
    if (sub !== "link") return false;
    link(rest);
    return true;
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
            ...(link.upstream === undefined || link.upstream.length === 0 ? {} : { upstream: link.upstream }),
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
    if (machine === null || machine === self || !/^T\d+$/.test(id))
        throw new ToliError("task link needs another machine's task: <machine>/T<n>");
    const target = fleetMachine(machine);
    const fid = fleetId(machine, id);
    let before: Task | undefined;
    updateTask(local, (task) => {
        before = structuredClone(task);
        recordDelegation(task, fid, `linked to ${fid}`);
    });
    const upstream = forwardChain(before);
    const body = JSON.stringify({
        from: self,
        task: local,
        id,
        ...(upstream.length === 0 ? {} : { upstream }),
    } satisfies DelegationLink);
    const sent = sendNow(
        self,
        target,
        "link",
        `link ${fid} to ${self}/${local}`,
        body,
        `link-${local}-${stamp(now())}`,
    );
    if (!sent.delivered && sent.refused !== undefined) {
        // The owner will never take this link: the task is as it was, plus a note saying why.
        const kept = before;
        updateTask(local, (task) => {
            for (const key of Object.keys(task)) Reflect.deleteProperty(task, key);
            Object.assign(task, kept, { notes: [...(kept?.notes ?? []), `link to ${fid} refused: ${sent.refused}`] });
        });
        throw new ToliError(`${machine} refused the link: ${sent.refused}`);
    }
    out(
        sent.delivered
            ? `${local} linked to ${fid}: ${sent.stdout.trim()}`
            : `${local} linked to ${fid} here; ${machine} gets the link ${sent.pulled ? "with its next pull" : "from the minute tick"} (${sent.error})`,
    );
}

export function parseLink(text: string): DelegationLink {
    const link = parseJson<DelegationLink>(text, "delegation link");
    if (typeof link.from !== "string" || typeof link.task !== "string" || typeof link.id !== "string")
        throw new ToliError("delegation link: needs from, task and id");
    const upstream = parseUpstream(link.upstream, "delegation link");
    return { from: link.from, task: link.task, id: link.id, ...(upstream.length === 0 ? {} : { upstream }) };
}
