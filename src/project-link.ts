// `bin/toli project link` (R17): register a checkout the user already has as the symlink projects/<name> -> <path>.
import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Args } from "./args.ts";
import { detectForge } from "./forge.ts";
import { currentBranch, git, isGitRepo } from "./git.ts";
import { paths } from "./paths.ts";
import { loadProjects, noMistakesReadiness, type Project, parseMode, register } from "./projects.ts";
import { out, requireName, ToliError } from "./util.ts";
/** Whether projects/<name> is a symlink (a linked checkout), whether or not its target still exists. */
export function isLinked(name: string): boolean {
    const dir = paths.projectDir(name);
    try {
        return lstatSync(dir).isSymbolicLink();
    } catch {
        return false;
    }
}

/** A linked project whose target checkout is gone or no longer a git repo; null when fine or not linked. */
export function brokenLink(project: Project): string | null {
    if (!isLinked(project.name)) return null;
    const target = project.linkedTo ?? readlinkSync(paths.projectDir(project.name));
    if (!existsSync(target)) return `link to ${target} is broken: that checkout was moved or deleted`;
    if (!isGitRepo(target)) return `link to ${target} is broken: it is no longer a git checkout`;
    return null;
}

/**
 * `project link <name> <path>`: register the user's existing checkout without cloning, as the symlink
 * projects/<name> -> <path>. Reports its origin, forge and branch; dropping it later removes only the symlink.
 */
export function projectLinkCommand(argv: string[]): void {
    const args = new Args(argv, { values: ["mode"] });
    args.maxPositional(2);
    const name = requireName("project", args.positional[0]);
    const requested = resolve(args.pos(1, "path"));
    const mode = parseMode(args.str("mode"));
    if (loadProjects().some((entry) => entry.name === name)) throw new ToliError(`project "${name}" already exists`);
    if (!existsSync(requested)) throw new ToliError(`${requested} does not exist`);
    const target = realpathSync(requested);
    if (!isGitRepo(target)) throw new ToliError(`${target} is not a git checkout (no .git)`);
    const projectsRoot = join(paths.root(), "projects");
    const inside = relative(existsSync(projectsRoot) ? realpathSync(projectsRoot) : projectsRoot, target);
    if (inside === "" || !inside.startsWith(".."))
        throw new ToliError(`${target} is inside toli's projects/ already; register it with bin/toli project import`);
    const dir = paths.projectDir(name);
    if (existsSync(dir) || isLinked(name)) throw new ToliError(`projects/${name} already exists`);
    const origin = git(target, ["remote", "get-url", "origin"]);
    const url = origin.code === 0 ? origin.stdout.trim() : "";
    mkdirSync(projectsRoot, { recursive: true });
    symlinkSync(target, dir, "dir");
    const labels = register(name, url, mode, target);
    out(`linked ${name}: projects/${name} -> ${target} (${labels})`);
    out(`origin: ${url === "" ? "none" : url}`);
    let forge: string;
    try {
        const detected = detectForge(url);
        forge = `${detected.forge} at ${detected.host} (${detected.repo})`;
    } catch (error) {
        forge = `not detected (${error instanceof Error ? error.message : String(error)})`;
    }
    out(`forge: ${forge}`);
    out(`branch: ${currentBranch(target) ?? "detached HEAD"} (checked out now; not recorded as a fixed branch)`);
    out(noMistakesReadiness(target));
}
