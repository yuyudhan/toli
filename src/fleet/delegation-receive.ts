// The receiving side of `bin/toli delegate` (docs/sardars.md): `bin/toli delegation receive` adds a delegation to this
// machine's own backlog (owned here, `delegatedBy` naming the delegator), saves the brief and posts it to this
// machine's inbox, which wakes its lead; `update` and `link` apply a delegated task's reports and links. Ship work for
// a project this machine marked verify-only is handed back on arrival instead; verify work (`--verify`) it takes
// (docs/projects.md).
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Args } from "../core/args.ts";
import { loadFleet, loadMachine } from "../core/config.ts";
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
    /** `delegate --verify`: verify work, which a machine verify-only for the project takes. Ship shape only. */
    verify?: true;
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
    const verify = Reflect.get(value, "verify");
    if (verify !== undefined && verify !== true) throw new ToliError("delegation receive: verify must be true");
    if (verify === true && shape === "scout") throw new ToliError("delegation receive: verify work is ship shape");
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
        ...(verify === true ? { verify } : {}),
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
 * A task id in a brief: `T<n>`, optionally after `<word>/` (a fleet id when the word names a machine, else a path such
 * as `reports/T<n>.md`). `T<n>` inside a longer word (`T21x`, a timestamp's `16T10`) is not an id.
 */
const BRIEF_TASK_ID = /(?:\b([\w.-]+)\/)?\bT(\d+)\b/g;

/** The first line of a `git format-patch` mail. */
const PATCH_MAIL = /^From [0-9a-f]{40} /;
/** A hunk header; an omitted count is one line. */
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
/** A git diff line outside its hunks: a file's extended headers, or the no-newline marker after a hunk's last line. */
const DIFF_HEADER =
    /^(?:diff --git |index |--- |\+\+\+ |(?:old|new|deleted file|new file) mode |(?:similarity|dissimilarity) index |(?:rename|copy) (?:from|to) |Binary files |\\ )/;
/** A line of a `GIT binary patch` body: a `literal`/`delta` header, a base85 data line, or the blank line after one. */
const BINARY_LINE = /^(?:(?:literal|delta) \d+|[A-Za-z][0-9A-Za-z!#$%&()*+;<=>?@^_`{|}~-]*|)$/;

/**
 * Which lines of a brief are patch text, which must reach the receiver byte for byte (`git am` and `git apply` check
 * it against the patch's blob ids): a `## PATCH (begin)` .. `## PATCH (end)` section, and every inlined
 * `git format-patch` mail or git diff. A mail runs from its `From <sha>` line through its diffs to the `-- ` signature
 * and the version line after it; a diff runs from `diff --git` through its file headers and hunks, each hunk exactly as
 * many lines as its header counts, so the first other line after a diff (a code fence, prose, even a `- ` list) ends it.
 */
function patchLines(lines: readonly string[]): boolean[] {
    const patch: boolean[] = [];
    let state: "prose" | "section" | "mail" | "diff" | "binary" | "signature" = "prose";
    let oldLeft = 0;
    let newLeft = 0;
    for (const raw of lines) {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (oldLeft > 0 || newLeft > 0) {
            // A hunk line: context (an editor may strip a blank one to empty), removal, addition, or "\ No newline".
            const mark = line[0] ?? " ";
            if (mark === " " || mark === "-") oldLeft -= 1;
            if (mark === " " || mark === "+") newLeft -= 1;
            patch.push(true);
            continue;
        }
        if (state === "section") {
            if (/^#+ PATCH \(end\)/.test(line)) state = "prose";
            patch.push(true);
            continue;
        }
        if (state === "signature") {
            // The git version line after `-- ` closes a format-patch mail.
            state = "prose";
            patch.push(true);
            continue;
        }
        if (state === "binary" && BINARY_LINE.test(line)) {
            patch.push(true);
            continue;
        }
        const hunk = HUNK_HEADER.exec(line);
        if (/^#+ PATCH \(begin\)/.test(line)) state = "section";
        else if (PATCH_MAIL.test(line)) state = "mail";
        else if (state === "prose") {
            if (line.startsWith("diff --git ")) state = "diff";
        } else if (line === "-- ") state = "signature";
        else if (state === "mail") {
            // The commit message and diffstat, up to the first diff.
            if (line.startsWith("diff --git ")) state = "diff";
        } else if (hunk !== null) {
            state = "diff";
            oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
            newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
        } else if (line === "GIT binary patch") state = "binary";
        else if (DIFF_HEADER.test(line)) state = "diff";
        else state = "prose";
        patch.push(state !== "prose");
    }
    return patch;
}

/**
 * The delegator's brief with its task ids made safe here, where the same `T<n>` is another, unrelated task: the
 * `--for` task becomes `localId` (the task this delegation made), every other bare id the delegator's fleet id
 * `<from>/T<n>`, which no command on this machine changes. Ids already qualified by a machine stay, and so does patch
 * text (patchLines), which must apply unchanged. Returns the brief and each rewrite, `T<n> -> <id>`: the `--for`
 * task's first, then the rest in order of first appearance.
 */
function rewriteBriefIds(
    delegation: Pick<Delegation, "brief" | "from" | "fromTask">,
    localId: string,
    machines: ReadonlySet<string>,
): { brief: string; rewrites: string[] } {
    const mapping = new Map<string, string>();
    const rewrite = (match: string, prefix: string | undefined, n: string): string => {
        if (prefix !== undefined && machines.has(prefix)) return match;
        const id = `T${n}`;
        const to = id === delegation.fromTask ? localId : fleetId(delegation.from, id);
        mapping.set(id, to);
        return prefix === undefined ? to : `${prefix}/${to}`;
    };
    const lines = delegation.brief.split("\n");
    const patch = patchLines(lines);
    const brief = lines
        .map((line, index) => (patch[index] === true ? line : line.replace(BRIEF_TASK_ID, rewrite)))
        .join("\n");
    const own = [...mapping].filter(([, to]) => to === localId);
    const rest = [...mapping].filter(([, to]) => to !== localId);
    const rewrites = [...own, ...rest].map(([id, to]) => `${id} -> ${to}${to === localId ? " (this task)" : ""}`);
    return { brief, rewrites };
}

/**
 * Record a delegation in this machine's backlog, once per delegation id, and once per open piece of work: the same
 * work (delegationKey) from the same delegator while an earlier copy is open (a copy queued for the tick and a retry
 * that went through, or the delegating lead running the command again) returns that task. Returns the task and whether
 * it was new; a new one gets its brief saved and an inbox item that wakes this machine's lead. New ship work for a
 * project this machine marked verify-only (unless verify work, or sent with `--force`) is handed back at once instead,
 * with the reason in `handedBack`: the delegator's `--for` task is queued again.
 */
export function receiveDelegation(delegation: Delegation): { task: Task; created: boolean; handedBack?: string } {
    const project = delegation.project ?? DEFAULT_PROJECT;
    const cloned = existsSync(paths.projectDir(project));
    const key = delegationKey(delegation);
    const self = loadMachine().name;
    // Ship work for a project this machine marked verify-only: handed back below, unless verify work or sent with --force.
    const verifyOnly =
        (delegation.shape ?? "ship") === "ship" &&
        delegation.verify !== true &&
        loadProjects().some((entry) => entry.name === project && entry.role === "verify-only");
    // A chain that comes back here holds this machine's own task, which needs no report from itself.
    const upstream = (delegation.upstream ?? []).filter((entry) => entry.machine !== self);
    const machines = new Set([self, delegation.from, ...loadFleet().machines.map((machine) => machine.name)]);
    const result = updateBacklog((backlog) => {
        const existing =
            backlog.tasks.find((task) => task.delegatedBy?.id === delegation.id) ??
            backlog.tasks.find((task) => sameOpenWork(task, delegation, key));
        if (existing) return { task: { ...existing }, created: false };
        const at = now().toISOString();
        const by = delegation.fromTask === undefined ? delegation.from : `${delegation.from}/${delegation.fromTask}`;
        const id = `T${backlog.nextId}`;
        const { rewrites } = rewriteBriefIds(delegation, id, machines);
        const task: Task = {
            id,
            project,
            title: delegation.title,
            shape: delegation.shape ?? "ship",
            ...(delegation.verify === true ? { verify: true as const } : {}),
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
                ...(rewrites.length === 0
                    ? []
                    : [`brief ids from ${delegation.from} rewritten: ${rewrites.join(", ")}`]),
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
        const reason = `${self} is ${verifyOnlyText(project)} (bin/toli pick --project ${project}); verify work goes with bin/toli delegate --verify`;
        return { task: handBack(result.task.id, reason), created: true, handedBack: reason };
    }
    const { task } = result;
    const briefFile = join(paths.projectBriefsDir(project), `${task.id}.md`);
    if (!existsSync(briefFile))
        writeTextAtomic(briefFile, `${rewriteBriefIds(delegation, task.id, machines).brief.trimEnd()}\n`);
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
            ...(delegation.verify === true
                ? [
                      `- verify work: dispatch a verifier (docs/verify-brief-template.md, \`bin/toli spawn --task ${task.id} --work verify\`)`,
                  ]
                : []),
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
