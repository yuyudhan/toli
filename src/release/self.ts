// Working on toli itself without touching the checkout that serves the live session.
//
// The live checkout (the main worktree of this repository: the one Sardar's omp, the extension's minute tick and the
// OS ticker run bin/toli from) is never edited by jawans. Each toli task gets its own git worktree:
//
//   bin/toli self prepare T<n>   git worktree add projects/.worktrees/toli/T<n> -b toli/T<n>-<slug> develop
//                                (projects/ is gitignored, so biome, tsc, bun test, gitleaks and grep never walk it)
//   bin/toli self land T<n>      rebase the task branch onto develop, run `just check` in the worktree, fast-forward
//                                develop (in the checkout that has it checked out, normally the live one), remove the
//                                worktree and its branch; refuses on any failure and leaves everything as it was
//
// Feature work lands on `develop`; `main` moves only at a release (`just release`). A clone without a local `develop`
// branch (a fresh contributor clone) lands on the branch the live checkout is on.
// develop changes only by that fast-forward, so it always holds code that passed `just check`.
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Args } from "../core/args.ts";
import { currentBranch, git, gitOk } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { out, printJson, run, runCombined, ToliError } from "../core/util.ts";
import { dirty, gitWorktrees, refExists, samePath, taskBranch } from "../projects/workspace.ts";
import { loadBacklog } from "../records/backlog.ts";
import { DEVELOP_BRANCH } from "./release.ts";

const CHECK = ["just", "check"];
const CHECK_TAIL_LINES = 30;

export type SelfWorktree = { task: string; path: string; branch: string | null; base: string; dirty: boolean };

export type Landed = {
    task: string;
    branch: string;
    base: string;
    commits: number;
    head: string;
    check: string;
    /** The worktree whose checkout was fast-forwarded (normally the live one), or null when only the ref moved. */
    updated: string | null;
};

function taskId(raw: string): string {
    const id = raw.toUpperCase();
    if (!/^T\d+$/.test(id)) throw new ToliError(`invalid task id "${raw}" (expected T<n>)`);
    return id;
}

/** The live checkout: the main worktree of the repository this bin/toli belongs to (also when run from a worktree). */
export function liveCheckout(): string {
    const root = paths.root();
    if (git(root, ["rev-parse", "--git-dir"]).code !== 0)
        throw new ToliError(`${root} is not a git checkout; toli's self worktrees need one`);
    const main = gitWorktrees(root)[0];
    if (main === undefined) throw new ToliError(`git worktree list found no main checkout for ${root}`);
    return main.path;
}

function selfDir(live: string): string {
    return join(live, "projects", ".worktrees", "toli");
}

/** The branch the live checkout is on. */
function liveBranch(live: string): string {
    const branch = currentBranch(live);
    if (branch === null) throw new ToliError(`the live checkout ${live} is on a detached HEAD; check out its branch`);
    return branch;
}

/** What self worktrees start from and land onto: `develop` when it exists, else the live checkout's branch. */
function landingBranch(live: string): string {
    return refExists(live, `refs/heads/${DEVELOP_BRANCH}`) ? DEVELOP_BRANCH : liveBranch(live);
}

function branchFor(id: string): string {
    const task = loadBacklog().tasks.find((entry) => entry.id === id);
    return task === undefined ? `toli/${id}` : taskBranch(task);
}

function registered(live: string, path: string): { path: string; branch: string | null } | undefined {
    return gitWorktrees(live).find((entry) => samePath(entry.path, path));
}

/** Create (idempotently) the worktree of toli task `id` and install its dependencies. */
export function prepareSelf(raw: string): SelfWorktree {
    const id = taskId(raw);
    const live = liveCheckout();
    const base = landingBranch(live);
    const path = join(selfDir(live), id);
    if (existsSync(path)) {
        const entry = registered(live, path);
        if (entry === undefined) throw new ToliError(`${path} exists but is not a worktree of ${live}; move it aside`);
        return { task: id, path, branch: entry.branch, base, dirty: dirty(path) !== "" };
    }
    const branch = branchFor(id);
    mkdirSync(dirname(path), { recursive: true });
    const added = refExists(live, `refs/heads/${branch}`)
        ? git(live, ["worktree", "add", path, branch])
        : git(live, ["worktree", "add", "-b", branch, path, `refs/heads/${base}`]);
    if (added.code !== 0)
        throw new ToliError(`git worktree add ${path} failed: ${(added.stderr || added.stdout).trim()}`);
    if (existsSync(join(path, "package.json"))) {
        const installed = run(["bun", "install", "--frozen-lockfile"], { cwd: path });
        if (installed.code !== 0)
            throw new ToliError(
                `bun install failed in ${path} (the worktree stays; fix and rerun it there): ` +
                    (installed.stderr || installed.stdout).trim(),
            );
    }
    return { task: id, path, branch, base, dirty: false };
}

/** Every worktree under projects/.worktrees/toli/ of the live checkout. */
export function listSelf(): SelfWorktree[] {
    const live = liveCheckout();
    const base = refExists(live, `refs/heads/${DEVELOP_BRANCH}`)
        ? DEVELOP_BRANCH
        : (currentBranch(live) ?? "(detached)");
    const root = selfDir(live);
    return gitWorktrees(live)
        .filter((entry) => samePath(dirname(entry.path), root))
        .map((entry) => ({
            task: basename(entry.path),
            path: entry.path,
            branch: entry.branch,
            base,
            dirty: dirty(entry.path) !== "",
        }));
}

function tail(text: string, lines: number): string {
    return text.trimEnd().split("\n").slice(-lines).join("\n");
}

/**
 * Land toli task `id`: rebase its branch onto the landing branch (develop), run `just check` in its worktree,
 * fast-forward the landing branch, then remove the worktree and branch. Every refusal leaves the branches untouched.
 */
export async function landSelf(raw: string): Promise<Landed> {
    const id = taskId(raw);
    const live = liveCheckout();
    const base = landingBranch(live);
    const path = join(selfDir(live), id);
    const entry = registered(live, path);
    if (entry === undefined) throw new ToliError(`no self worktree for ${id} (bin/toli self prepare ${id})`);
    const branch = entry.branch;
    if (branch === null) throw new ToliError(`${path} is on a detached HEAD; check out its task branch first`);
    if (branch === base)
        throw new ToliError(`refusing to land ${id}: ${path} is on ${base} itself; check out its task branch first`);
    const changes = dirty(path);
    if (changes !== "")
        throw new ToliError(`refusing to land ${id}: ${path} has uncommitted changes; commit them first:\n${changes}`);

    const rebased = git(path, ["rebase", `refs/heads/${base}`]);
    if (rebased.code !== 0) {
        git(path, ["rebase", "--abort"]);
        throw new ToliError(
            `refusing to land ${id}: ${branch} does not rebase cleanly onto ${base} (rebase aborted; resolve it in ` +
                `${path}: git rebase ${base}):\n${(rebased.stderr || rebased.stdout).trim()}`,
        );
    }
    const commits = Number(gitOk(live, ["rev-list", "--count", `refs/heads/${base}..refs/heads/${branch}`]));
    let check = "no commits to land; check skipped";
    let updated: string | null = null;
    if (commits > 0) {
        const checked = await runCombined(CHECK, { cwd: path });
        if (checked.code !== 0)
            throw new ToliError(
                `refusing to land ${id}: \`${CHECK.join(" ")}\` failed in ${path} (exit ${checked.code}); ` +
                    `${base} is unchanged. Last lines:\n${tail(checked.output, CHECK_TAIL_LINES)}`,
            );
        check = tail(checked.output, 5);
        updated = fastForward(live, base, branch, id);
    }
    const head = gitOk(live, ["rev-parse", `refs/heads/${base}`]);
    const removed = git(live, ["worktree", "remove", path]);
    if (removed.code !== 0)
        throw new ToliError(
            `landed ${id} at ${head.slice(0, 12)}, but git worktree remove ${path} failed: ` +
                (removed.stderr || removed.stdout).trim(),
        );
    // The branch is contained in base (fast-forwarded, or nothing to land), which need not be the checked-out HEAD
    // that `git branch -d` checks against.
    gitOk(live, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, `refs/heads/${base}`]);
    gitOk(live, ["branch", "-D", branch]);
    return { task: id, branch, base, commits, head, check, updated };
}

/**
 * Move `base` to `branch` (already rebased onto it) without ever rewriting it: `git merge --ff-only` in the worktree
 * that has `base` checked out (normally the live checkout), else a compare-and-swap of the ref alone. Returns that
 * worktree, or null when only the ref moved.
 */
function fastForward(live: string, base: string, branch: string, id: string): string | null {
    const holder = gitWorktrees(live).find((entry) => entry.branch === base);
    if (holder !== undefined) {
        const merged = git(holder.path, ["merge", "--ff-only", "--quiet", `refs/heads/${branch}`]);
        if (merged.code !== 0)
            throw new ToliError(
                `refusing to land ${id}: cannot fast-forward ${base} in ${holder.path} to ${branch} (did ${base} ` +
                    `move, or do uncommitted changes there overlap?). Run land again:\n` +
                    (merged.stderr || merged.stdout).trim(),
            );
        return holder.path;
    }
    const old = gitOk(live, ["rev-parse", `refs/heads/${base}`]);
    const tip = gitOk(live, ["rev-parse", `refs/heads/${branch}`]);
    const ancestor = git(live, ["merge-base", "--is-ancestor", old, tip]).code === 0;
    const moved = ancestor ? git(live, ["update-ref", "-m", `self land ${id}`, `refs/heads/${base}`, tip, old]) : null;
    if (moved === null || moved.code !== 0)
        throw new ToliError(
            `refusing to land ${id}: cannot fast-forward ${base} to ${branch} (did ${base} move?). Run land again` +
                (moved === null ? "" : `:\n${(moved.stderr || moved.stdout).trim()}`),
        );
    return null;
}

/** `toli self prepare <T-id> [--json]` | `list [--json]` | `land <T-id> [--json]`. */
export async function selfCommand(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;
    const args = new Args(rest, { booleans: ["json"] });
    if (sub === "prepare") {
        args.maxPositional(1);
        const worktree = prepareSelf(args.pos(0, "task id"));
        if (args.bool("json")) printJson(worktree);
        else out(`${worktree.path} on ${worktree.branch ?? "(detached)"} from ${worktree.base}`);
    } else if (sub === "list") {
        args.maxPositional(0);
        const entries = listSelf();
        if (args.bool("json")) printJson(entries);
        else
            out(
                entries.length === 0
                    ? "no self worktrees"
                    : entries
                          .map((entry) =>
                              [
                                  entry.task,
                                  entry.branch ?? "(detached)",
                                  `base ${entry.base}`,
                                  entry.dirty ? "dirty" : "clean",
                                  entry.path,
                              ].join("\t"),
                          )
                          .join("\n"),
            );
    } else if (sub === "land") {
        args.maxPositional(1);
        const landed = await landSelf(args.pos(0, "task id"));
        if (args.bool("json")) printJson(landed);
        else
            out(
                landed.commits === 0
                    ? `${landed.task}: nothing to land on ${landed.base}; worktree and ${landed.branch} removed`
                    : `${landed.task}: landed ${landed.commits} commit${landed.commits === 1 ? "" : "s"} of ` +
                          `${landed.branch} on ${landed.base} at ${landed.head.slice(0, 12)}; worktree and branch ` +
                          `removed${landed.updated === null ? `; no checkout is on ${landed.base} (git switch ${landed.base} to run it)` : ""}\n${landed.check}`,
            );
    } else throw new ToliError("usage: toli self prepare <T-id> | list | land <T-id>");
}
