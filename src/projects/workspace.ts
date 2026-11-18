// Per-project workspace strategy (R16): where a task's jawans work, prepared before the jawan starts.
//
//   same-branch        the project clone, on the project's branch (no git changes)
//   branch-per-task    the project clone, switched to the task branch (`toli/<machine>/<T-id>-<slug>` unless the
//                      project sets its own `--task-branch` pattern); refused while another active task of the
//                      project holds the clone on a different branch
//   worktree-per-task  `git worktree add projects/.worktrees/<project>/<T-id> -b <task branch> <base>`
//
// The prepared workspace is recorded on the task (`workspace` in data/backlog.json), so the verifier, `bin/toli
// commit|push|pr --task` and `bin/toli workspace list|prune` (src/projects/workspace-command.ts) find it again.
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { loadMachine } from "../core/config.ts";
import { currentBranch, git, gitOk, isGitRepo } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { persona } from "../core/persona.ts";
import { run, ToliError, warn, withLock } from "../core/util.ts";
import { loadBacklog, type Task, type TaskWorkspace, updateTask } from "../records/backlog.ts";
import { excludeFromIndexing } from "./indexing.ts";
import { findProject, type Project, projectCloneDir } from "./projects.ts";
import { DEFAULT_TASK_BRANCH, perTask } from "./strategy.ts";

const SLUG_MAX = 40;
/** Statuses whose jawans may still be using the workspace. */
const LIVE: readonly Task["status"][] = ["active", "held"];

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

export function refExists(dir: string, ref: string): boolean {
    return git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).code === 0;
}

/** The branch task branches start from and PR/MRs target: the project's `branch`, else origin's default branch. */
export function baseBranch(project: Project, clone: string): string {
    if (project.branch) return project.branch;
    const originHead = git(clone, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    if (originHead.code === 0) return originHead.stdout.trim().replace(/^origin\//, "");
    const head = currentBranch(clone);
    if (head !== null && !head.startsWith("toli/")) return head;
    throw new ToliError(
        `cannot tell the base branch of ${project.name}: set it with bin/toli project set ${project.name} --branch <b>`,
    );
}

/**
 * Start point for a new task branch: origin's base branch, fetched first, so a task starts from what the fleet has
 * pushed even when this clone's own base branch is behind; the local base branch only when origin has none (no
 * remote, offline before its first fetch).
 */
function baseRef(clone: string, base: string): string {
    const fetched = git(clone, ["fetch", "--quiet", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    if (fetched.code !== 0)
        warn(
            `warning: git fetch origin ${base} failed in ${clone} (${(fetched.stderr || fetched.stdout).trim()}); the task branch starts from the last fetched base`,
        );
    if (refExists(clone, `refs/remotes/origin/${base}`)) return `refs/remotes/origin/${base}`;
    if (refExists(clone, `refs/heads/${base}`)) {
        warn(`warning: origin has no ${base} in ${clone}; the task branch starts from the local ${base}`);
        return `refs/heads/${base}`;
    }
    throw new ToliError(`base branch ${base} exists neither locally nor on origin in ${clone}`);
}

/** `git status --porcelain` of a checkout: "" when clean. */
export function dirty(dir: string): string {
    return gitOk(dir, ["status", "--porcelain"]);
}

export function samePath(a: string, b: string): boolean {
    return existsSync(a) && existsSync(b) && realpathSync(a) === realpathSync(b);
}

/** Worktrees registered in the clone, the main checkout first: path and checked-out branch (null when detached). */
export function gitWorktrees(clone: string): { path: string; branch: string | null }[] {
    const entries: { path: string; branch: string | null }[] = [];
    for (const block of gitOk(clone, ["worktree", "list", "--porcelain"]).split("\n\n")) {
        const path = /^worktree (.+)$/m.exec(block)?.[1];
        if (path === undefined) continue;
        entries.push({ path, branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null });
    }
    return entries;
}

/** Live tasks of the project (but `except`) whose recorded workspace is `clone` on a branch other than `branch`. */
export function cloneHolders(project: string, clone: string, branch: string, except?: string): Task[] {
    return loadBacklog().tasks.filter(
        (other) =>
            other.id !== except &&
            other.project === project &&
            LIVE.includes(other.status) &&
            other.workspace !== undefined &&
            samePath(other.workspace.path, clone) &&
            other.workspace.branch !== branch,
    );
}

/** `T1 (active) is using it on <branch>, ...` for cloneHolders' result. */
export function holdersText(holders: Task[]): string {
    return holders
        .map((other) => `${other.id} (${other.status}) is using it on ${other.workspace?.branch ?? "its branch"}`)
        .join(", ");
}

function prepareBranch(project: Project, task: Task, clone: string): TaskWorkspace {
    const base = task.workspace?.base ?? baseBranch(project, clone);
    const branch = task.workspace?.branch ?? taskBranch(task, project);
    const workspace: TaskWorkspace = { strategy: "branch-per-task", path: clone, branch, base };
    const head = currentBranch(clone);
    if (head === branch) return workspace;
    const holders = cloneHolders(project.name, clone, branch, task.id);
    if (holders.length > 0)
        throw new ToliError(
            `refusing to switch projects/${project.name} to ${branch}: ${holdersText(holders)}. ` +
                `Wait for that task to land, or let parallel tasks share the clone: ` +
                `bin/toli project set ${project.name} --workspace same-branch (on ${persona().user}'s word).`,
        );
    const changes = dirty(clone);
    if (changes !== "")
        throw new ToliError(
            `refusing to switch projects/${project.name} to ${branch}: the clone has uncommitted changes that would ` +
                `move with it:\n${changes}\nLand or ask about them first; never stash or discard them.`,
        );
    const result = refExists(clone, `refs/heads/${branch}`)
        ? git(clone, ["switch", branch])
        : git(clone, ["switch", "--no-track", "-c", branch, baseRef(clone, base)]);
    if (result.code !== 0)
        throw new ToliError(`git switch ${branch} failed in ${clone}: ${(result.stderr || result.stdout).trim()}`);
    return workspace;
}

function prepareWorktree(project: Project, task: Task, clone: string): TaskWorkspace {
    const base = task.workspace?.base ?? baseBranch(project, clone);
    const branch = task.workspace?.branch ?? taskBranch(task, project);
    const path = paths.taskWorktree(project.name, task.id);
    const workspace: TaskWorkspace = { strategy: "worktree-per-task", path, branch, base };
    if (existsSync(path)) {
        const registered = gitWorktrees(clone).find((entry) => samePath(entry.path, path));
        if (registered === undefined)
            throw new ToliError(
                `${path} exists but is not a worktree of projects/${project.name}; move it aside first`,
            );
        if (registered.branch !== branch)
            throw new ToliError(
                `${path} is on ${registered.branch ?? "a detached HEAD"}, not ${branch}; ask what to do`,
            );
        return workspace;
    }
    mkdirSync(dirname(path), { recursive: true });
    // The folder holding the project's worktrees sits outside every checkout, so marking it keeps git status clean.
    excludeFromIndexing(dirname(path));
    const result = refExists(clone, `refs/heads/${branch}`)
        ? git(clone, ["worktree", "add", path, branch])
        : git(clone, ["worktree", "add", "--no-track", "-b", branch, path, baseRef(clone, base)]);
    if (result.code !== 0)
        throw new ToliError(`git worktree add ${path} failed: ${(result.stderr || result.stdout).trim()}`);
    return workspace;
}

/** Whether `branch` names task `id` as a whole token (`shop/m1/T375-e2e`, `t375`, never `T3750`). */
function namesTask(branch: string, id: string): boolean {
    return new RegExp(`(^|[^a-z0-9])${id}($|[^0-9])`, "i").test(branch);
}

/**
 * The clone as the workspace of a live task that has none recorded (dispatched before its project moved to a per-task
 * strategy) while the clone is checked out on a branch naming the task and no other live task records the clone: its
 * work is there, so it lands from there. Null otherwise.
 */
function cloneOfLiveTask(project: Project, task: Task, clone: string): TaskWorkspace | null {
    if (task.workspace !== undefined || !LIVE.includes(task.status) || !perTask(project.workspace)) return null;
    const head = currentBranch(clone);
    if (head === null || !namesTask(head, task.id)) return null;
    if (cloneHolders(project.name, clone, head, task.id).length > 0) return null;
    return { strategy: "branch-per-task", path: clone, branch: head, base: baseBranch(project, clone) };
}

/**
 * Prepare (idempotently) and record the workspace of a task per its project's strategy; returns where its jawans
 * work. Serialized per project so two spawns cannot both switch the shared clone. A live task prepared under another
 * strategy keeps the workspace it has (its work, maybe uncommitted, is there): switching a project's strategy
 * applies to tasks prepared afterwards.
 */
export function prepareWorkspace(taskId: string): TaskWorkspace {
    const id = taskId.toUpperCase();
    const found = loadBacklog().tasks.find((entry) => entry.id === id);
    if (!found) throw new ToliError(`unknown task "${taskId}" (see \`bin/toli task list\`)`);
    const project = findProject(found.project);
    const clone = projectCloneDir(project.name);
    return withLock(paths.lock(`workspace-${project.name}`), () => {
        const task = loadBacklog().tasks.find((entry) => entry.id === id) ?? found;
        const recorded = task.workspace;
        if (
            recorded !== undefined &&
            recorded.strategy !== project.workspace &&
            LIVE.includes(task.status) &&
            existsSync(recorded.path)
        )
            return recorded;
        const workspace: TaskWorkspace =
            cloneOfLiveTask(project, task, clone) ??
            (project.workspace === "branch-per-task"
                ? prepareBranch(project, task, clone)
                : project.workspace === "worktree-per-task"
                  ? prepareWorktree(project, task, clone)
                  : {
                        strategy: "same-branch",
                        path: clone,
                        branch: project.branch ?? currentBranch(clone),
                        base: null,
                    });
        updateTask(id, (entry) => {
            entry.workspace = workspace;
        });
        return workspace;
    });
}

/** Markdown block spawn appends to a brief so the jawan works where the workspace was prepared. */
export function workspaceBrief(project: string, taskId: string, workspace: TaskWorkspace): string {
    const commit = perTask(workspace.strategy)
        ? `bin/toli commit ${project} --task ${taskId} -m "<message>" -- <paths...>`
        : `bin/toli commit ${project} -m "<message>" -- <paths...>`;
    return [
        "",
        "## Workspace (prepared by bin/toli spawn)",
        "",
        `- Strategy: ${workspace.strategy}`,
        `- Path: ${workspace.path} - work and run the project's commands here, not in any other checkout`,
        `- Branch: ${workspace.branch ?? "the checked-out branch"}${workspace.base === null ? "" : `, from ${workspace.base}`} - stay on it`,
        `- Commit (only where the Landing section allows it): ${commit}`,
        "",
    ].join("\n");
}

/** The task id of the project's task worktree that contains `cwd`, or null outside every task worktree. */
function taskFromCwd(project: string, cwd: string): string | null {
    const root = paths.worktreesDir(project);
    if (!existsSync(root) || !existsSync(cwd)) return null;
    const inside = relative(realpathSync(root), realpathSync(cwd));
    if (inside === "" || inside.startsWith("..") || inside.startsWith(sep)) return null;
    return inside.split(sep)[0] ?? null;
}

/**
 * The checkout `bin/toli commit|push|pr` acts on: the workspace of `--task` (or of the task worktree `cwd` is in),
 * else the project clone. `branch`: the branch the checkout must be on, when the task's workspace names one.
 */
export function workDir(
    projectName: string,
    taskId: string | undefined,
    cwd: string = process.cwd(),
): { dir: string; task: Task | null; branch: string | null } {
    const project = findProject(projectName);
    const id = taskId?.toUpperCase() ?? taskFromCwd(project.name, resolve(cwd));
    if (id === null) return { dir: projectCloneDir(project.name), task: null, branch: null };
    const task = loadBacklog().tasks.find((entry) => entry.id === id);
    if (!task) throw new ToliError(`unknown task "${id}" (see \`bin/toli task list\`)`);
    if (task.project !== project.name)
        throw new ToliError(`${task.id} belongs to project ${task.project}, not ${project.name}`);
    if (task.workspace === undefined) {
        const adopted = adoptClone(project, task.id);
        if (adopted === null) return { dir: projectCloneDir(project.name), task, branch: null };
        return { dir: adopted.path, task, branch: perTask(adopted.strategy) ? adopted.branch : null };
    }
    if (!isGitRepo(task.workspace.path))
        throw new ToliError(
            `${task.id}'s workspace ${task.workspace.path} is gone (bin/toli workspace prepare ${task.id})`,
        );
    return {
        dir: task.workspace.path,
        task,
        branch: perTask(task.workspace.strategy) ? task.workspace.branch : null,
    };
}

/** Record the clone as the workspace of live task `id` when cloneOfLiveTask says its work is there; null otherwise. */
function adoptClone(project: Project, id: string): TaskWorkspace | null {
    const clone = projectCloneDir(project.name);
    return withLock(paths.lock(`workspace-${project.name}`), () => {
        const task = loadBacklog().tasks.find((entry) => entry.id === id);
        if (task === undefined) return null;
        if (task.workspace !== undefined) return task.workspace;
        const adopted = cloneOfLiveTask(project, task, clone);
        if (adopted !== null)
            updateTask(id, (entry) => {
                entry.workspace = adopted;
            });
        return adopted;
    });
}
