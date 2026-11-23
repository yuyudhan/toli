// `bin/toli delegate`: hand one task to another machine's lead (docs/sardars.md). The target's
// `bin/toli delegation receive` (src/fleet/delegation-receive.ts) adds it to that machine's own backlog (owned there,
// `delegatedBy` naming this machine), saves the brief, and posts it to that machine's inbox, which wakes its lead; that
// lead dispatches its own jawans. The task's results and questions come back by themselves
// (src/records/delegation-report.ts).
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Args } from "../core/args.ts";
import { type FleetMachine, fleetMachine, loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { out, requireName, stamp, ToliError, warn } from "../core/util.ts";
import { parseOptionalTier } from "../harness/models.ts";
import { type Delivered, queuedText, sendNow } from "../jobs/outbox.ts";
import { queuedItems, sendingItems } from "../jobs/outbox-queue.ts";
import { QUICK_MS } from "../peer/client.ts";
import { bodyLimit, TITLE_MAX } from "../peer/envelope.ts";
import { loadProjects } from "../projects/projects.ts";
import { loadBacklog, updateTask } from "../records/backlog.ts";
import { splitFleetId } from "../records/delegation-report.ts";
import {
    delegatesSlice,
    forwardChain,
    landSending,
    noteSending,
    recordDelegation,
} from "../records/delegation-sync.ts";
import { addInboxItem } from "../records/inbox.ts";
import { parseShape } from "../records/task-shape.ts";
import { DEFAULT_PROJECT, type Delegation, delegationKey, parseDelegation } from "./delegation-receive.ts";
import { probeMachine } from "./fleet-probe.ts";
import { pickMachine, refusesShip } from "./pick.ts";

const ACCEPTED = /^delegation-accepted (\S+) (created|existing)$/m;
/** The receiver's line when it handed a new task back at once (a ship task for a project it marked verify-only). */
const HANDED_BACK = /^delegation-handed-back (.+)$/m;
/** The outbox title of a delegation: the receiver refuses one over TITLE_MAX characters (src/peer/envelope.ts). */
const TITLE_PREFIX = "delegate ";
const DELEGATION_TITLE_MAX = TITLE_MAX - TITLE_PREFIX.length;

/**
 * Record the target's answer to a delivered delegation on the `--for` task (src/records/delegation-sync.ts
 * `recordDelegation`): it counts as active with that id as its jawan, so oversight does not call it stale, and a done
 * or dropped `--for` task (its earlier delegation was given up) is reopened; while the task's own jawan works on it,
 * the delegation is a slice that only reports back. The delegation is no longer `sending`. Returns the fleet id.
 */
export function acceptDelegation(delegation: Delegation, stdout: string): string {
    const accepted = ACCEPTED.exec(stdout);
    if (!accepted) throw new ToliError(`the target did not accept the delegation: ${stdout.trim() || "no output"}`);
    const id = accepted[1] as string;
    const forTask = delegation.fromTask;
    if (forTask !== undefined && loadBacklog().tasks.some((task) => task.id === forTask)) {
        updateTask(forTask, (task) => {
            recordDelegation(task, id, `delegated to ${id}: ${delegation.title}`);
            landSending(task, splitFleetId(id).machine ?? "", delegation.id);
        });
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
    const handedBack = HANDED_BACK.exec(stdout)?.[1];
    const target = item.to?.name ?? "the target";
    addInboxItem(
        delegation.from,
        `delegated ${id}: ${delegation.title}`,
        existing
            ? `The delegation queued for ${target} was already there as ${id} (an earlier copy landed first); no second task was made.`
            : handedBack !== undefined
              ? `The delegation queued for ${target} landed as ${id} and was handed back at once: ${handedBack}`
              : `The delegation queued for ${target} has landed as ${id}.\nIts lead dispatches it; the result comes back here as a wake.`,
    );
}

/**
 * The verify-only check of `target` for ship work on `project`. `refusal`: why the work must not go there (it marked
 * the project verify-only, its `resources`), with the machine `pick` would choose instead; null when it takes the
 * work, or cannot be asked now (its own `delegation receive` then hands the work back). The check and the send share
 * one wait of QUICK_MS: `unanswered` says why the target did not answer in all of it, and the send then only queues.
 */
async function verifyOnlyCheck(
    target: FleetMachine,
    project: string,
): Promise<{ refusal: string | null; unanswered?: string }> {
    const deadline = performance.now() + QUICK_MS;
    const entry = await probeMachine(target, QUICK_MS);
    if (entry.resources === null) {
        if (performance.now() < deadline) return { refusal: null };
        return {
            refusal: null,
            unanswered: `${target.name} gave no answer within ${QUICK_MS / 1000} s (${entry.reasons.join("; ")})`,
        };
    }
    if (!refusesShip(entry.resources, project)) return { refusal: null };
    const pick = await pickMachine(project, "ship");
    const next =
        pick.machine === null
            ? "no other machine qualifies"
            : `next by queue: ${pick.machine}${pick.local ? ", this machine" : ""}`;
    return {
        refusal: [
            `not sent: ${target.name} is verify-only for ${project} (it takes no ship work for it);`,
            `${next} (bin/toli pick --project ${project}); verify work goes with --verify; --force sends it anyway`,
        ].join(" "),
    };
}

/**
 * A delegation of the same work (delegationKey) already waiting in this machine's outbox for `target`: `sending` when
 * a live process is sending it right now (a claim whose process died is back in the queue first,
 * src/jobs/outbox-queue.ts); null when there is none. A lead that runs `delegate` again (the target was unreachable,
 * or a run was killed mid-send) sends that copy instead of queueing another.
 */
function queuedCopy(target: string, key: string): { delegation: Delegation; sending: boolean } | null {
    const copies = [
        ...sendingItems().map(({ item }) => ({ item, sending: true })),
        ...queuedItems().map(({ item }) => ({ item, sending: false })),
    ];
    for (const { item, sending } of copies) {
        if (item.kind !== "delegation" || item.to?.name !== target) continue;
        let delegation: Delegation;
        try {
            delegation = parseDelegation(item.body);
        } catch {
            continue;
        }
        if (delegationKey(delegation) === key) return { delegation, sending };
    }
    return null;
}

/**
 * `delegate <machine> "<title>" --brief <file> [--project p] [--note "..."] [--for T<n>] [--shape s] [--verify]
 * [--tier t] [--force]`. Prints the fleet id, or that the delegation is queued for the tick while the target is
 * unreachable. Ship work (the default shape, or the `--for` task's) for a project the target marked verify-only is
 * refused naming the next machine, unless `--force`; verify work (`--verify`, or a `--for` task that is verify work)
 * goes to it. A `--for` task records the delegation as `sending` until its receipt lands, so the owner's report
 * (a hand-back on arrival) is taken for it even when it comes first.
 */
export async function delegateCommand(argv: string[]): Promise<number> {
    const args = new Args(argv, {
        values: ["brief", "project", "note", "for", "shape", "tier"],
        booleans: ["force", "verify"],
    });
    args.maxPositional(2);
    const targetName = requireName("machine", args.pos(0, "machine"));
    const title = args.pos(1, "title").trim();
    if (title === "") throw new ToliError("delegate needs a task title");
    if (title.length > DELEGATION_TITLE_MAX)
        throw new ToliError(
            `the title is ${title.length} characters; a delegation title takes at most ${DELEGATION_TITLE_MAX} (the receiver refuses longer ones)`,
        );
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
    const forEntry = forTask === undefined ? undefined : loadBacklog().tasks.find((task) => task.id === forTask);
    if (forTask !== undefined && forEntry === undefined)
        throw new ToliError(`unknown task "${forTask}" (--for names this machine's own task)`);
    const upstream = forwardChain(forEntry);
    const slice = delegatesSlice(forEntry);
    const verify = args.bool("verify") || forEntry?.verify === true;
    const shape = parseShape(args.str("shape"), verify ? "ship" : (forEntry?.shape ?? "ship"));
    if (verify && shape !== "ship")
        throw new ToliError("--verify is ship work's check: it goes with --shape ship (or no --shape)");
    const force = args.bool("force");
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
        shape,
        ...(verify ? { verify: true as const } : {}),
        ...(tier === undefined ? {} : { tier }),
        ...(upstream.length === 0 ? {} : { upstream }),
        ...(slice ? { slice: true as const } : {}),
        ...(force ? { force: true as const } : {}),
    };
    const body = JSON.stringify(delegation);
    const size = Buffer.byteLength(body);
    if (size > bodyLimit("delegation"))
        throw new ToliError(
            `the delegation is ${size} bytes; a delegation takes at most ${bodyLimit("delegation")} (the receiver refuses larger ones): shorten the brief`,
        );
    let unanswered: string | undefined;
    if (shape === "ship" && !verify && !force) {
        const check = await verifyOnlyCheck(target, project ?? DEFAULT_PROJECT);
        if (check.refusal !== null) throw new ToliError(check.refusal);
        unanswered = check.unanswered;
    }
    const earlier = queuedCopy(target.name, delegationKey(delegation));
    if (earlier?.sending === true) {
        out(
            `already queued for ${target.name} (${earlier.delegation.id}) and being sent now: its task id arrives here as a wake; do not delegate it again`,
        );
        return 0;
    }
    // The same work already queued goes now as that copy, under its id: never a second one for the target to receive.
    const sending = earlier?.delegation ?? delegation;
    const outboxId = `delegation-${sending.id}`;
    if (earlier !== null) rmSync(join(paths.outboxDir(), `${outboxId}.json`), { force: true });
    if (forTask !== undefined) updateTask(forTask, (task) => noteSending(task, target.name, sending.id));
    const sent = sendNow(
        self,
        target,
        "delegation",
        `${TITLE_PREFIX}${sending.title}`,
        JSON.stringify(sending),
        outboxId,
        unanswered,
    );
    if (!sent.delivered) {
        // A refusal is final and the item already sits in state/outbox/cancelled/: nothing is queued to retry.
        if (sent.refused !== undefined) {
            if (forTask !== undefined) updateTask(forTask, (task) => landSending(task, target.name, sending.id));
            throw new ToliError(queuedText(target.name, sent));
        }
        if (!sent.pulled) warn(sent.error);
        if (earlier !== null) {
            out(
                `already queued for ${target.name} (${sending.id}): that copy goes when it can, and its task id arrives here as a wake; do not delegate it again`,
            );
            return 0;
        }
        out(
            sent.pulled
                ? `${queuedText(target.name, sent)}; its task id arrives here as a wake (${sending.id}); do not delegate it again`
                : `queued: ${target.name} is unreachable; the minute tick retries, and its task id arrives here as a wake (${sending.id}); do not delegate it again`,
        );
        return 0;
    }
    const id = acceptDelegation(sending, sent.stdout);
    const existing = ACCEPTED.exec(sent.stdout)?.[2] === "existing";
    const handedBack = HANDED_BACK.exec(sent.stdout)?.[1];
    if (handedBack !== undefined) {
        out(
            `${target.name} handed ${id} back at once: ${handedBack}${forTask === undefined ? "" : `; ${forTask} stays queued here`}`,
        );
        return 1;
    }
    out(
        `delegated to ${id}${forTask === undefined ? "" : ` (for ${forTask})`}: ${target.name}'s lead dispatches it${existing ? " (it was already there: no second task was made)" : ""}`,
    );
    return 0;
}
