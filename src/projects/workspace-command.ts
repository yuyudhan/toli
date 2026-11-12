// `bin/toli workspace prepare|list|prune`: the CLI over src/projects/workspace.ts. `prune` removes finished task
// worktrees and never one that holds unlanded work (uncommitted or untracked files, or commits on no base ref).
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { Args } from "../core/args.ts";
import { git, isGitRepo } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { out, printJson, run, ToliError } from "../core/util.ts";
import { loadBacklog, type Task } from "../records/backlog.ts";
import { findProject, loadProjects } from "./projects.ts";
import { gitWorktrees, prepareWorkspace, refExists } from "./workspace.ts";

const FETCH_TIMEOUT_MS = 60_000;

export type WorktreeEntry = {
    project: string;
    task: string;
    status: Task["status"] | "unknown";
    path: string;
    branch: string | null;
    base: string | null;
    /** The worktree's checked-out commit; null when it has none (missing or broken worktree). */
    head: string | null;
    /** Commits reachable from the worktree's HEAD but from no base ref (local or origin); null when unknowable. */
    unmerged: number | null;
    /** Changed and untracked, non-ignored files (`git status --porcelain --untracked-files=all` entries). */
    dirtyFiles: number;
};

/** Commits reachable from `head` but from neither the local nor the origin `base` branch; null without either ref. */
function unmergedCount(clone: string, head: string, base: string): number | null {
    const bases = [`refs/heads/${base}`, `refs/remotes/origin/${base}`].filter((ref) => refExists(clone, ref));
    if (bases.length === 0) return null;
    const counted = git(clone, ["rev-list", "--count", head, "--not", ...bases]);
    return counted.code === 0 ? Number(counted.stdout.trim()) : null;
}

/** Changed and untracked, non-ignored files in a worktree; -1 when git cannot read it (treated as unlanded). */
function dirtyFileCount(worktree: string): number {
    if (!existsSync(worktree)) return 0;
    const status = git(worktree, ["status", "--porcelain", "--untracked-files=all"]);
    if (status.code !== 0) return -1;
    return status.stdout.split("\n").filter((line) => line !== "").length;
}

function worktreeEntries(projectFilter: string | undefined): WorktreeEntry[] {
    const projects = projectFilter === undefined ? loadProjects() : [findProject(projectFilter)];
    const tasks = new Map(loadBacklog().tasks.map((task) => [task.id, task]));
    const entries: WorktreeEntry[] = [];
    for (const project of projects) {
        const clone = paths.projectDir(project.name);
        const root = paths.worktreesDir(project.name);
        if (!isGitRepo(clone) || !existsSync(root)) continue;
        const realRoot = realpathSync(root);
        for (const worktree of gitWorktrees(clone)) {
            if (dirname(worktree.path) !== realRoot && dirname(worktree.path) !== root) continue;
            const id = basename(worktree.path);
            const task = tasks.get(id);
            const base = task?.workspace?.base ?? null;
            const head = existsSync(worktree.path) ? git(worktree.path, ["rev-parse", "--verify", "HEAD"]) : null;
            const sha = head !== null && head.code === 0 ? head.stdout.trim() : null;
            entries.push({
                project: project.name,
                task: id,
                status: task?.status ?? "unknown",
                path: join(root, id),
                branch: worktree.branch,
                base,
                head: sha,
                unmerged: sha === null || base === null ? null : unmergedCount(clone, sha, base),
                dirtyFiles: dirtyFileCount(worktree.path),
            });
        }
    }
    return entries;
}

function entryLine(entry: WorktreeEntry): string {
    const merged =
        entry.unmerged === null ? "merged: unknown" : entry.unmerged === 0 ? "merged" : `unmerged ${entry.unmerged}`;
    return [
        `${entry.project}/${entry.task}`,
        entry.status,
        entry.branch ?? "(detached)",
        entry.base === null ? "base ?" : `base ${entry.base}`,
        merged,
        entry.dirtyFiles === 0 ? "clean" : "dirty",
        relative(paths.root(), entry.path),
    ].join("\t");
}

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The unlanded work in a worktree, or null when it has none: uncommitted or untracked files, or commits no base ref
 * (local or origin) contains. Unknown counts (no base ref, unreadable status) count as unlanded, never as clean.
 */
function unlandedWork(entry: WorktreeEntry): string | null {
    if (entry.unmerged === 0 && entry.dirtyFiles === 0) return null;
    const commits =
        entry.unmerged === null
            ? `unknown unlanded commits (${entry.base === null ? "no recorded base branch" : `no ${entry.base} ref`})`
            : plural(entry.unmerged, "unlanded commit");
    const files = entry.dirtyFiles < 0 ? "unreadable git status" : plural(entry.dirtyFiles, "dirty file");
    return `${relative(paths.root(), entry.path)}: ${commits} / ${files}`;
}

/** One prune outcome: `fields` for --json, `text` for the terminal. */
type PruneResult = { fields: string[]; text: string };

function pruneResult(...fields: string[]): PruneResult {
    return { fields, text: fields.join("\t") };
}

/** Remove one worktree that `pruneOne` found finished and free of unlanded work, then its branch at that tip only. */
function removeWorktree(entry: WorktreeEntry, head: string): PruneResult {
    const id = `${entry.project}/${entry.task}`;
    const clone = paths.projectDir(entry.project);
    // No --force: git itself refuses a worktree that gained changes or untracked files since the check.
    const removed = git(clone, ["worktree", "remove", entry.path]);
    if (removed.code !== 0)
        return pruneResult("kept", id, `git worktree remove failed: ${(removed.stderr || removed.stdout).trim()}`);
    if (entry.branch === null) return pruneResult("removed", id);
    // Only at the checked tip: a commit added to the branch meanwhile keeps it.
    const deleted = git(clone, ["update-ref", "-d", `refs/heads/${entry.branch}`, head]);
    return pruneResult(
        "removed",
        id,
        deleted.code === 0
            ? `branch ${entry.branch} deleted (was ${head.slice(0, 12)})`
            : `branch ${entry.branch} kept: ${(deleted.stderr || deleted.stdout).trim()}`,
    );
}

/** Prune one worktree: only a done/dropped task's, and never one holding unlanded work (no flag skips this). */
function pruneOne(entry: WorktreeEntry): PruneResult {
    const id = `${entry.project}/${entry.task}`;
    if (entry.status !== "done" && entry.status !== "dropped")
        return pruneResult(
            "kept",
            id,
            entry.status === "unknown" ? "no task with this id in the backlog" : `task is ${entry.status}`,
        );
    if (entry.head === null) return pruneResult("kept", id, "no checked-out commit to check");
    const unlanded = unlandedWork(entry);
    if (unlanded !== null) return { fields: ["kept", id, unlanded], text: `kept: ${unlanded}` };
    return removeWorktree(entry, entry.head);
}

/** Refresh origin's view of each base branch (best effort, bounded) so merges done on the forge count. */
function fetchBases(entries: WorktreeEntry[]): void {
    const seen = new Set<string>();
    for (const entry of entries) {
        if (entry.base === null || seen.has(`${entry.project}\0${entry.base}`)) continue;
        seen.add(`${entry.project}\0${entry.base}`);
        run(["git", "-C", paths.projectDir(entry.project), "fetch", "--quiet", "origin", entry.base], {
            timeoutMs: FETCH_TIMEOUT_MS,
        });
    }
}

function listCommand(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json"], values: ["project"] });
    args.maxPositional(0);
    const entries = worktreeEntries(args.str("project"));
    if (args.bool("json")) printJson(entries);
    else out(entries.length === 0 ? "no task worktrees" : entries.map(entryLine).join("\n"));
}

function pruneCommand(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json"], values: ["project"] });
    args.maxPositional(0);
    const project = args.str("project");
    fetchBases(worktreeEntries(project));
    const results = worktreeEntries(project).map(pruneOne);
    if (args.bool("json")) printJson(results.map((result) => result.fields));
    else out(results.length === 0 ? "no task worktrees" : results.map((result) => result.text).join("\n"));
}

function prepareCommand(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(1);
    const workspace = prepareWorkspace(args.pos(0, "task id"));
    if (args.bool("json")) printJson(workspace);
    else
        out(
            `${workspace.strategy}: ${workspace.path} on ${workspace.branch ?? "(detached)"}${workspace.base === null ? "" : ` from ${workspace.base}`}`,
        );
}

/** `toli workspace prepare <T-id> [--json]` | `list [--project p] [--json]` | `prune [--project p] [--json]`. */
export function workspaceCommand(argv: string[]): void {
    const [sub, ...rest] = argv;
    if (sub === "prepare") prepareCommand(rest);
    else if (sub === "list") listCommand(rest);
    else if (sub === "prune") pruneCommand(rest);
    else throw new ToliError("usage: toli workspace prepare <T-id> | list [--project p] | prune [--project p]");
}
