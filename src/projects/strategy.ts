// Per-project workspace strategy and standing grants (R16): the values, their validation and defaults.
import { machineSettings } from "../core/config.ts";
import { ToliError } from "../core/util.ts";
import type { Mode } from "./projects.ts";
/**
 * Where jawans work (R16). `same-branch`: the one clone, on the project's branch. `branch-per-task`: the one clone,
 * switched to a task branch per task. `worktree-per-task`: a git worktree per task under
 * projects/.worktrees/<project>/<T-id> on its own task branch. Per-task strategies land the task branch: through a
 * PR/MR (`pr`, `no-mistakes`), or pushed for the machine that cuts releases to merge (`commit`).
 */
export const WORKSPACES = ["same-branch", "branch-per-task", "worktree-per-task"] as const;
export type Workspace = (typeof WORKSPACES)[number];

/** Standing permission the user granted explicitly for this project: push task branches, open PR/MRs. */
export type Standing = { push: boolean; pr: boolean };

export function isWorkspace(value: unknown): value is Workspace {
    return typeof value === "string" && (WORKSPACES as readonly string[]).includes(value);
}

export function parseWorkspace(value: string, flag = "--workspace"): Workspace {
    if (!isWorkspace(value)) throw new ToliError(`${flag} must be one of ${WORKSPACES.join(", ")}, got "${value}"`);
    return value;
}

/** Whether tasks get their own branch. */
export function perTask(workspace: Workspace): boolean {
    return workspace !== "same-branch";
}

/**
 * The default task branch: task ids are numbered per machine, so two machines working one project each have a
 * `T12`; the machine part keeps their branches apart on the shared origin.
 */
export const DEFAULT_TASK_BRANCH = "toli/<machine>/<id>-<slug>";
const TASK_BRANCH_PARTS = ["project", "machine", "id", "slug"] as const;

/**
 * `project set --task-branch`: a pattern of `<project>`, `<machine>`, `<id>` (required: it keeps one task's branch
 * apart from another's) and `<slug>` around literal text; `none` (null) goes back to DEFAULT_TASK_BRANCH.
 */
export function parseTaskBranchPattern(value: string | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === "none") return null;
    const unknown = [...value.matchAll(/<([^>]*)>/g)]
        .map((match) => match[1] ?? "")
        .filter((part) => !(TASK_BRANCH_PARTS as readonly string[]).includes(part));
    if (unknown.length > 0)
        throw new ToliError(
            `--task-branch knows <${TASK_BRANCH_PARTS.join(">, <")}>, not <${unknown.join(">, <")}> (got "${value}")`,
        );
    if (!value.includes("<id>"))
        throw new ToliError(`--task-branch must contain <id>, so each task gets its own branch (got "${value}")`);
    return value;
}

/** The strategy a pre-R16 project already followed: a work branch per change in `pr` / branchless gate mode. */
export function legacyWorkspace(project: { mode: Mode; branch?: string | undefined }): Workspace {
    return project.mode === "pr" || (project.mode === "no-mistakes" && !project.branch)
        ? "branch-per-task"
        : "same-branch";
}

/** `defaults.workspace` in config/machine.json (asked during "set up toli"); same-branch when unset. */
export function machineDefaultWorkspace(): Workspace {
    const value = machineSettings().defaults?.workspace;
    return value === undefined ? "same-branch" : parseWorkspace(value, "config/machine.json defaults.workspace");
}

/** `push+pr`, `push`, or `none`. */
export function standingText(standing: Standing | undefined): string {
    const granted = [...(standing?.push ? ["push"] : []), ...(standing?.pr ? ["pr"] : [])];
    return granted.length === 0 ? "none" : granted.join("+");
}
