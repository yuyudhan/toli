// The base a per-task strategy's task branches start from (src/projects/workspace.ts): which branch, and which ref of
// it, fetched from origin first (docs/projects.md "Workspace strategy").
import { git } from "../core/git.ts";
import { ToliError, warn } from "../core/util.ts";
import type { Project } from "./projects.ts";

export function refExists(dir: string, ref: string): boolean {
    return git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).code === 0;
}

/**
 * The branch task branches start from and PR/MRs target: the project's `baseBranch`, else its `branch`, else origin's
 * default branch. Never the branch the clone happens to be checked out on.
 */
export function baseBranch(project: Project, clone: string): string {
    if (project.baseBranch) return project.baseBranch;
    if (project.branch) return project.branch;
    const base = originDefault(clone);
    if (base !== null) return base;
    throw new ToliError(
        `cannot tell the base branch of ${project.name}: set it with bin/toli project set ${project.name} --base-branch <b>`,
    );
}

/**
 * Origin's default branch: origin/HEAD, asking origin when the clone has no record of it (`git remote set-head
 * --auto`), else `main` or `master` as origin has it, else as the clone has it (no remote); null when none exists.
 */
function originDefault(clone: string): string | null {
    const originHead = ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"];
    let head = git(clone, originHead);
    if (head.code !== 0 && git(clone, ["remote", "set-head", "origin", "--auto"]).code === 0)
        head = git(clone, originHead);
    if (head.code === 0) return head.stdout.trim().replace(/^origin\//, "");
    for (const prefix of ["refs/remotes/origin/", "refs/heads/"])
        for (const name of ["main", "master"]) if (refExists(clone, `${prefix}${name}`)) return name;
    return null;
}

/**
 * Start point for a new task branch: origin's base branch, fetched first, so a task starts from what the fleet has
 * pushed even when this clone's own base branch is behind; the local base branch only when origin has none (no
 * remote, offline before its first fetch).
 */
export function baseRef(clone: string, base: string): string {
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
