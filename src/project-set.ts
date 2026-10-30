// `bin/toli project set`: record the user's delivery, forge, workspace strategy and standing-grant answers.
import { Args } from "./args.ts";
import { parseWorkspace, perTask, type Workspace } from "./project-strategy.ts";
import {
    FORGES,
    type Forge,
    loadProjects,
    overrideLabels,
    type Project,
    parseMode,
    updateProjects,
} from "./projects.ts";
import { now, out, run, ToliError } from "./util.ts";

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
}
