import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { Args } from "./args.ts";
import { loadBacklog, type Task } from "./backlog.ts";
import { paths } from "./paths.ts";
import { loadProjects } from "./projects.ts";
import { isValidName, out, printJson, readJson, ToliError, withLock, writeTextAtomic } from "./util.ts";

/**
 * One-time move of the old flat data layout into one directory per project:
 *   data/notes/<p>.md            -> data/projects/<p>/notes.md
 *   data/reports/T<n>.md         -> data/projects/<task's project>/reports/T<n>.md
 *   data/remote/<stamp>-<m>.md   -> data/projects/<p>/runs/<stamp>-<m>.md  (when the file names its project)
 *   data/briefs/<file>.md        -> data/projects/<p>/briefs/<file>.md     (the project of the job using it, else
 *                                   the project the file name names; ambiguous names stay)
 *   data/malik.md                -> data/preferences.md                    (the persona-named preferences file)
 *   data/archive/malik.md        -> data/archive/preferences.md            (its archived entries)
 * Everything else stays where it is. Nothing is ever overwritten: a different file already at a destination is a
 * conflict and the whole migration refuses; an identical one makes the old copy a duplicate that is removed.
 */

export type MoveKind = "notes" | "report" | "run" | "brief" | "preferences";

/** The preferences file's old, persona-named location (before it became data/preferences.md). */
const LEGACY_PREFERENCES = "malik.md";

/** Repo-relative paths. `duplicate`: the destination already holds identical bytes, so the source is just removed. */
export type MigrationMove = { kind: MoveKind; from: string; to: string; duplicate: boolean };

export type MigrationKeep = { path: string; reason: string };

export type ReferenceRewrite = { file: string; references: number };

export type MigrationPlan = {
    moves: MigrationMove[];
    conflicts: MigrationMove[];
    kept: MigrationKeep[];
    /** Files whose text mentions a moved path; the mention is rewritten to the new path. */
    references: ReferenceRewrite[];
};

const TASK_REPORT = /^(T\d+)\.md$/;
const RUN_PROJECT = /^- project: (\S+)\s*$/m;

const rel = (path: string): string => relative(paths.root(), path);

function mdFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((name) => name.endsWith(".md") && statSync(join(dir, name)).isFile())
        .sort();
}

/** Task id -> project, from the live backlog and the archived tasks. */
function taskProjects(): Map<string, string> {
    const archived = readJson<{ tasks?: Task[] }>(paths.archive("tasks.json"), {}).tasks ?? [];
    return new Map([...archived, ...loadBacklog().tasks].map((task) => [task.id, task.project]));
}

/** Every project name toli knows of: registered, named by a task, with notes, or with a data directory. */
function knownProjects(tasks: Map<string, string>): Set<string> {
    const names = new Set<string>([...loadProjects().map((project) => project.name), ...tasks.values()]);
    for (const file of mdFiles(join(paths.root(), "data", "notes"))) names.add(file.replace(/\.md$/, ""));
    const base = paths.projectsDataDir();
    if (existsSync(base))
        for (const entry of readdirSync(base, { withFileTypes: true })) if (entry.isDirectory()) names.add(entry.name);
    return new Set([...names].filter(isValidName));
}

/** Brief file name -> project, from scheduled jobs whose prompt names `data/briefs/<file>` and that carry a project. */
function jobBriefProjects(): Map<string, string> {
    const jobs = readJson<{ jobs?: { prompt?: string; project?: string }[] }>(paths.jobsConfig(), {}).jobs ?? [];
    const owners = new Map<string, string>();
    for (const job of jobs) {
        if (job.project === undefined || job.prompt === undefined) continue;
        for (const match of job.prompt.matchAll(/data\/briefs\/([^\s`'"]+\.md)/g))
            if (match[1] !== undefined) owners.set(match[1], job.project);
    }
    return owners;
}

/**
 * A brief's project: the project of the scheduled job that uses it; else the project whose name is the file stem;
 * else the one project whose name is a `<project>-` prefix. Several prefixes (kalki, kalki-release) are ambiguous.
 */
function briefProject(
    file: string,
    projects: Set<string>,
    jobOwners: Map<string, string>,
): { project: string } | { reason: string } {
    const owner = jobOwners.get(file);
    if (owner !== undefined && isValidName(owner)) return { project: owner };
    const stem = file.replace(/\.md$/, "");
    if (projects.has(stem)) return { project: stem };
    const prefixed = [...projects].filter((project) => stem.startsWith(`${project}-`)).sort();
    const [only] = prefixed;
    if (prefixed.length === 1 && only !== undefined) return { project: only };
    return {
        reason:
            prefixed.length === 0
                ? "brief names no known project"
                : `brief name fits several projects (${prefixed.join(", ")})`,
    };
}

function sameBytes(a: string, b: string): boolean {
    return readFileSync(a).equals(readFileSync(b));
}

/**
 * Files that may mention old data paths: job prompts, task notes, always-loaded memory, and every project's notes and
 * briefs (the live instructions). Reports and archives are records and keep their wording.
 */
function referenceFiles(moves: MigrationMove[], applied: boolean): string[] {
    const looseBriefs = join(paths.root(), "data", "briefs");
    const files = [
        paths.jobsConfig(),
        paths.backlog(),
        paths.preferences(),
        paths.learnings(),
        ...mdFiles(looseBriefs).map((file) => join(looseBriefs, file)),
    ];
    const base = paths.projectsDataDir();
    if (existsSync(base))
        for (const entry of readdirSync(base, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            files.push(paths.projectNotes(entry.name));
            const briefs = paths.projectBriefsDir(entry.name);
            files.push(...mdFiles(briefs).map((file) => join(briefs, file)));
        }
    // Live files that are themselves moving are rewritten at their new path; dry runs read them at the old one.
    const preferences = rel(paths.preferences());
    if (!applied)
        for (const move of moves)
            if ((move.kind === "notes" || move.to === preferences) && !move.duplicate)
                files.push(join(paths.root(), move.from));
    return [...new Set(files)].filter((file) => existsSync(file));
}

/** Old -> new path pairs, longest first so no replacement clips a longer path. */
function replacements(moves: MigrationMove[]): [string, string][] {
    return moves
        .map((move): [string, string] => [move.from, move.to])
        .sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]));
}

function rewrite(text: string, pairs: [string, string][]): { text: string; count: number } {
    let count = 0;
    let result = text;
    for (const [from, to] of pairs) {
        const parts = result.split(from);
        count += parts.length - 1;
        result = parts.join(to);
    }
    return { text: result, count };
}

function referenceRewrites(moves: MigrationMove[], applied: boolean): ReferenceRewrite[] {
    const pairs = replacements(moves);
    if (pairs.length === 0) return [];
    return referenceFiles(moves, applied)
        .map((file) => ({ file: rel(file), references: rewrite(readFileSync(file, "utf8"), pairs).count }))
        .filter((entry) => entry.references > 0);
}

export function planMigration(): MigrationPlan {
    const tasks = taskProjects();
    const projects = knownProjects(tasks);
    const moves: MigrationMove[] = [];
    const kept: MigrationKeep[] = [];
    const candidate = (kind: MoveKind, from: string, to: string): void => {
        const duplicate = existsSync(to) && sameBytes(from, to);
        moves.push({ kind, from: rel(from), to: rel(to), duplicate });
    };

    const notesDir = join(paths.root(), "data", "notes");
    for (const file of mdFiles(notesDir)) {
        const project = file.replace(/\.md$/, "");
        if (isValidName(project)) candidate("notes", join(notesDir, file), paths.projectNotes(project));
        else kept.push({ path: rel(join(notesDir, file)), reason: "not a valid project name" });
    }

    for (const file of mdFiles(paths.reportsDir())) {
        const path = join(paths.reportsDir(), file);
        const id = TASK_REPORT.exec(file)?.[1];
        if (id === undefined) {
            kept.push({ path: rel(path), reason: "toli-wide report" });
            continue;
        }
        const project = tasks.get(id);
        if (project !== undefined && isValidName(project)) candidate("report", path, paths.projectReport(project, id));
        else kept.push({ path: rel(path), reason: `task ${id} not found in the backlog or task archive` });
    }

    for (const file of mdFiles(paths.remoteDir())) {
        const path = join(paths.remoteDir(), file);
        const project = RUN_PROJECT.exec(readFileSync(path, "utf8"))?.[1];
        if (project !== undefined && isValidName(project))
            candidate("run", path, join(paths.projectRunsDir(project), file));
        else kept.push({ path: rel(path), reason: "remote run names no project" });
    }

    const briefsDir = join(paths.root(), "data", "briefs");
    const jobOwners = jobBriefProjects();
    for (const file of mdFiles(briefsDir)) {
        const path = join(briefsDir, file);
        const owner = briefProject(file, projects, jobOwners);
        if ("project" in owner) candidate("brief", path, join(paths.projectBriefsDir(owner.project), file));
        else kept.push({ path: rel(path), reason: owner.reason });
    }

    const legacyPreferences = join(paths.root(), "data", LEGACY_PREFERENCES);
    if (existsSync(legacyPreferences)) candidate("preferences", legacyPreferences, paths.preferences());
    const legacyArchive = paths.archive(LEGACY_PREFERENCES);
    if (existsSync(legacyArchive)) candidate("preferences", legacyArchive, paths.archive("preferences.md"));

    const conflicts = moves.filter((move) => !move.duplicate && existsSync(join(paths.root(), move.to)));
    const clean = moves.filter((move) => !conflicts.includes(move));
    return { moves: clean, conflicts, kept, references: referenceRewrites(clean, false) };
}

/** Remove now-empty old directories (never one that still holds anything). */
function removeEmptyDirs(): void {
    for (const dir of [join(paths.root(), "data", "notes"), paths.remoteDir(), join(paths.root(), "data", "briefs")])
        if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
}

/** Apply a conflict-free plan: move (or drop identical duplicates), then rewrite path mentions. */
export function applyMigration(plan: MigrationPlan): ReferenceRewrite[] {
    if (plan.conflicts.length > 0)
        throw new ToliError(
            `refusing to migrate: ${plan.conflicts.length === 1 ? "1 destination already exists" : `${plan.conflicts.length} destinations already exist`} with different content:\n${plan.conflicts.map((move) => `  ${move.from} -> ${move.to}`).join("\n")}\nresolve them by hand (merge or remove one copy), then rerun`,
        );
    for (const move of plan.moves) {
        const from = join(paths.root(), move.from);
        const to = join(paths.root(), move.to);
        if (move.duplicate) {
            if (!sameBytes(from, to)) throw new ToliError(`${move.to} changed during migration; rerun`);
            rmSync(from);
            continue;
        }
        if (existsSync(to)) throw new ToliError(`${move.to} appeared during migration; rerun`);
        mkdirSync(dirname(to), { recursive: true });
        renameSync(from, to);
    }
    const pairs = replacements(plan.moves);
    const rewrites: ReferenceRewrite[] = [];
    if (pairs.length > 0)
        for (const file of referenceFiles(plan.moves, true)) {
            const result = rewrite(readFileSync(file, "utf8"), pairs);
            if (result.count === 0) continue;
            writeTextAtomic(file, result.text);
            rewrites.push({ file: rel(file), references: result.count });
        }
    removeEmptyDirs();
    return rewrites;
}

function render(plan: MigrationPlan, applied: boolean): string {
    const lines: string[] = [];
    const moved = plan.moves.length;
    if (moved === 0 && plan.conflicts.length === 0) lines.push("migrate: nothing to move; the layout is current");
    else
        lines.push(
            `migrate${applied ? "" : " (dry run)"}: ${moved} file${moved === 1 ? "" : "s"} ${applied ? "moved" : "to move"}, ${plan.conflicts.length} conflict${plan.conflicts.length === 1 ? "" : "s"}`,
        );
    for (const move of plan.moves)
        lines.push(
            move.duplicate
                ? `  remove ${move.from} (identical copy already at ${move.to})`
                : `  move   ${move.from} -> ${move.to}`,
        );
    for (const move of plan.conflicts) lines.push(`  CONFLICT ${move.from} -> ${move.to} (destination differs)`);
    for (const entry of plan.references)
        lines.push(`  rewrite ${entry.file} (${entry.references} path reference${entry.references === 1 ? "" : "s"})`);
    if (plan.kept.length > 0) {
        lines.push("kept in place:");
        for (const entry of plan.kept) lines.push(`  ${entry.path} (${entry.reason})`);
    }
    if (!applied && moved > 0 && plan.conflicts.length === 0)
        lines.push("nothing changed; run `bin/toli migrate` to apply");
    return lines.join("\n");
}

/** `toli migrate [--dry-run] [--json]`. */
export function migrateCommand(argv: string[]): void {
    const args = new Args(argv, { booleans: ["dry-run", "json"] });
    args.maxPositional(0);
    const dryRun = args.bool("dry-run");
    withLock(paths.lock("migrate"), () => {
        const plan = planMigration();
        if (dryRun) {
            if (args.bool("json")) printJson({ applied: false, ...plan });
            else out(render(plan, false));
            return;
        }
        const references = applyMigration(plan);
        const done = { ...plan, references };
        if (args.bool("json")) printJson({ applied: true, ...done });
        else out(render(done, true));
    });
}
