import { existsSync, readFileSync, statSync } from "node:fs";
import { Args } from "./args.ts";
import { forgeReadiness, projectForge } from "./forge.ts";
import { currentBranch, git, isGitRepo } from "./git.ts";
import { STALE_DAYS } from "./memory.ts";
import { paths } from "./paths.ts";
import { brokenLink } from "./project-link.ts";
import { standingText } from "./project-strategy.ts";
import { findProject, loadProjects, type Project } from "./projects.ts";
import { now, out, printJson, ToliError } from "./util.ts";

/**
 * `ok`: answered. `missing`: the lead must ask the user or dispatch a jawan to fill it.
 * `stale`: present but old enough to re-check. `optional`: unknown, but nothing depends on it in this delivery mode.
 */
export type CheckStatus = "ok" | "missing" | "stale" | "optional";

export type SetupCheck = {
    key: SetupKey;
    status: CheckStatus;
    detail: string;
    /** Who closes the gap: the user's answer (batched by the lead) or a jawan that detects it from the repo. */
    fill?: "ask" | "jawan";
};

export type SetupKey =
    | "clone"
    | "delivery"
    | "workspace"
    | "branch"
    | "forge"
    | "forge-auth"
    | "no-mistakes"
    | "notes"
    | "test"
    | "smoke"
    | "local-stack"
    | "urls"
    | "proof"
    | "freshness";

export type SetupReport = { project: string; ready: boolean; checks: SetupCheck[] };

const DAY_MS = 24 * 60 * 60 * 1000;
const GAPS: readonly CheckStatus[] = ["missing", "stale"];

/** Notes `## Heading` sections by heading text, each with its body. */
function sections(notes: string): Map<string, string> {
    const result = new Map<string, string>();
    let heading: string | null = null;
    let body: string[] = [];
    const flush = (): void => {
        if (heading !== null) result.set(heading.toLowerCase(), body.join("\n").trim());
    };
    for (const line of notes.split("\n")) {
        const match = /^## (.+?)\s*$/.exec(line);
        if (match) {
            flush();
            heading = match[1] ?? "";
            body = [];
        } else body.push(line);
    }
    flush();
    return result;
}

/** A `- Test: ...` / `- Smoke: ...` line, or any backticked command mentioning the word. */
function hasCommand(notes: string, word: "test" | "smoke"): boolean {
    if (new RegExp(`^\\s*- ${word}\\b[^:\\n]*:`, "im").test(notes)) return true;
    return [...notes.matchAll(/`([^`\n]+)`/g)].some((match) => new RegExp(`\\b${word}\\b`, "i").test(match[1] ?? ""));
}

/** Whether delivery was chosen rather than defaulted: stamped by `project set --mode/--branch`, or any non-default. */
export function deliveryConfirmed(project: Project): boolean {
    return project.deliverySetAt !== undefined || project.branch !== undefined || project.mode !== "commit";
}

function deliveryText(project: Project): string {
    if (project.mode === "pr") return "pull/merge requests from a work branch";
    if (project.mode === "no-mistakes")
        return `the no-mistakes gate${project.branch ? ` on ${project.branch}` : " from a work branch"}`;
    return project.branch ? `commit on the fixed branch ${project.branch}` : "commit on the checked-out branch";
}

const WORKSPACE_TEXT: Record<Project["workspace"], string> = {
    "same-branch": "every jawan works in the one clone on the project's branch",
    "branch-per-task": "one clone, a toli/<T-id> branch and PR/MR per task",
    "worktree-per-task": "a worktree under projects/.worktrees and a branch and PR/MR per task",
};

function workspaceText(project: Project): string {
    const standing = project.workspace === "same-branch" ? "" : `; standing grant: ${standingText(project.standing)}`;
    return `${project.workspace} (${WORKSPACE_TEXT[project.workspace]}${standing})`;
}
function branchExists(dir: string, branch: string): boolean {
    return ["refs/heads/", "refs/remotes/origin/"].some(
        (prefix) => git(dir, ["rev-parse", "--verify", "--quiet", `${prefix}${branch}`]).code === 0,
    );
}

function repoChecks(project: Project, deep: boolean): SetupCheck[] {
    const dir = paths.projectDir(project.name);
    const cloned = isGitRepo(dir);
    const checks: SetupCheck[] = [];
    const head = cloned ? currentBranch(dir) : null;
    const broken = brokenLink(project);
    checks.push(
        broken !== null
            ? { key: "clone", status: "missing", detail: broken, fill: "ask" }
            : cloned
              ? {
                    key: "clone",
                    status: "ok",
                    detail: `projects/${project.name}${project.linkedTo ? ` -> ${project.linkedTo}` : ""} on ${head ?? "a detached HEAD"}`,
                }
              : {
                    key: "clone",
                    status: "missing",
                    detail: "not cloned on this machine (bin/toli project ensure)",
                    fill: "jawan",
                },
    );
    checks.push(
        deliveryConfirmed(project)
            ? { key: "delivery", status: "ok", detail: deliveryText(project) }
            : {
                  key: "delivery",
                  status: "missing",
                  detail: `never chosen; defaulted to ${deliveryText(project)}`,
                  fill: "ask",
              },
    );
    checks.push(
        project.workspaceSetAt !== undefined
            ? { key: "workspace", status: "ok", detail: workspaceText(project) }
            : {
                  key: "workspace",
                  status: "missing",
                  detail: `never chosen; defaulted to ${workspaceText(project)}`,
                  fill: "ask",
              },
    );
    if (project.branch && cloned && !branchExists(dir, project.branch))
        checks.push({
            key: "branch",
            status: "missing",
            detail: `fixed branch ${project.branch} exists neither locally nor on origin`,
            fill: "ask",
        });
    else if (project.branch)
        checks.push({
            key: "branch",
            status: "ok",
            detail: `${project.branch}${head !== null && head !== project.branch ? ` (clone is on ${head})` : ""}`,
        });
    else checks.push({ key: "branch", status: "ok", detail: "no fixed branch" });

    const needsForge = project.mode !== "commit";
    if (!deep && !needsForge) return checks;
    try {
        const target = projectForge(project);
        checks.push({ key: "forge", status: "ok", detail: `${target.forge} at ${target.host} (${target.repo})` });
        if (deep) {
            const readiness = forgeReadiness(target.forge, target.host);
            checks.push({
                key: "forge-auth",
                status: readiness.ready ? "ok" : needsForge ? "missing" : "optional",
                detail: readiness.detail,
                ...(readiness.ready ? {} : { fill: "ask" as const }),
            });
        }
    } catch (error) {
        checks.push({
            key: "forge",
            status: needsForge ? "missing" : "optional",
            detail: error instanceof Error ? error.message : String(error),
            fill: "ask",
        });
    }
    if (project.mode === "no-mistakes" && cloned) {
        const gate = git(dir, ["remote", "get-url", "no-mistakes"]).code === 0;
        checks.push(
            gate
                ? { key: "no-mistakes", status: "ok", detail: "gate remote present" }
                : {
                      key: "no-mistakes",
                      status: "missing",
                      detail: "no `no-mistakes` remote: run `no-mistakes init` in the clone",
                      fill: "jawan",
                  },
        );
    }
    return checks;
}

function notesChecks(project: Project, at: Date): SetupCheck[] {
    const file = paths.projectNotes(project.name);
    const shown = `data/projects/${project.name}/notes.md`;
    if (!existsSync(file))
        return [{ key: "notes", status: "missing", detail: `${shown} does not exist`, fill: "jawan" }];
    const notes = readFileSync(file, "utf8");
    const found = sections(notes);
    const section = (key: SetupKey, heading: string, hint: string, fill: SetupCheck["fill"] = "ask"): SetupCheck =>
        found.has(heading.toLowerCase())
            ? { key, status: "ok", detail: `## ${heading} present` }
            : { key, status: "missing", detail: hint, fill };
    const command = (word: "test" | "smoke"): SetupCheck =>
        hasCommand(notes, word)
            ? { key: word, status: "ok", detail: `${word} command recorded` }
            : { key: word, status: "missing", detail: `no ${word} command in the notes`, fill: "jawan" };
    const ageDays = Math.floor((at.getTime() - statSync(file).mtime.getTime()) / DAY_MS);
    return [
        { key: "notes", status: "ok", detail: shown },
        command("test"),
        command("smoke"),
        section("local-stack", "Local stack", "no `## Local stack` section (commands, or `- None`)", "jawan"),
        section("urls", "URLs", "no `## URLs` section (local/staging URLs, or `- None`)"),
        section("proof", "Proof", "no `## Proof` section (evidence, screenshot widths)"),
        ageDays > STALE_DAYS.aging
            ? {
                  key: "freshness",
                  status: "stale",
                  detail: `notes last changed ${ageDays} days ago; re-check against the repo`,
                  fill: "jawan",
              }
            : { key: "freshness", status: "ok", detail: `notes changed ${ageDays} day${ageDays === 1 ? "" : "s"} ago` },
    ];
}

/**
 * The setup checklist for one project. `deep` also detects the forge in commit mode and checks forge auth (runs
 * `gh`/`glab auth status`, which may touch the network); the shallow form is local-only and cheap enough for digest.
 */
export function setupChecklist(project: Project, deep: boolean, at: Date = now()): SetupReport {
    const checks = [...repoChecks(project, deep), ...notesChecks(project, at)];
    return { project: project.name, ready: !checks.some((check) => GAPS.includes(check.status)), checks };
}

/** Projects with at least one missing or stale item (shallow checks only): for digest's "N projects need setup". */
export function projectsNeedingSetup(at: Date = now()): { name: string; missing: SetupKey[] }[] {
    return loadProjects()
        .map((project) => setupChecklist(project, false, at))
        .filter((report) => !report.ready)
        .map((report) => ({
            name: report.project,
            missing: report.checks.filter((check) => GAPS.includes(check.status)).map((check) => check.key),
        }));
}

const MARK: Record<CheckStatus, string> = { ok: "[x]", missing: "[ ]", stale: "[~]", optional: "[-]" };

function renderReport(report: SetupReport): string {
    const lines = [`${report.project}: ${report.ready ? "set up" : "needs setup"}`];
    for (const check of report.checks)
        lines.push(
            `  ${MARK[check.status]} ${check.key.padEnd(12)} ${check.detail}${check.fill ? ` (${check.fill === "ask" ? "ask the user" : "jawan"})` : ""}`,
        );
    return lines.join("\n");
}

/** `toli project setup <name> [--json]` | `toli project setup --all [--json]`. */
export function projectSetupCommand(argv: string[]): void {
    const args = new Args(argv, { booleans: ["all", "json"] });
    args.maxPositional(1);
    if (args.bool("all")) {
        if (args.positional.length > 0) throw new ToliError("project setup takes a name or --all, not both");
        const needing = projectsNeedingSetup();
        if (args.bool("json")) {
            printJson(needing);
            return;
        }
        const total = loadProjects().length;
        out(`${needing.length} of ${total} project${total === 1 ? "" : "s"} need setup`);
        for (const entry of needing) out(`  ${entry.name}\t${entry.missing.join(", ")}`);
        if (needing.length > 0) out("details: bin/toli project setup <name>; flow: /setup-project <name>");
        return;
    }
    const report = setupChecklist(findProject(args.pos(0, "name")), true);
    if (args.bool("json")) printJson(report);
    else out(renderReport(report));
}
