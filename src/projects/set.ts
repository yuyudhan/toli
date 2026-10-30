// `bin/toli project set`: record the user's delivery, forge, workspace strategy and standing-grant answers.
import { Args } from "../core/args.ts";
import { currentBranch, git, isGitRepo } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { now, out, run, ToliError, withLock } from "../core/util.ts";
import {
    FORGES,
    type Forge,
    loadProjects,
    overrideLabels,
    type Project,
    parseMode,
    updateProjects,
} from "./projects.ts";
import { parseWorkspace, perTask, type Workspace } from "./strategy.ts";
import { cloneHolders, dirty, holdersText, refExists } from "./workspace.ts";

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

/** `--standing-push` / `--standing-pr`: yes or no. */
function parseYesNo(value: string | undefined, flag: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (value !== "yes" && value !== "no") throw new ToliError(`${flag} must be yes or no, got "${value}"`);
    return value === "yes";
}

/**
 * Apply a strategy to one entry. A per-task strategy lands through PR/MRs, so a `commit`-mode project moves to `pr`
 * (an explicit `--mode commit` in the same call is refused before this runs). Returns a note for what moved.
 */
function applyWorkspace(project: Project, workspace: Workspace, at: string): string | null {
    project.workspace = workspace;
    project.workspaceSetAt = at;
    if (!perTask(workspace) || project.mode !== "commit") return null;
    project.mode = "pr";
    project.deliverySetAt = at;
    return `${project.name}: mode commit -> pr (${workspace} lands each task through a PR/MR)`;
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
    return withLock(paths.lock(`workspace-${name}`), () => {
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
    const others = ["mode", "branch", "forge", "forge-host", "standing-push", "standing-pr"].filter(
        (flag) => args.str(flag) !== undefined,
    );
    if (others.length > 0)
        throw new ToliError(`project set --all sets only --workspace; set --${others.join(", --")} per project`);
    const workspace = parseWorkspace(value);
    const at = now().toISOString();
    const notes = updateProjects((projects) =>
        projects.map((project) => applyWorkspace(project, workspace, at)).filter((note) => note !== null),
    );
    for (const note of notes) out(note);
    const total = loadProjects().length;
    out(`${total} project${total === 1 ? "" : "s"}: workspace=${workspace}`);
}

export function projectSetCommand(argv: string[]): void {
    const args = new Args(argv, {
        booleans: ["all"],
        values: ["mode", "branch", "forge", "forge-host", "workspace", "standing-push", "standing-pr"],
    });
    args.maxPositional(1);
    if (args.bool("all")) {
        setAll(args);
        return;
    }
    const name = args.pos(0, "name");
    const mode = parseMode(args.str("mode"));
    const branch = parseBranch(args.str("branch"));
    const forge = parseForge(args.str("forge"));
    const forgeHost = parseForgeHost(args.str("forge-host"));
    const workspaceValue = args.str("workspace");
    const workspace = workspaceValue === undefined ? undefined : parseWorkspace(workspaceValue);
    const standingPush = parseYesNo(args.str("standing-push"), "--standing-push");
    const standingPr = parseYesNo(args.str("standing-pr"), "--standing-pr");
    if ([mode, branch, forge, forgeHost, workspace, standingPush, standingPr].every((value) => value === undefined))
        throw new ToliError(
            "nothing to set: pass --mode <m>, --branch <b>|none, --forge <f>|none, --forge-host <h>|none, " +
                "--workspace <s>, --standing-push yes|no or --standing-pr yes|no (or --all --workspace <s>)",
        );
    const at = now().toISOString();
    const { updated, note } = updateProjects((projects) => {
        const project = projects.find((entry) => entry.name === name);
        if (!project) throw new ToliError(`unknown project "${name}"`);
        if (mode === "commit" && perTask(workspace ?? project.workspace))
            throw new ToliError(
                `${workspace ?? project.workspace} lands each task through a PR/MR, so mode commit does not fit; ` +
                    `pick --mode pr|no-mistakes, or --workspace same-branch`,
            );
        if (mode !== undefined) project.mode = mode;
        if (branch === null) delete project.branch;
        else if (branch !== undefined) project.branch = branch;
        if (mode !== undefined || branch !== undefined) project.deliverySetAt = at;
        if (forge === null) delete project.forge;
        else if (forge !== undefined) project.forge = forge;
        if (forgeHost === null) delete project.forgeHost;
        else if (forgeHost !== undefined) project.forgeHost = forgeHost;
        const moved = workspace === undefined ? null : applyWorkspace(project, workspace, at);
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
        return { updated: { ...project }, note: moved };
    });
    if (note !== null) out(note);
    out(
        [`${updated.name}: mode=${updated.mode}`, `workspace=${updated.workspace}`, ...overrideLabels(updated)].join(
            " ",
        ),
    );
    const switched = typeof branch === "string" ? switchClone(name, branch) : null;
    if (switched !== null) out(switched);
}
