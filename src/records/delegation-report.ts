// A delegated task reports to the machine that delegated it (docs/sardars.md): whenever its owner marks it done,
// held or dropped, the owner sends `<owner>/T<n> <status>: <title>` to the delegating machine's inbox, which wakes
// that machine's lead. Delivery goes through the outbox, so an unreachable delegator gets it from the minute tick.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { loadFleet, loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, stamp, warn } from "../core/util.ts";
import { sendToMachine } from "../jobs/outbox.ts";
import type { Status, Task } from "./backlog.ts";

/** The statuses a delegator hears about: the task finished, needs the user, or was given up. */
const REPORTED: readonly Status[] = ["done", "held", "dropped"];
const REPORT_LIMIT = 4000;

/** `<machine>/T<n>`: a task id unique across the fleet. */
export function fleetId(machine: string, id: string): string {
    return `${machine}/${id}`;
}

/** Split `<machine>/T<n>` into its owner and local id; a bare `T<n>` has no owner (this machine's). */
export function splitFleetId(id: string): { machine: string | null; id: string } {
    const slash = id.indexOf("/");
    if (slash < 0) return { machine: null, id: id.toUpperCase() };
    return { machine: id.slice(0, slash), id: id.slice(slash + 1).toUpperCase() };
}

/** Whether a change from `before` to `after` is one the delegator must hear about. */
export function reportDue(before: Task, after: Task): boolean {
    if (after.delegatedBy === undefined || !REPORTED.includes(after.status)) return false;
    return before.status !== after.status || (after.status === "held" && before.question !== after.question);
}

function reportText(task: Task): string | null {
    if (task.report === undefined) return null;
    const path = isAbsolute(task.report) ? task.report : join(paths.root(), task.report);
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8").trimEnd();
    return text.length <= REPORT_LIMIT
        ? text
        : `${text.slice(0, REPORT_LIMIT)}\n[... truncated; full report on the owner]`;
}

/** The inbox message the delegator gets for `task` as it is now. */
export function delegationReport(owner: string, task: Task): { title: string; body: string } {
    const id = fleetId(owner, task.id);
    const by = task.delegatedBy;
    const lines = [
        `- task: ${id} (${task.status}), owned by ${owner}`,
        ...(by?.task === undefined ? [] : [`- for: ${by.task} on ${by.machine}`]),
        ...(task.commit === undefined ? [] : [`- commit: ${task.commit}`]),
        ...(task.report === undefined ? [] : [`- report (on ${owner}): ${task.report}`]),
    ];
    if (task.status === "held") {
        lines.push("", "## Question for the user", "", task.question ?? "");
        for (const [index, option] of (task.options ?? []).entries())
            lines.push(`${index + 1}. ${option.choice} => ${option.outcome}`);
        if (task.recommend !== undefined) lines.push(`Recommended: ${task.recommend}`);
        if (task.blocks !== undefined) lines.push(`Blocks: ${task.blocks}`);
        lines.push(
            "",
            `Record the user's answer with \`bin/toli task answer ${id} "<his words>"\` (it goes to ${owner}).`,
        );
    }
    const notes = task.notes.slice(-3);
    if (notes.length > 0) lines.push("", "## Latest notes", "", ...notes.map((note) => `- ${note}`));
    const report = reportText(task);
    if (report !== null) lines.push("", "## Report", "", report);
    return { title: `${id} ${task.status}: ${task.title}`, body: lines.join("\n") };
}

/** Send the report for `task` to its delegator; a failure is a warning (the outbox keeps it for the tick). */
export function reportToDelegator(task: Task): void {
    const by = task.delegatedBy;
    if (by === undefined) return;
    const owner = loadMachine().name;
    const target = loadFleet().machines.find((entry) => entry.name === by.machine);
    if (target === undefined) {
        warn(`${task.id}: delegator ${by.machine} is not in config/fleet.json; its report was not sent`);
        return;
    }
    const { title, body } = delegationReport(owner, task);
    const sent = sendToMachine(owner, target, title, body, `report-${task.id}-${task.status}-${stamp(now())}`);
    if (!sent.delivered) warn(`${task.id}: report to ${by.machine} queued (${sent.error}); the minute tick retries`);
}
