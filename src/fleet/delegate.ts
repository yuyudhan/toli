// `bin/toli delegate`: hand one task to another machine's lead (docs/sardars.md). The target's
// `bin/toli delegation receive` adds it to that machine's own backlog (owned there, `delegatedBy` naming this machine),
// saves the brief, and posts it to that machine's inbox, which wakes its lead; that lead dispatches its own jawans.
// The task's results and questions come back by themselves (src/records/delegation-report.ts).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Args } from "../core/args.ts";
import { fleetMachine, loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import {
    isValidName,
    now,
    out,
    readJson,
    readStdin,
    requireName,
    stamp,
    ToliError,
    warn,
    writeTextAtomic,
} from "../core/util.ts";
import { parseOptionalTier, type Tier } from "../harness/models.ts";
import { type Delivered, type OutboxItem, queuedText, sendNow } from "../jobs/outbox.ts";
import { loadProjects } from "../projects/projects.ts";
import { loadBacklog, type Shape, type Task, updateBacklog, updateTask } from "../records/backlog.ts";
import { fleetId } from "../records/delegation-report.ts";
import { applyUpdate, parseLink, parseUpdate, receiveLink, recordDelegation } from "../records/delegation-sync.ts";
import { addInboxItem } from "../records/inbox.ts";

/** What travels to the target (JSON on `delegation receive`'s stdin). */
export type Delegation = {
    /**
     * `<from>-<timestamp>`, fresh per `bin/toli delegate` run: a repeat of the same id returns the task already
     * created, and so does the same work under a new id while that task is open (delegationKey).
     */
    id: string;
    from: string;
    /** The delegating machine's own task this one works for (`--for`). */
    fromTask?: string;
    title: string;
    brief: string;
    project?: string;
    /** The project's git URL as the delegator knows it, so the target's lead can clone it. */
    url?: string;
    note?: string;
    shape?: Shape;
    tier?: Tier;
};

/** The project a delegation without `--project` is filed under: work on toli itself or on the machine. */
const DEFAULT_PROJECT = "toli";
const ACCEPTED = /^delegation-accepted (\S+) (created|existing)$/m;

function parseDelegation(text: string): Delegation {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new ToliError("delegation receive needs the delegation JSON on stdin");
    }
    if (typeof value !== "object" || value === null) throw new ToliError("delegation receive: not a JSON object");
    const field = (key: string): string | undefined => {
        const raw: unknown = Reflect.get(value, key);
        if (raw === undefined) return undefined;
        if (typeof raw !== "string") throw new ToliError(`delegation receive: ${key} must be a string`);
        return raw;
    };
    const id = field("id");
    if (id === undefined || !isValidName(id)) throw new ToliError("delegation receive: missing or invalid id");
    const title = field("title")?.trim();
    if (!title) throw new ToliError("delegation receive: missing title");
    const brief = field("brief") ?? "";
    if (brief.trim() === "") throw new ToliError("delegation receive: empty brief");
    const project = field("project");
    if (project !== undefined) requireName("project", project);
    const fromTask = field("fromTask");
    if (fromTask !== undefined) requireName("task", fromTask);
    const shape = field("shape");
    if (shape !== undefined && shape !== "ship" && shape !== "scout")
        throw new ToliError("delegation receive: shape must be ship or scout");
    const tier = parseOptionalTier(field("tier"));
    const url = field("url");
    const note = field("note");
    return {
        id,
        from: requireName("machine", field("from")),
        title,
        brief,
        ...(fromTask === undefined ? {} : { fromTask }),
        ...(project === undefined ? {} : { project }),
        ...(url === undefined ? {} : { url }),
        ...(note === undefined ? {} : { note }),
        ...(shape === undefined ? {} : { shape }),
        ...(tier === undefined ? {} : { tier }),
    };
}

/**
 * The piece of work a delegation hands over, independent of its id: sender, `--for` task, project, title and brief.
 * Each run of `bin/toli delegate` gets a fresh id, so a lead that runs the same delegation again (after a slow ssh,
 * while an unreachable target's copies wait in its outbox) sends the same key under a new id.
 */
export function delegationKey(delegation: Delegation): string {
    const work = [delegation.from, delegation.fromTask ?? "", delegation.project ?? "", delegation.title];
    return createHash("sha256")
        .update(JSON.stringify([...work, delegation.brief.trim()]))
        .digest("hex")
        .slice(0, 16);
}

/**
 * Whether `task` is an open delegation of the same work from the same delegator: the same key, or the same `--for`
 * task and title.
 */
function sameOpenWork(task: Task, delegation: Delegation, key: string): boolean {
    const by = task.delegatedBy;
    if (by === undefined || by.machine !== delegation.from || task.status === "done" || task.status === "dropped")
        return false;
    if (by.key === key) return true;
    return delegation.fromTask !== undefined && by.task === delegation.fromTask && task.title === delegation.title;
}

/**
 * Record a delegation in this machine's backlog, once per delegation id, and once per open piece of work: the same
 * work (delegationKey) from the same delegator while an earlier copy is open (a copy queued for the tick and a retry
 * that went through, or the delegating lead running the command again) returns that task. Returns the task and whether
 * it was new; a new one gets its brief saved and an inbox item that wakes this machine's lead.
 */
export function receiveDelegation(delegation: Delegation): { task: Task; created: boolean } {
    const project = delegation.project ?? DEFAULT_PROJECT;
    const cloned = existsSync(paths.projectDir(project));
    const key = delegationKey(delegation);
    const result = updateBacklog((backlog) => {
        const existing =
            backlog.tasks.find((task) => task.delegatedBy?.id === delegation.id) ??
            backlog.tasks.find((task) => sameOpenWork(task, delegation, key));
        if (existing) return { task: { ...existing }, created: false };
        const at = now().toISOString();
        const by = delegation.fromTask === undefined ? delegation.from : `${delegation.from}/${delegation.fromTask}`;
        const task: Task = {
            id: `T${backlog.nextId}`,
            project,
            title: delegation.title,
            shape: delegation.shape ?? "ship",
            status: "queued",
            ...(delegation.tier === undefined ? {} : { tier: delegation.tier }),
            notes: [
                ...(delegation.note === undefined ? [] : [delegation.note]),
                `delegated by ${by}`,
                ...(cloned || delegation.project === undefined
                    ? []
                    : [
                          `projects/${project} is not cloned here: \`bin/toli project ensure ${project} ${delegation.url ?? "<git-url>"}\` first`,
                      ]),
            ],
            delegatedBy: {
                machine: delegation.from,
                ...(delegation.fromTask === undefined ? {} : { task: delegation.fromTask }),
                id: delegation.id,
                key,
                at,
            },
            createdAt: at,
            updatedAt: at,
        };
        backlog.nextId += 1;
        backlog.tasks.push(task);
        return { task: { ...task }, created: true };
    });
    if (!result.created) return result;
    const { task } = result;
    const briefFile = join(paths.projectBriefsDir(project), `${task.id}.md`);
    if (!existsSync(briefFile)) writeTextAtomic(briefFile, `${delegation.brief.trimEnd()}\n`);
    const self = loadMachine().name;
    addInboxItem(
        delegation.from,
        `delegated ${task.id} from ${delegation.from}: ${task.title}`,
        [
            `${delegation.from}'s lead delegated this task to you as ${fleetId(self, task.id)}: it is yours now.`,
            `Dispatch your own jawan for it (toli-dispatch skill; \`bin/toli task start ${task.id} --agent <id>\` or`,
            `\`bin/toli spawn --task ${task.id} --brief ${briefFile}\`). Marking it done, held or dropped reports back to`,
            `${delegation.from} by itself; a question for the user goes in \`bin/toli task hold ${task.id}\`.`,
            "",
            `- brief: ${briefFile}`,
            `- project: ${project}${cloned ? "" : " (not cloned here)"}`,
            ...(delegation.fromTask === undefined ? [] : [`- for: ${delegation.fromTask} on ${delegation.from}`]),
            ...(delegation.note === undefined ? [] : [`- note: ${delegation.note}`]),
        ].join("\n"),
    );
    return result;
}

/**
 * `delegation receive|update|link` (JSON on stdin): what another machine's lead runs here over ssh. `receive`: a new
 * delegation (`delegate`); `update`: a delegated task's owner reports it (src/records/delegation-sync.ts); `link`:
 * this machine's task starts reporting to the delegator's (`task link`).
 */
export function delegationCommand(argv: string[]): void {
    const [sub, ...rest] = argv;
    new Args(rest).maxPositional(0);
    switch (sub) {
        case "receive": {
            const { task, created } = receiveDelegation(parseDelegation(readStdin()));
            out(`delegation-accepted ${fleetId(loadMachine().name, task.id)} ${created ? "created" : "existing"}`);
            return;
        }
        case "update":
            out(applyUpdate(parseUpdate(readStdin())));
            return;
        case "link":
            out(receiveLink(parseLink(readStdin())));
            return;
        default:
            throw new ToliError("usage: toli delegation receive|update|link (JSON on stdin)");
    }
}

/**
 * Record the target's answer to a delivered delegation on the `--for` task (src/records/delegation-sync.ts
 * `recordDelegation`): it counts as active with that id as its jawan, so oversight does not call it stale, and a done
 * or dropped `--for` task (its earlier delegation was given up) is reopened; while the task's own jawan works on it,
 * the delegation is a slice that only reports back. Returns the fleet id.
 */
export function acceptDelegation(delegation: Delegation, stdout: string): string {
    const accepted = ACCEPTED.exec(stdout);
    if (!accepted) throw new ToliError(`the target did not accept the delegation: ${stdout.trim() || "no output"}`);
    const id = accepted[1] as string;
    const forTask = delegation.fromTask;
    if (forTask !== undefined && loadBacklog().tasks.some((task) => task.id === forTask)) {
        updateTask(forTask, (task) => recordDelegation(task, id, `delegated to ${id}: ${delegation.title}`));
    }
    return id;
}

/**
 * The outbox hook (the minute tick's delivery, or a pull's acknowledgement): a queued delegation that landed is
 * recorded here and wakes this lead.
 */
export function onOutboxDelivered({ item, stdout }: Delivered): void {
    if (item.kind !== "delegation") return;
    const delegation = parseDelegation(item.body);
    const id = acceptDelegation(delegation, stdout);
    const existing = ACCEPTED.exec(stdout)?.[2] === "existing";
    const target = item.to?.name ?? "the target";
    addInboxItem(
        delegation.from,
        `delegated ${id}: ${delegation.title}`,
        existing
            ? `The delegation queued for ${target} was already there as ${id} (an earlier copy landed first); no second task was made.`
            : `The delegation queued for ${target} has landed as ${id}.\nIts lead dispatches it; the result comes back here as a wake.`,
    );
}

/**
 * The id of a delegation of the same work (delegationKey) already waiting in this machine's outbox for `target`,
 * queued or being sent; null when there is none. A lead that runs `delegate` again while the target is unreachable
 * (or takes no inbound ssh) gets that copy instead of queueing another.
 */
function queuedCopy(target: string, key: string): string | null {
    const dir = paths.outboxDir();
    if (!existsSync(dir)) return null;
    for (const file of readdirSync(dir)) {
        if (!/\.json(\.sending-\d+)?$/.test(file)) continue;
        const item = readJson<OutboxItem | null>(join(dir, file), null);
        if (item?.kind !== "delegation" || item.to?.name !== target) continue;
        let delegation: Delegation;
        try {
            delegation = parseDelegation(item.body);
        } catch {
            continue;
        }
        if (delegationKey(delegation) === key) return delegation.id;
    }
    return null;
}

/**
 * `delegate <machine> "<title>" --brief <file> [--project p] [--note "..."] [--for T<n>] [--shape s] [--tier t]`.
 * Prints the fleet id, or that the delegation is queued for the tick while the target is unreachable.
 */
export function delegateCommand(argv: string[]): number {
    const args = new Args(argv, { values: ["brief", "project", "note", "for", "shape", "tier"] });
    args.maxPositional(2);
    const targetName = requireName("machine", args.pos(0, "machine"));
    const title = args.pos(1, "title").trim();
    if (title === "") throw new ToliError("delegate needs a task title");
    const self = loadMachine().name;
    if (targetName === self)
        throw new ToliError(
            "that is this machine: add the task here (`bin/toli task add`) and dispatch your own jawan",
        );
    const target = fleetMachine(targetName);
    const briefFile = args.str("brief");
    if (briefFile === undefined) throw new ToliError("delegate needs --brief <file>");
    if (!existsSync(briefFile)) throw new ToliError(`no brief at ${briefFile}`);
    const brief = readFileSync(briefFile, "utf8");
    if (brief.trim() === "") throw new ToliError(`${briefFile} is empty`);
    const project = args.str("project");
    if (project !== undefined) requireName("project", project);
    const forTask = args.str("for")?.toUpperCase();
    if (forTask !== undefined && !loadBacklog().tasks.some((task) => task.id === forTask))
        throw new ToliError(`unknown task "${forTask}" (--for names this machine's own task)`);
    const shape = args.str("shape");
    if (shape !== undefined && shape !== "ship" && shape !== "scout")
        throw new ToliError("--shape must be ship or scout");
    const tier = parseOptionalTier(args.str("tier"));
    const note = args.str("note");
    const url = project === undefined ? undefined : loadProjects().find((entry) => entry.name === project)?.url;
    const delegation: Delegation = {
        id: `${self}-${stamp()}`,
        from: self,
        title,
        brief,
        ...(forTask === undefined ? {} : { fromTask: forTask }),
        ...(project === undefined ? {} : { project }),
        ...(url ? { url } : {}),
        ...(note === undefined ? {} : { note }),
        ...(shape === undefined ? {} : { shape }),
        ...(tier === undefined ? {} : { tier }),
    };
    const earlier = queuedCopy(target.name, delegationKey(delegation));
    const outboxId = `delegation-${delegation.id}`;
    const sent = sendNow(self, target, "delegation", `delegate ${title}`, JSON.stringify(delegation), outboxId);
    if (!sent.delivered) {
        if (!sent.pulled) warn(sent.error);
        if (earlier !== null) {
            // The same work already waits in the outbox: keep that copy, never a second one for the target to receive.
            rmSync(join(paths.outboxDir(), `${outboxId}.json`), { force: true });
            out(
                `already queued for ${target.name} (${earlier}): that copy goes when it can, and its task id arrives here as a wake; do not delegate it again`,
            );
            return 0;
        }
        out(
            sent.pulled
                ? `${queuedText(target.name, sent)}; its task id arrives here as a wake (${delegation.id}); do not delegate it again`
                : `queued: ${target.name} is unreachable; the minute tick retries, and its task id arrives here as a wake (${delegation.id}); do not delegate it again`,
        );
        return 0;
    }
    const id = acceptDelegation(delegation, sent.stdout);
    const existing = ACCEPTED.exec(sent.stdout)?.[2] === "existing";
    out(
        `delegated to ${id}${forTask === undefined ? "" : ` (for ${forTask})`}: ${target.name}'s lead dispatches it${existing ? " (it was already there: no second task was made)" : ""}`,
    );
    return 0;
}
