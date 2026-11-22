// One merge run per release tag and project clone (docs/projects.md "Release catch-up"). A project's release catch-up
// run (src/projects/catch-up.ts, recorded with `catchUp: <tag>`) and a run another source starts for the same release
// (a scheduled job's merge brief, a lead's spawn) never both wait or work on one clone. `bin/toli spawn` asks
// `refuseOwnedTag` under the jawan-slots lock it records runs under (src/jawans/launch.ts startOrQueue), so of two
// starts in the same second the later one sees the first; the catch-up scan also asks first, as one of its holds
// (src/projects/catch-up-hold.ts standDown).
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { paths } from "../core/paths.ts";
import { ToliError } from "../core/util.ts";
import { baseBriefOf } from "./launch.ts";
import { activeRuns, type JawanRun } from "./runs.ts";

/** Whether `text` names release `tag` as a whole word: `v1.0.0`, never `v1.0.01` or `v1.0.0.1`. */
export function namesTag(text: string, tag: string): boolean {
    return new RegExp(`(?<![\\w.])${tag.replaceAll(".", "\\.")}(?!\\w|\\.\\d)`).test(text);
}

/** A run as tagOwner compares it: a recorded run, or the one a spawn is about to record. */
export type TagClaim = {
    project: string | null;
    cwd: string;
    /** The run's brief before generated sections; its title line is part of it. */
    brief: string;
    /** The release a catch-up run merges; absent on any other run. */
    catchUp?: string | undefined;
};

/** The queued or live run that owns a release tag, and why. */
export type TagOwner = { run: JawanRun; why: string };

function real(path: string): string {
    return existsSync(path) ? realpathSync(path) : resolve(path);
}

/**
 * The project whose clone a run works in: its own project, else the one whose clone (or task worktree,
 * projects/.worktrees/<p>/<T>) holds its cwd; null for a run outside every clone.
 */
function projectOf(run: Pick<TagClaim, "project" | "cwd">): string | null {
    if (run.project !== null) return run.project;
    const inside = relative(real(join(paths.root(), "projects")), real(run.cwd));
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return null;
    const [first = "", second] = inside.split(sep);
    return first === ".worktrees" ? (second ?? null) : first;
}

/** A run's base brief; a record whose brief files are gone names nothing. */
function briefOf(run: JawanRun): string {
    try {
        return baseBriefOf(run);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
    }
}

/**
 * The queued or live run of the same project clone that already owns the merge `claim` would make, or null; never
 * the calling run (TOLI_RUN_ID). A catch-up claim (`catchUp`) is owned by any run whose brief names its tag; any
 * other claim only by a catch-up run whose tag the claim's brief names.
 */
export function tagOwner(claim: TagClaim, runs: JawanRun[] = activeRuns()): TagOwner | null {
    const project = projectOf(claim);
    if (project === null) return null;
    const self = process.env.TOLI_RUN_ID;
    for (const run of runs) {
        if (run.id === self || projectOf(run) !== project) continue;
        if (claim.catchUp !== undefined) {
            if (namesTag(briefOf(run), claim.catchUp))
                return { run, why: `run ${run.id} (${run.status}) names ${claim.catchUp} in its brief` };
        } else if (run.catchUp !== undefined && namesTag(claim.brief, run.catchUp))
            return { run, why: `release catch-up run ${run.id} (${run.status}) merges ${run.catchUp} on ${project}` };
    }
    return null;
}

/** A spawn refused because another queued or live run owns its release tag (`owner`). */
export class TagOwnedError extends ToliError {
    readonly owner: TagOwner;
    constructor(owner: TagOwner) {
        super(
            `refusing: ${owner.why}; one merge run per release tag and clone. Steer it (\`write agent://${owner.run.id}\`) or spawn once it has ended`,
        );
        this.name = "TagOwnedError";
        this.owner = owner;
    }
}

/** Throw TagOwnedError when another run owns `claim`'s release tag (tagOwner). */
export function refuseOwnedTag(claim: TagClaim): void {
    const owner = tagOwner(claim);
    if (owner !== null) throw new TagOwnedError(owner);
}
