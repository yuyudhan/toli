// The `task-end` hook: when a task closes (done or dropped), toli runs this machine's own cleaners so the task's
// leftovers (worktrees, temp dirs, test databases, build output) never pile up. toli knows nothing about what is
// left behind; local/hooks/task-end does (docs/helpers.md#hooks).
import { runHook } from "../helpers/local.ts";
import type { Status, Task } from "./backlog.ts";

const CLOSED: readonly Status[] = ["done", "dropped"];

export function isClosed(status: Status): boolean {
    return CLOSED.includes(status);
}

/** Run local/hooks/task-end for a closed task: `$1` root, `$2` task id, `$3` done|dropped, `$4` project. */
export function runTaskEnd(task: Pick<Task, "id" | "status" | "project">): void {
    if (!isClosed(task.status)) return;
    runHook("task-end", [task.id, task.status, task.project]);
}
