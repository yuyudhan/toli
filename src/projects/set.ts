// `bin/toli project set`: record the user's delivery, forge, workspace strategy, task-branch pattern, standing-grant,
// live-stack, role and release-priority answers.
import { Args } from "../core/args.ts";
import { currentBranch, git, isGitRepo } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { now, out, run, ToliError, withLock } from "../core/util.ts";
import { overrideLabels } from "./list.ts";
import { FORGES, type Forge, loadProjects, type Project, parseMode, updateProjects } from "./projects.ts";
import { parseTaskBranchPattern, parseWorkspace, type Workspace } from "./strategy.ts";
import { cloneHolders, dirty, holdersText, refExists, workspaceLock } from "./workspace.ts";

/** `--forge`: one of FORGES, or `none` (null) to clear the override. */
function parseForge(value: string | undefined): Forge | null | undefined {
    if (value === undefined) return undefined;
    if (value === "none") return null;
    if (!(FORGES as readonly string[]).includes(value))
        throw new ToliError(`--forge must be one of ${FORGES.join(", ")}, or none`);
    return value as Forge;
}

/** `--branch`: a valid branch name, or `none` (null) to clear it. */
function parseBranch(value: string | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === "none") return null;
    if (run(["git", "check-ref-format", "--branch", value]).code !== 0)
        throw new ToliError(`--branch "${value}" is not a valid branch name`);
    return value;
}

/** `--forge-host`: a bare host name (no scheme, path or user), or `none` (null) to clear it. */
function parseForgeHost(value: string | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === "none") return null;
    if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(value))
        throw new ToliError(`--forge-host must be a host name such as gitlab.example.com, got "${value}"`);
    return value.toLowerCase();
}

/** `--standing-push` / `--standing-pr` / `--live-stack` / `--release-priority`: yes or no. */
function parseYesNo(value: string | undefined, flag: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (value !== "yes" && value !== "no") throw new ToliError(`${flag} must be yes or no, got "${value}"`);
    return value === "yes";
}

/** `project set --role`: `full` (the default, stored as no role) or `verify-only`. */
const ROLES = ["full", "verify-only"] as const;

/** `--role`: full or verify-only; full is stored as no role. */
function parseRole(value: string | undefined): (typeof ROLES)[number] | undefined {
    if (value === undefined) return undefined;
    const role = ROLES.find((entry) => entry === value);
    if (role === undefined) throw new ToliError(`--role must be one of ${ROLES.join(", ")}, got "${value}"`);
    return role;
}

/**
 * Apply a strategy to one entry. The mode stays as it is: a per-task strategy lands each task branch through a PR/MR
 * under `pr` / `no-mistakes`, and under `commit` the branch is pushed for the machine that cuts releases to merge.
 */
function applyWorkspace(project: Project, workspace: Workspace, at: string): void {
    project.workspace = workspace;
    project.workspaceSetAt = at;
}

/**
 * Run `fn` holding the workspace lock of each project in `names` (the lock `workspace prepare` takes), so a strategy
 * never changes while a task's workspace is being prepared from the old one.
 */
function underWorkspaceLocks<T>(names: string[], fn: () => T): T {
    const [first, ...rest] = names;
    return first === undefined ? fn() : withLock(workspaceLock(first), () => underWorkspaceLocks(rest, fn));
}

/**
 * After `--branch <b>`: switch the clone (or linked checkout) to <b> when it is clean and no live task holds it,
 * creating a local branch tracking origin/<b> when only origin has it. Otherwise it stays where it is and the note
 * names the command that switches it; the branch is recorded either way. Never fetches, stashes or creates <b>.
 * Runs under the workspace lock `workspace prepare` takes, so it cannot race a task switching the same clone.
 */
function switchClone(name: string, branch: string): string | null {
    const dir = paths.projectDir(name);
    if (!isGitRepo(dir)) return null;
    return withLock(workspaceLock(name), () => {
        const from = currentBranch(dir);
        if (from === branch) return null;
        const on = from ?? "a detached HEAD";
        const switchCommand = `git -C ${dir} switch ${branch}`;
        const stays = (reason: string, how = `switch it when that is settled: ${switchCommand}`) =>
            `projects/${name} is still on ${on}: ${reason}; ${how}`;
        const holders = cloneHolders(name, dir, branch);
        if (holders.length > 0) return stays(holdersText(holders));
        if (dirty(dir) !== "") return stays("it has uncommitted changes");
        const local = refExists(dir, `refs/heads/${branch}`);
        if (!local && !refExists(dir, `refs/remotes/origin/${branch}`))
            return stays(
                `branch ${branch} exists neither locally nor on origin`,
                `fetch and switch to it (git -C ${dir} fetch origin ${branch} && ${switchCommand}), ` +
                    `or create it from ${from ?? "the current commit"}: git -C ${dir} switch -c ${branch}`,
            );
        const result = git(dir, local ? ["switch", branch] : ["switch", "-c", branch, "--track", `origin/${branch}`]);
        if (result.code !== 0) return stays(`git switch failed: ${(result.stderr || result.stdout).trim()}`);
        return `projects/${name}: switched from ${on} to ${branch}${local ? "" : ` (tracking origin/${branch})`}`;
    });
}

function setAll(args: Args): void {
    const value = args.str("workspace");
    if (args.positional.length > 0) throw new ToliError("project set takes a name or --all, not both");
    if (value === undefined) throw new ToliError("project set --all needs --workspace <strategy>");
    const others = [
        "mode",
        "branch",
        "task-branch",
        "forge",
        "forge-host",
        "standing-push",
        "standing-pr",
        "live-stack",
        "role",
        "release-priority",
    ].filter((flag) => args.str(flag) !== undefined);
    if (others.length > 0)
        throw new ToliError(`project set --all sets only --workspace; set --${others.join(", --")} per project`);
    const workspace = parseWorkspace(value);
    const at = now().toISOString();
    underWorkspaceLocks(
        loadProjects().map((project) => project.name),
        () =>
            updateProjects((projects) => {
                for (const project of projects) applyWorkspace(project, workspace, at);
            }),
    );
    const total = loadProjects().length;
    out(`${total} project${total === 1 ? "" : "s"}: workspace=${workspace}`);
}

export function projectSetCommand(argv: string[]): void {
    const args = new Args(argv, {
        booleans: ["all"],
        values: [
            "mode",
            "branch",
            "task-branch",
            "forge",
            "forge-host",
            "workspace",
            "standing-push",
            "standing-pr",
            "live-stack",
            "role",
            "release-priority",
        ],
    });
    args.maxPositional(1);
    if (args.bool("all")) {
        setAll(args);
        return;
    }
    const name = args.pos(0, "name");
    const mode = parseMode(args.str("mode"));
    const branch = parseBranch(args.str("branch"));
    const taskBranch = parseTaskBranchPattern(args.str("task-branch"));
    const forge = parseForge(args.str("forge"));
    const forgeHost = parseForgeHost(args.str("forge-host"));
    const workspaceValue = args.str("workspace");
    const workspace = workspaceValue === undefined ? undefined : parseWorkspace(workspaceValue);
    const standingPush = parseYesNo(args.str("standing-push"), "--standing-push");
    const standingPr = parseYesNo(args.str("standing-pr"), "--standing-pr");
    const liveStack = parseYesNo(args.str("live-stack"), "--live-stack");
    const role = parseRole(args.str("role"));
    const releasePriority = parseYesNo(args.str("release-priority"), "--release-priority");
    if (
        [
            mode,
            branch,
            taskBranch,
            forge,
            forgeHost,
            workspace,
            standingPush,
            standingPr,
            liveStack,
            role,
            releasePriority,
        ].every((value) => value === undefined)
    )
        throw new ToliError(
            "nothing to set: pass --mode <m>, --branch <b>|none, --task-branch <pattern>|none, --forge <f>|none, " +
                "--forge-host <h>|none, --workspace <s>, --standing-push yes|no, --standing-pr yes|no, " +
                "--live-stack yes|no, --role full|verify-only or --release-priority yes|no (or --all --workspace <s>)",
        );
    const at = now().toISOString();
    const updated = underWorkspaceLocks(workspace === undefined ? [] : [name], () =>
        updateProjects((projects) => {
            const project = projects.find((entry) => entry.name === name);
            if (!project) throw new ToliError(`unknown project "${name}"`);
            if (mode !== undefined) project.mode = mode;
            if (branch === null) delete project.branch;
            else if (branch !== undefined) project.branch = branch;
            if (mode !== undefined || branch !== undefined) project.deliverySetAt = at;
            if (taskBranch === null) delete project.taskBranch;
            else if (taskBranch !== undefined) project.taskBranch = taskBranch;
            if (forge === null) delete project.forge;
            else if (forge !== undefined) project.forge = forge;
            if (forgeHost === null) delete project.forgeHost;
            else if (forgeHost !== undefined) project.forgeHost = forgeHost;
            if (workspace !== undefined) applyWorkspace(project, workspace, at);
            if (standingPush !== undefined || standingPr !== undefined) {
                const standing = {
                    push: standingPush ?? project.standing?.push ?? false,
                    pr: standingPr ?? project.standing?.pr ?? false,
                };
                if (standing.pr && !standing.push)
                    throw new ToliError(
                        "a standing PR/MR grant needs a standing push grant too (the branch must be pushed to open one)",
                    );
                if (standing.push || standing.pr) project.standing = standing;
                else delete project.standing;
            }
            if (liveStack === true) project.liveStack = true;
            else if (liveStack === false) delete project.liveStack;
            if (role === "verify-only") project.role = role;
            else if (role === "full") delete project.role;
            if (releasePriority === true) project.releasePriority = true;
            else if (releasePriority === false) delete project.releasePriority;
            return { ...project };
        }),
    );
    out(
        [`${updated.name}: mode=${updated.mode}`, `workspace=${updated.workspace}`, ...overrideLabels(updated)].join(
            " ",
        ),
    );
    const switched = typeof branch === "string" ? switchClone(name, branch) : null;
    if (switched !== null) out(switched);
}
