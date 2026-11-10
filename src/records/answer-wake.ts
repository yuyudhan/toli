// `task answer`'s wake: every task waiting on the answered hold is named, so the lead re-dispatches them together.
import { relative } from "node:path";
import { paths } from "../core/paths.ts";
import type { Task } from "./backlog.ts";
import { addInboxItem } from "./inbox.ts";
import { briefPath, findStaleTasks, fromName, mentions, type StaleTask } from "./stale.ts";

/** A task waiting on an answered hold, and why toli thinks so. */
export type WaitingTask = { id: string; project: string; status: string; title: string; why: string };

/**
 * Every open task waiting on `answered`: those its hold's `--blocks` names, holds whose question or blocks name it,
 * and its project's stale active tasks (their run ended, maybe on this very question).
 */
export function waitingOn(answered: Task, tasks: Task[], stale: StaleTask[]): WaitingTask[] {
    const open = tasks.filter((task) => task.id !== answered.id && task.status !== "done" && task.status !== "dropped");
    const waiting = new Map<string, WaitingTask>();
    const add = (task: Task, why: string): void => {
        if (!waiting.has(task.id))
            waiting.set(task.id, { id: task.id, project: task.project, status: task.status, title: task.title, why });
    };
    for (const id of answered.blocks?.match(/\bT\d+\b/g) ?? []) {
        const task = open.find((entry) => entry.id === id);
        if (task !== undefined) add(task, `named in ${answered.id}'s blocks`);
    }
    for (const task of open)
        if (mentions(task.question, answered.id) || mentions(task.blocks, answered.id))
            add(task, `its hold names ${answered.id}`);
    for (const entry of stale) {
        const task = open.find((candidate) => candidate.id === entry.id);
        if (task !== undefined && task.project === answered.project) add(task, "active with no live run");
    }
    return [...waiting.values()];
}

/**
 * `task answer`'s wake: every task waiting on `answered` is named with its brief, and the inbox gets the answered
 * task plus those, so the lead re-dispatches all of them in the same turn. Returns the lines to print.
 */
export function answerWake(answered: Task, tasks: Task[]): string[] {
    const waiting = waitingOn(
        answered,
        tasks,
        findStaleTasks(tasks).filter((task) => task.reason !== "waiting"),
    );
    const withBrief = (text: string, project: string, id: string): string => {
        const brief = briefPath(project, id);
        return brief === null ? text : `${text} (brief: ${brief})`;
    };
    const lines =
        waiting.length === 0
            ? [`nothing else waits on ${answered.id}`]
            : waiting.map((task) =>
                  withBrief(
                      `waiting on ${answered.id}: ${task.id} (${task.project}, ${task.status}): ${task.title} - ${task.why}; re-dispatch it now`,
                      task.project,
                      task.id,
                  ),
              );
    const path = addInboxItem(
        fromName(),
        `answer recorded for ${answered.id}: ${waiting.length === 0 ? "dispatch it" : `${waiting.length + 1} tasks to dispatch`}`,
        [
            "Lead: dispatch these in this turn (toli-dispatch skill), with the answer in each brief.",
            "",
            `- ${withBrief(`${answered.id} (${answered.project}, ${answered.status}) answered "${answered.answer ?? ""}": dispatch it now`, answered.project, answered.id)}`,
            ...lines.map((line) => `- ${line}`),
        ].join("\n"),
    );
    return [...lines, `wake posted: ${relative(paths.root(), path)}`];
}
