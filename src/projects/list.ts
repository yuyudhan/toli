// `bin/toli project list`: the registered projects, their delivery and the overrides set on them.
import { Args } from "../core/args.ts";
import { isGitRepo } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { out, printJson } from "../core/util.ts";
import { brokenLink } from "./link.ts";
import { loadProjects, type Project } from "./projects.ts";
import { standingText } from "./strategy.ts";

/**
 * `branch=`, `forge=`, `forge-host=`, `standing=`, `live-stack=`, `role=`, `release-priority=` labels for the fields
 * that are set.
 */
export function overrideLabels(project: Project): string[] {
    return [
        ...(project.branch ? [`branch=${project.branch}`] : []),
        ...(project.forge ? [`forge=${project.forge}`] : []),
        ...(project.forgeHost ? [`forge-host=${project.forgeHost}`] : []),
        ...(project.standing ? [`standing=${standingText(project.standing)}`] : []),
        ...(project.liveStack ? ["live-stack=yes"] : []),
        ...(project.role ? [`role=${project.role}`] : []),
        ...(project.releasePriority ? ["release-priority=yes"] : []),
    ];
}

export function projectListCommand(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const projects = loadProjects();
    if (args.bool("json")) {
        printJson(
            projects.map((entry) => ({
                ...entry,
                branch: entry.branch ?? null,
                standing: entry.standing ?? { push: false, pr: false },
                liveStack: entry.liveStack === true,
                releasePriority: entry.releasePriority === true,
                path: paths.projectDir(entry.name),
                cloned: isGitRepo(paths.projectDir(entry.name)),
                linkedTo: entry.linkedTo ?? null,
                brokenLink: brokenLink(entry),
            })),
        );
        return;
    }
    if (projects.length === 0) {
        out("no projects");
        return;
    }
    for (const entry of projects) {
        const clone = brokenLink(entry)
            ? "broken link"
            : entry.linkedTo
              ? `linked -> ${entry.linkedTo}`
              : isGitRepo(paths.projectDir(entry.name))
                ? "cloned"
                : "not cloned";
        out(
            [
                entry.name,
                `mode=${entry.mode}`,
                `workspace=${entry.workspace}`,
                ...overrideLabels(entry),
                clone,
                entry.url,
            ].join("\t"),
        );
    }
}
