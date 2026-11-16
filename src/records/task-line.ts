// One task as the line `bin/toli task list` and every task write print.
import type { Task } from "./backlog.ts";

export function describeTask(task: Task): string {
    const extras: string[] = [];
    if (task.status === "held" && task.question) extras.push(`question: ${task.question}`);
    if (task.agent) extras.push(`agent: ${task.agent}`);
    if (task.waitingOn !== undefined) extras.push(`waiting on: ${task.waitingOn}`);
    if (task.pinned !== undefined) extras.push(task.pinned === "" ? "pinned" : `pinned: ${task.pinned}`);
    if (task.commit) extras.push(`commit: ${task.commit}`);
    if (task.report) extras.push(`report: ${task.report}`);
    if (task.delegatedBy)
        extras.push(
            `delegated by ${task.delegatedBy.machine}${task.delegatedBy.task ? `/${task.delegatedBy.task}` : ""}`,
        );
    if (task.delegatedTo?.length) extras.push(`delegated to ${task.delegatedTo.join(", ")}`);
    return `${task.id}\t${task.status}\t${task.project}\t${task.shape}\t${task.title}${extras.length ? `\t(${extras.join("; ")})` : ""}`;
}
