import { existsSync, readdirSync, readlinkSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Args } from "../core/args.ts";
import { git, gitOk, isGitRepo, unpushedBranches } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { now, out, readJson, requireName, run, ToliError, withLock, writeJsonAtomic } from "../core/util.ts";
import { ensureHooks } from "./hooks.ts";
import { isLinked, projectLinkCommand } from "./link.ts";
import { projectListCommand } from "./list.ts";
import { projectSetCommand } from "./set.ts";
import { projectSetupCommand } from "./setup.ts";
import {
    isWorkspace,
    legacyWorkspace,
    machineDefaultWorkspace,
    perTask,
    type Standing,
    type Workspace,
} from "./strategy.ts";

export const MODES = ["commit", "pr", "no-mistakes"] as const;
export type Mode = (typeof MODES)[number];

export const FORGES = ["github", "gitlab", "bitbucket"] as const;
export type Forge = (typeof FORGES)[number];

/** A commit-hook limit as stored: a positive whole number of seconds, or `none` for no limit. */
export type HookTimeout = number | "none";

/**
 * A project cloned on this machine; `data/projects.json` lists only this machine's clones.
 * `branch`: the fixed working branch `toli commit` requires. `forge`/`forgeHost`: override origin-based detection.
 * `deliverySetAt`: when the user's delivery choice (mode/branch) was recorded; absent means mode is a default.
 * `workspace`: the branching/worktree strategy; `workspaceSetAt` stamps the user's choice (absent: defaulted).
 * With a per-task strategy, `branch` is the base branch task branches start from and PR/MRs target, unless
 * `baseBranch` names another (a project whose fixed `branch` is a release branch, its tasks starting from main), and
 * `taskBranch` the pattern a task's branch is named by (DEFAULT_TASK_BRANCH, src/projects/strategy.ts, when unset).
 * `liveStack`: the project runs in live-stack mode (docs/projects.md "Live-stack mode"): its jawans code in the one
 * shared checkout against the machine's running dev stack, which rebuilds on every save, instead of building
 * themselves.
 * `role`: `verify-only` when this machine takes no ship work for the project (docs/projects.md "Verify-only machines").
 * `releasePriority`: while the project's `--work release` run runs, other projects' heavy builds on this machine wait
 * for it (docs/fleet.md "Release priority", src/fleet/release-priority.ts).
 * `slotAtHeavyStep`: the project's checks (gate recipes, pre-push hook) run their heavy steps through `bin/toli
 * build-slot`, so they run without a heavy-build slot until their first heavy step and hold one from there to their
 * end (src/fleet/heavy-step-slot.ts).
 * `hookTimeoutSeconds`: how long each of the project's commit hooks may run under `bin/toli commit` (`none`: no
 * limit); absent, the machine's capacity.commitHookTimeoutSeconds applies (src/projects/commit-hooks.ts).
 * `catchUp`: whether a new release tag starts a catch-up jawan here (absent: on; docs/projects.md "Release catch-up");
 * `catchUpChecks`: the quick checks that jawan runs after each merge (absent: the ones the project's notes name);
 * `catchUpPush`: false keeps every catch-up merge local on this machine (a box that cannot run the push gate);
 * `catchUpTrailer`: one `Key: text` trailer line (`{tag}`, `{base}`, `{branch}` filled in) added to each catch-up merge
 * message, for a project whose commit-msg hook demands one on such commits.
 */
export type Project = {
    name: string;
    url: string;
    mode: Mode;
    addedAt: string;
    branch?: string;
    baseBranch?: string;
    forge?: Forge;
    forgeHost?: string;
    deliverySetAt?: string;
    workspace: Workspace;
    workspaceSetAt?: string;
    /**
     * Set while a per-task project is toggled to same-branch under a live task still working in its per-task
     * workspace (T1904): `from` is the strategy to switch back to. `workspace prepare` refuses new records meanwhile.
     */
    workspaceToggle?: { from: Workspace; at: string };
    standing?: Standing;
    taskBranch?: string;
    liveStack?: true;
    role?: "verify-only";
    releasePriority?: true;
    slotAtHeavyStep?: true;
    hookTimeoutSeconds?: HookTimeout;
    catchUp?: boolean;
    catchUpChecks?: string;
    catchUpPush?: false;
    catchUpTrailer?: string;
    /** Set for `project link`: the user's own checkout that projects/<name> is a symlink to (never deleted by toli). */
    linkedTo?: string;
};

type StoredProject = Omit<Project, "workspace"> & { workspace?: unknown; owner?: unknown };

/**
 * Registered projects. Fields from older files (e.g. the removed `owner`) are dropped here, so the next write omits
 * them; a project stored without a valid `workspace` gets the strategy it followed before R16 (`bin/toli migrate`
 * writes it down).
 */
export function loadProjects(): Project[] {
    return readJson<{ projects: StoredProject[] }>(paths.projects(), { projects: [] }).projects.map(
        ({
            name,
            url,
            mode,
            addedAt,
            branch,
            baseBranch,
            forge,
            forgeHost,
            deliverySetAt,
            workspace,
            workspaceSetAt,
            workspaceToggle,
            standing,
            taskBranch,
            liveStack,
            role,
            releasePriority,
            slotAtHeavyStep,
            hookTimeoutSeconds,
            catchUp,
            catchUpChecks,
            catchUpPush,
            catchUpTrailer,
            linkedTo,
        }) => ({
            name,
            url,
            mode,
            addedAt,
            ...(branch ? { branch } : {}),
            ...(baseBranch ? { baseBranch } : {}),
            ...(forge ? { forge } : {}),
            ...(forgeHost ? { forgeHost } : {}),
            ...(deliverySetAt ? { deliverySetAt } : {}),
            workspace: isWorkspace(workspace) ? workspace : legacyWorkspace({ mode, branch }),
            ...(workspaceSetAt ? { workspaceSetAt } : {}),
            ...(workspaceToggle && isWorkspace(workspaceToggle.from) ? { workspaceToggle } : {}),
            ...(standing ? { standing: { push: standing.push === true, pr: standing.pr === true } } : {}),
            ...(taskBranch ? { taskBranch } : {}),
            ...(liveStack === true ? { liveStack: true as const } : {}),
            ...(role === "verify-only" ? { role } : {}),
            ...(releasePriority === true ? { releasePriority: true as const } : {}),
            ...(slotAtHeavyStep === true ? { slotAtHeavyStep: true as const } : {}),
            ...(hookTimeoutSeconds === undefined ? {} : { hookTimeoutSeconds }),
            ...(typeof catchUp === "boolean" ? { catchUp } : {}),
            ...(catchUpChecks ? { catchUpChecks } : {}),
            ...(catchUpPush === false ? { catchUpPush } : {}),
            ...(catchUpTrailer ? { catchUpTrailer } : {}),
            ...(linkedTo ? { linkedTo } : {}),
        }),
    );
}

/** Projects whose stored entry lacks a valid `workspace`, with the strategy `loadProjects` infers for them. */
export function projectsMissingWorkspace(): { name: string; workspace: Workspace }[] {
    return readJson<{ projects: StoredProject[] }>(paths.projects(), { projects: [] })
        .projects.filter((entry) => !isWorkspace(entry.workspace))
        .map((entry) => ({ name: entry.name, workspace: legacyWorkspace(entry) }));
}

/** Write the inferred `workspace` into every entry that lacks one; returns what was written. */
export function migrateWorkspaces(): { name: string; workspace: Workspace }[] {
    if (projectsMissingWorkspace().length === 0) return [];
    return updateProjects(() => projectsMissingWorkspace());
}

/** Read-modify-write data/projects.json under the projects lock. */
export function updateProjects<T>(fn: (projects: Project[]) => T): T {
    return withLock(paths.lock("projects"), () => {
        const projects = loadProjects();
        const result = fn(projects);
        writeJsonAtomic(paths.projects(), { projects });
        return result;
    });
}

export function findProject(name: string): Project {
    const project = loadProjects().find((entry) => entry.name === name);
    if (!project) throw new ToliError(`unknown project "${name}" (see \`bin/toli project list\`)`);
    return project;
}

/** Whether `name` is a registered project in live-stack mode (`project set --live-stack yes`); false for null/unknown. */
export function isLiveStack(name: string | null): boolean {
    return name !== null && loadProjects().some((project) => project.name === name && project.liveStack === true);
}

export function parseMode(value: string | undefined): Mode | undefined {
    if (value === undefined) return undefined;
    if (!(MODES as readonly string[]).includes(value)) throw new ToliError(`--mode must be one of ${MODES.join(", ")}`);
    return value as Mode;
}

/**
 * `toli` names toli's own checkout when no registered project has that name: its git root, else null (a registered
 * project). Throws when the toli root is not a git checkout.
 */
export function toliSelfCheckout(name: string): string | null {
    if (name !== "toli" || loadProjects().some((project) => project.name === "toli")) return null;
    const root = paths.root();
    if (!isGitRepo(root)) throw new ToliError(`${root} is not a git checkout`);
    return root;
}

/** The local clone of a registered project. */
export function projectCloneDir(name: string): string {
    findProject(name);
    const dir = paths.projectDir(name);
    if (!isGitRepo(dir)) throw new ToliError(`projects/${name} is not a git clone on this machine`);
    return dir;
}

export function noMistakesReadiness(dir: string): string {
    const result = git(dir, ["remote", "get-url", "no-mistakes"]);
    return result.code === 0
        ? `no-mistakes: ready (${result.stdout.trim()})`
        : "no-mistakes: not initialized (run `no-mistakes init` in the project when a branch/PR flow is wanted)";
}

function cloneInto(name: string, url: string): string {
    const dir = paths.projectDir(name);
    const clone = run(["git", "clone", url, dir]);
    if (clone.code !== 0) throw new ToliError(`git clone failed: ${(clone.stderr || clone.stdout).trim()}`);
    return dir;
}

/**
 * Mode and strategy of a new entry: this machine's default strategy, unstamped, so `project setup` asks the user to
 * confirm it. A per-task default turns the default mode into `pr`; an explicit `--mode commit` keeps same-branch.
 */
function newEntryDefaults(mode: Mode | undefined): { mode: Mode; workspace: Workspace } {
    const workspace = machineDefaultWorkspace();
    if (!perTask(workspace)) return { mode: mode ?? "commit", workspace };
    if (mode === "commit") return { mode, workspace: "same-branch" };
    return { mode: mode ?? "pr", workspace };
}

/** Register a new entry (no-op when present); returns its delivery labels for the caller's message. */
export function register(name: string, url: string, requested: Mode | undefined, linkedTo?: string): string {
    const { mode, workspace } = newEntryDefaults(requested);
    updateProjects((projects) => {
        if (!projects.some((entry) => entry.name === name))
            projects.push({
                name,
                url,
                mode,
                addedAt: now().toISOString(),
                workspace,
                ...(linkedTo === undefined ? {} : { linkedTo }),
            });
    });
    return `mode ${mode}, workspace ${workspace}`;
}

function add(argv: string[]): void {
    const args = new Args(argv, { values: ["mode"] });
    args.maxPositional(2);
    const name = requireName("project", args.positional[0]);
    const url = args.pos(1, "git-url");
    const mode = parseMode(args.str("mode"));
    if (loadProjects().some((entry) => entry.name === name)) throw new ToliError(`project "${name}" already exists`);
    const dir = paths.projectDir(name);
    if (existsSync(dir)) {
        if (!isGitRepo(dir)) throw new ToliError(`projects/${name} exists and is not a git clone`);
        out(`projects/${name} already cloned; registering it`);
    } else {
        cloneInto(name, url);
    }
    const labels = register(name, url, mode);
    out(`added ${name} (${labels}) at ${dir}`);
    out(noMistakesReadiness(dir));
    for (const line of ensureHooks(dir, `bin/toli project setup ${name}`)) out(line);
}

/**
 * `project ensure`: idempotent "this machine has a registered clone of <name>"; prints what it did. It also installs
 * the git hooks the repo declares where toli can tell how (src/projects/hooks.ts) and reports the rest.
 */
function ensure(argv: string[]): void {
    const args = new Args(argv, { values: ["mode"] });
    args.maxPositional(2);
    const name = requireName("project", args.positional[0]);
    const url = args.pos(1, "git-url");
    const mode = parseMode(args.str("mode"));
    const registered = loadProjects().some((entry) => entry.name === name);
    const dir = paths.projectDir(name);
    const cloned = isGitRepo(dir);
    if (!cloned && existsSync(dir)) throw new ToliError(`projects/${name} exists and is not a git clone`);
    if (registered && cloned) out(`${name}: already registered and cloned at ${dir}`);
    else if (cloned) out(`${name}: registered the existing clone at ${dir} (${register(name, url, mode)})`);
    else {
        cloneInto(name, url);
        const labels = register(name, url, mode);
        out(
            registered
                ? `${name}: cloned into ${dir} (already registered)`
                : `${name}: cloned into ${dir} and registered (${labels})`,
        );
    }
    for (const line of ensureHooks(dir, `bin/toli project setup ${name}`)) out(line);
}

function path(argv: string[]): void {
    const args = new Args(argv);
    args.maxPositional(1);
    const project = findProject(args.pos(0, "name"));
    out(paths.projectDir(project.name));
}

function drop(argv: string[]): void {
    const args = new Args(argv, { booleans: ["delete-clone", "delete-data"] });
    args.maxPositional(1);
    const name = args.pos(0, "name");
    findProject(name);
    const dir = paths.projectDir(name);
    // A linked checkout is the user's own: dropping it removes only toli's symlink, so its state never blocks a drop.
    const linked = isLinked(name);
    if (!linked && isGitRepo(dir)) {
        const dirty = gitOk(dir, ["status", "--porcelain"]);
        if (dirty !== "") throw new ToliError(`refusing: projects/${name} has uncommitted changes:\n${dirty}`);
        const unpushed = unpushedBranches(dir);
        if (unpushed.length > 0) {
            throw new ToliError(`refusing: projects/${name} has unpushed commits on ${unpushed.join(", ")}`);
        }
    }
    updateProjects((projects) => {
        const index = projects.findIndex((entry) => entry.name === name);
        if (index !== -1) projects.splice(index, 1);
    });
    const removed: string[] = [];
    if (args.bool("delete-clone") && linked) {
        const target = readlinkSync(dir);
        unlinkSync(dir);
        removed.push(`the symlink projects/${name} (its checkout ${target} is untouched)`);
    } else if (args.bool("delete-clone") && existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        removed.push(`projects/${name}`);
    }
    const data = paths.projectDataDir(name);
    if (args.bool("delete-data") && existsSync(data)) {
        rmSync(data, { recursive: true, force: true });
        removed.push(`data/projects/${name}`);
    }
    const kept = [
        ...(isLinked(name) ? [`link kept at projects/${name} -> ${readlinkSync(dir)}`] : []),
        ...(!isLinked(name) && existsSync(dir) ? [`clone kept at projects/${name}`] : []),
        ...(existsSync(data) ? [`data kept at data/projects/${name}`] : []),
    ];
    out(
        `dropped ${name}${removed.length > 0 ? ` and deleted ${removed.join(" and ")}` : ""}${kept.length > 0 ? ` (${kept.join("; ")})` : ""}`,
    );
}

function importClones(argv: string[]): void {
    const args = new Args(argv, { values: ["dir"] });
    args.maxPositional(0);
    const base = join(paths.root(), args.str("dir") ?? "projects");
    if (!existsSync(base)) throw new ToliError(`${base} does not exist`);
    const known = new Set(loadProjects().map((entry) => entry.name));
    const found: Project[] = [];
    const defaults = newEntryDefaults(undefined);
    for (const entry of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || known.has(entry.name)) continue;
        const dir = join(base, entry.name);
        if (!isGitRepo(dir)) continue;
        const origin = git(dir, ["remote", "get-url", "origin"]);
        found.push({
            name: entry.name,
            url: origin.code === 0 ? origin.stdout.trim() : "",
            addedAt: now().toISOString(),
            ...defaults,
        });
    }
    updateProjects((projects) => {
        const present = new Set(projects.map((entry) => entry.name));
        projects.push(...found.filter((entry) => !present.has(entry.name)));
    });
    for (const entry of found) out(`imported ${entry.name}${entry.url ? ` (${entry.url})` : " (no origin)"}`);
    out(`${found.length} project${found.length === 1 ? "" : "s"} imported`);
}

const PROJECT_SUBCOMMANDS: Record<string, (argv: string[]) => void> = {
    add,
    ensure,
    link: projectLinkCommand,
    list: projectListCommand,
    path,
    set: projectSetCommand,
    setup: projectSetupCommand,
    drop,
    import: importClones,
};

export function projectCommand(argv: string[]): void {
    const [sub, ...rest] = argv;
    const handler = sub !== undefined && Object.hasOwn(PROJECT_SUBCOMMANDS, sub) ? PROJECT_SUBCOMMANDS[sub] : undefined;
    if (!handler) throw new ToliError("usage: toli project add|ensure|link|list|path|set|setup|drop|import");
    handler(rest);
}
