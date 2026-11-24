// A task's own branch under a per-task workspace strategy (src/projects/workspace.ts): its name, derived from the
// project's `--task-branch` pattern, and a rename of it in the task's workspace (`git branch -m`, to the project's own
// naming), which toli follows so that `bin/toli commit|push|pr --task` act on one branch and refuse any other.
import { loadMachine } from "../core/config.ts";
import { currentBranch, git } from "../core/git.ts";
import { addressName } from "../core/persona.ts";
import { run, ToliError } from "../core/util.ts";
import type { Task } from "../records/backlog.ts";
import { refExists } from "./base-branch.ts";
import type { Project } from "./projects.ts";
import { DEFAULT_TASK_BRANCH } from "./strategy.ts";

const SLUG_MAX = 40;

/**
 * A task's branch: the project's `taskBranch` pattern (DEFAULT_TASK_BRANCH when unset) with `<project>`,
 * `<machine>` (this machine's name), `<id>` and `<slug>` (of the title) filled in; a valid branch name.
 */
export function taskBranch(task: Pick<Task, "id" | "title">, project: Pick<Project, "name" | "taskBranch">): string {
    const slug =
        task.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .slice(0, SLUG_MAX)
            .replace(/^-+|-+$/g, "") || "task";
    const parts: Record<string, string> = { project: project.name, machine: loadMachine().name, id: task.id, slug };
    const branch = (project.taskBranch ?? DEFAULT_TASK_BRANCH).replace(
        /<(project|machine|id|slug)>/g,
        (_match, part: string) => parts[part] ?? "",
    );
    if (run(["git", "check-ref-format", "--branch", branch]).code !== 0)
        throw new ToliError(`cannot derive a valid branch name for ${task.id} (got "${branch}")`);
    return branch;
}

/**
 * `recorded`, or the branch `dir` is on when toli can see that it is `recorded` renamed (`git branch -m`, in one step
 * or several): `recorded` no longer exists and the checked-out branch's reflog records a rename from it.
 */
export function followRename(dir: string, recorded: string): string {
    const head = currentBranch(dir);
    if (head === null || head === recorded || refExists(dir, `refs/heads/${recorded}`)) return recorded;
    const log = git(dir, ["reflog", "show", "--format=%gs", `refs/heads/${head}`]);
    const renamed = `Branch: renamed refs/heads/${recorded} to refs/heads/`;
    return log.code === 0 && log.stdout.split("\n").some((line) => line.startsWith(renamed)) ? head : recorded;
}

/**
 * Refuse to commit, push or open a pull request from a task's workspace on another branch than the task's own
 * (`branch`, from workDir in src/projects/workspace.ts), so commit and push always act on the same branch.
 */
export function requireTaskBranch(target: { dir: string; task: Task | null; branch: string | null }): void {
    if (target.branch === null) return;
    const actual = currentBranch(target.dir);
    if (actual === target.branch) return;
    const id = target.task?.id ?? "the task";
    throw new ToliError(
        `refusing: ${target.dir} is on ${actual === null ? "a detached HEAD" : `"${actual}"`}, but ${id}'s branch is ` +
            `"${target.branch}"; commit, push and pr act only on it. Switch back (git -C ${target.dir} switch ` +
            `${target.branch}), or rename the task's branch itself (git -C ${target.dir} branch -m ${target.branch} ` +
            `<name>), which toli follows; else ask ${addressName()}.`,
    );
}
