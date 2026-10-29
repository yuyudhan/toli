import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Args } from "./args.ts";
import { git, gitOk, isGitRepo, unpushedBranches } from "./git.ts";
import { paths } from "./paths.ts";
import { MateError, now, out, printJson, readJson, requireName, run, withLock, writeJsonAtomic } from "./util.ts";

export const MODES = ["commit", "pr", "no-mistakes"] as const;
export type Mode = (typeof MODES)[number];

/** A project cloned on this machine; `data/projects.json` lists only this machine's clones. */
export type Project = { name: string; url: string; mode: Mode; addedAt: string };

type ProjectsFile = { projects: Project[] };

/** Registered projects. Fields from older files (e.g. the removed `owner`) are dropped here, so the next write omits them. */
export function loadProjects(): Project[] {
    return readJson<ProjectsFile>(paths.projects(), { projects: [] }).projects.map(({ name, url, mode, addedAt }) => ({
        name,
        url,
        mode,
        addedAt,
    }));
}

function updateProjects<T>(fn: (projects: Project[]) => T): T {
    return withLock(paths.lock("projects"), () => {
        const projects = loadProjects();
        const result = fn(projects);
        writeJsonAtomic(paths.projects(), { projects });
        return result;
    });
}

export function findProject(name: string): Project {
    const project = loadProjects().find((entry) => entry.name === name);
    if (!project) throw new MateError(`unknown project "${name}" (see \`bin/mate project list\`)`);
    return project;
}

function parseMode(value: string | undefined): Mode | undefined {
    if (value === undefined) return undefined;
    if (!(MODES as readonly string[]).includes(value)) throw new MateError(`--mode must be one of ${MODES.join(", ")}`);
    return value as Mode;
}

/** The local clone of a registered project. */
export function projectCloneDir(name: string): string {
    findProject(name);
    const dir = paths.projectDir(name);
    if (!isGitRepo(dir)) throw new MateError(`projects/${name} is not a git clone on this machine`);
    return dir;
}

function noMistakesReadiness(dir: string): string {
    const result = git(dir, ["remote", "get-url", "no-mistakes"]);
    return result.code === 0
        ? `no-mistakes: ready (${result.stdout.trim()})`
        : "no-mistakes: not initialized (run `no-mistakes init` in the project when a branch/PR flow is wanted)";
}

function cloneInto(name: string, url: string): string {
    const dir = paths.projectDir(name);
    const clone = run(["git", "clone", url, dir]);
    if (clone.code !== 0) throw new MateError(`git clone failed: ${(clone.stderr || clone.stdout).trim()}`);
    return dir;
}

function register(name: string, url: string, mode: Mode): void {
    updateProjects((projects) => {
        if (!projects.some((entry) => entry.name === name))
            projects.push({ name, url, mode, addedAt: now().toISOString() });
    });
}

function add(argv: string[]): void {
    const args = new Args(argv, { values: ["mode"] });
    args.maxPositional(2);
    const name = requireName("project", args.positional[0]);
    const url = args.pos(1, "git-url");
    const mode = parseMode(args.str("mode")) ?? "commit";
    if (loadProjects().some((entry) => entry.name === name)) throw new MateError(`project "${name}" already exists`);
    const dir = paths.projectDir(name);
    if (existsSync(dir)) {
        if (!isGitRepo(dir)) throw new MateError(`projects/${name} exists and is not a git clone`);
        out(`projects/${name} already cloned; registering it`);
    } else {
        cloneInto(name, url);
    }
    register(name, url, mode);
    out(`added ${name} (mode ${mode}) at ${dir}`);
    out(noMistakesReadiness(dir));
}

/** `project ensure`: idempotent "this machine has a registered clone of <name>"; prints what it did. */
function ensure(argv: string[]): void {
    const args = new Args(argv, { values: ["mode"] });
    args.maxPositional(2);
    const name = requireName("project", args.positional[0]);
    const url = args.pos(1, "git-url");
    const mode = parseMode(args.str("mode")) ?? "commit";
    const registered = loadProjects().some((entry) => entry.name === name);
    const dir = paths.projectDir(name);
    const cloned = isGitRepo(dir);
    if (!cloned && existsSync(dir)) throw new MateError(`projects/${name} exists and is not a git clone`);
    if (registered && cloned) {
        out(`${name}: already registered and cloned at ${dir}`);
        return;
    }
    if (cloned) {
        register(name, url, mode);
        out(`${name}: registered the existing clone at ${dir} (mode ${mode})`);
        return;
    }
    cloneInto(name, url);
    register(name, url, mode);
    out(
        registered
            ? `${name}: cloned into ${dir} (already registered)`
            : `${name}: cloned into ${dir} and registered (mode ${mode})`,
    );
}

function list(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const projects = loadProjects();
    if (args.bool("json")) {
        printJson(
            projects.map((entry) => ({
                ...entry,
                path: paths.projectDir(entry.name),
                cloned: isGitRepo(paths.projectDir(entry.name)),
            })),
        );
        return;
    }
    if (projects.length === 0) {
        out("no projects");
        return;
    }
    for (const entry of projects) {
        const clone = isGitRepo(paths.projectDir(entry.name)) ? "cloned" : "not cloned";
        out(`${entry.name}\tmode=${entry.mode}\t${clone}\t${entry.url}`);
    }
}

function path(argv: string[]): void {
    const args = new Args(argv);
    args.maxPositional(1);
    const project = findProject(args.pos(0, "name"));
    out(paths.projectDir(project.name));
}

function set(argv: string[]): void {
    const args = new Args(argv, { values: ["mode"] });
    args.maxPositional(1);
    const name = args.pos(0, "name");
    const mode = parseMode(args.str("mode"));
    if (mode === undefined) throw new MateError("nothing to set: pass --mode <m>");
    const updated = updateProjects((projects) => {
        const project = projects.find((entry) => entry.name === name);
        if (!project) throw new MateError(`unknown project "${name}"`);
        project.mode = mode;
        return { ...project };
    });
    out(`${updated.name}: mode=${updated.mode}`);
}

function drop(argv: string[]): void {
    const args = new Args(argv, { booleans: ["delete-clone"] });
    args.maxPositional(1);
    const name = args.pos(0, "name");
    findProject(name);
    const dir = paths.projectDir(name);
    if (isGitRepo(dir)) {
        const dirty = gitOk(dir, ["status", "--porcelain"]);
        if (dirty !== "") throw new MateError(`refusing: projects/${name} has uncommitted changes:\n${dirty}`);
        const unpushed = unpushedBranches(dir);
        if (unpushed.length > 0) {
            throw new MateError(`refusing: projects/${name} has unpushed commits on ${unpushed.join(", ")}`);
        }
    }
    updateProjects((projects) => {
        const index = projects.findIndex((entry) => entry.name === name);
        if (index !== -1) projects.splice(index, 1);
    });
    if (args.bool("delete-clone") && existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        out(`dropped ${name} and deleted projects/${name}`);
    } else {
        out(`dropped ${name}${existsSync(dir) ? ` (clone kept at projects/${name})` : ""}`);
    }
}

function importClones(argv: string[]): void {
    const args = new Args(argv, { values: ["dir"] });
    args.maxPositional(0);
    const base = join(paths.root(), args.str("dir") ?? "projects");
    if (!existsSync(base)) throw new MateError(`${base} does not exist`);
    const known = new Set(loadProjects().map((entry) => entry.name));
    const found: Project[] = [];
    for (const entry of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || known.has(entry.name)) continue;
        const dir = join(base, entry.name);
        if (!isGitRepo(dir)) continue;
        const origin = git(dir, ["remote", "get-url", "origin"]);
        found.push({
            name: entry.name,
            url: origin.code === 0 ? origin.stdout.trim() : "",
            mode: "commit",
            addedAt: now().toISOString(),
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
    list,
    path,
    set,
    drop,
    import: importClones,
};

export function projectCommand(argv: string[]): void {
    const [sub, ...rest] = argv;
    const handler = sub !== undefined && Object.hasOwn(PROJECT_SUBCOMMANDS, sub) ? PROJECT_SUBCOMMANDS[sub] : undefined;
    if (!handler) throw new MateError("usage: mate project add|ensure|list|path|set|drop|import");
    handler(rest);
}
