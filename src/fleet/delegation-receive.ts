// The receiving side of `bin/toli delegate` (docs/sardars.md): `bin/toli delegation receive` adds a delegation to this
// machine's own backlog (owned here, `delegatedBy` naming the delegator), saves the brief and posts it to this
// machine's inbox, which wakes its lead; `update` and `link` apply a delegated task's reports and links. Ship work for
// a project this machine marked verify-only is handed back on arrival instead (docs/projects.md).
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Args } from "../core/args.ts";
import { loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { isValidName, now, out, readStdin, requireName, ToliError, writeTextAtomic } from "../core/util.ts";
import { parseOptionalTier, type Tier } from "../harness/models.ts";
import { loadProjects } from "../projects/projects.ts";
import { type Shape, type Task, updateBacklog } from "../records/backlog.ts";
import { parseLink, receiveLink } from "../records/delegation-link.ts";
import { fleetId, parseUpstream, type Upstream } from "../records/delegation-report.ts";
import { applyUpdate, handBack, parseUpdate } from "../records/delegation-sync.ts";
import { addInboxItem } from "../records/inbox.ts";
import { verifyOnlyText } from "./pick.ts";

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
    /**
     * When the delegator forwards a task delegated to it (`--for` that task), the tasks above it, origin first: the
     * new task reports to each of them too (src/records/delegation-report.ts).
     */
    upstream?: Upstream[];
    /** `delegate --force`: ship work the target takes even for a project it marked verify-only. */
    force?: true;
};

/** The project a delegation without `--project` is filed under: work on toli itself or on the machine. */
export const DEFAULT_PROJECT = "toli";

export function parseDelegation(text: string): Delegation {
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
    const upstream = parseUpstream(Reflect.get(value, "upstream"), "delegation receive");
    const force = Reflect.get(value, "force");
    if (force !== undefined && force !== true) throw new ToliError("delegation receive: force must be true");
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
        ...(upstream.length === 0 ? {} : { upstream }),
        ...(force === true ? { force } : {}),
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
 * it was new; a new one gets its brief saved and an inbox item that wakes this machine's lead. New ship work for a
 * project this machine marked verify-only (unless sent with `--force`) is handed back at once instead, with the reason
 * in `handedBack`: the delegator's `--for` task is queued again.
 */
export function receiveDelegation(delegation: Delegation): { task: Task; created: boolean; handedBack?: string } {
    const project = delegation.project ?? DEFAULT_PROJECT;
    const cloned = existsSync(paths.projectDir(project));
    const key = delegationKey(delegation);
    const self = loadMachine().name;
    // Ship work for a project this machine marked verify-only: handed back below, unless sent with --force.
    const verifyOnly =
        (delegation.shape ?? "ship") === "ship" &&
        loadProjects().some((entry) => entry.name === project && entry.role === "verify-only");
    // A chain that comes back here holds this machine's own task, which needs no report from itself.
    const upstream = (delegation.upstream ?? []).filter((entry) => entry.machine !== self);
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
                ...(verifyOnly && delegation.force === true
                    ? [`${project} is verify-only here: ${delegation.from} sent this ship work with --force`]
                    : []),
            ],
            delegatedBy: {
                machine: delegation.from,
                ...(delegation.fromTask === undefined ? {} : { task: delegation.fromTask }),
                id: delegation.id,
                key,
                at,
                ...(upstream.length === 0 ? {} : { upstream }),
            },
            createdAt: at,
            updatedAt: at,
        };
        backlog.nextId += 1;
        backlog.tasks.push(task);
        return { task: { ...task }, created: true };
    });
    if (!result.created) return result;
    if (verifyOnly && delegation.force !== true) {
        const reason = `${self} is ${verifyOnlyText(project)} (bin/toli pick --project ${project})`;
        return { task: handBack(result.task.id, reason), created: true, handedBack: reason };
    }
    const { task } = result;
    const briefFile = join(paths.projectBriefsDir(project), `${task.id}.md`);
    if (!existsSync(briefFile)) writeTextAtomic(briefFile, `${delegation.brief.trimEnd()}\n`);
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
 * `delegation receive|update|link [--from <machine>]` (JSON on stdin): what another machine's lead runs here (over
 * ssh, or applied from a pull or a peer's signed message). `receive`: a new delegation (`delegate`); `update`: a
 * delegated task's owner reports it (src/records/delegation-sync.ts); `link`: this machine's task starts reporting to
 * the delegator's (`task link`). `--from` names the sender as the transport verified it; the JSON must speak for that
 * machine only.
 */
export function delegationCommand(argv: string[]): void {
    const [sub, ...rest] = argv;
    const args = new Args(rest, { values: ["from"] });
    args.maxPositional(0);
    const from = args.str("from");
    if (from !== undefined) requireName("machine", from);
    const claim = (claimed: string, what: string): void => {
        if (from !== undefined && claimed !== from) throw new ToliError(`${what} cannot come from ${from}`);
    };
    switch (sub) {
        case "receive": {
            const delegation = parseDelegation(readStdin());
            claim(delegation.from, `a delegation from ${delegation.from}`);
            const { task, created, handedBack } = receiveDelegation(delegation);
            out(`delegation-accepted ${fleetId(loadMachine().name, task.id)} ${created ? "created" : "existing"}`);
            if (handedBack !== undefined) out(`delegation-handed-back ${handedBack}`);
            return;
        }
        case "update": {
            const update = parseUpdate(readStdin());
            claim(update.owner, `an update for ${update.owner}'s task`);
            out(applyUpdate(update));
            return;
        }
        case "link": {
            const link = parseLink(readStdin());
            claim(link.from, `a link from ${link.from}`);
            out(receiveLink(link));
            return;
        }
        default:
            throw new ToliError("usage: toli delegation receive|update|link [--from <machine>] (JSON on stdin)");
    }
}
