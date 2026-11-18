// A per-task project toggled to same-branch under a live task (T1904): `project set` records the toggle
// (`workspaceToggle`, src/projects/set.ts) and `workspace prepare` refuses new records while it lasts, since a task
// prepared then would be recorded on the shared clone for good.
import { persona } from "../core/persona.ts";
import { ToliError } from "../core/util.ts";
import { loadBacklog, type Task } from "../records/backlog.ts";
import type { Project } from "./projects.ts";
import type { Workspace } from "./strategy.ts";

/** Statuses whose jawans may still be using the workspace. */
export const LIVE: readonly Task["status"][] = ["active", "held"];

/** Live tasks of the project (but `except`) whose recorded workspace was prepared under `strategy`. */
export function liveUnder(project: string, strategy: Workspace, except?: string): Task[] {
    return loadBacklog().tasks.filter(
        (other) =>
            other.id !== except &&
            other.project === project &&
            LIVE.includes(other.status) &&
            other.workspace?.strategy === strategy,
    );
}

/** Refuse to record a workspace for `taskId` while the project is toggled to same-branch. */
export function refuseWhileToggled(project: Project, taskId: string): void {
    const toggle = project.workspaceToggle;
    if (toggle === undefined) return;
    const live = liveUnder(project.name, toggle.from, taskId);
    const why =
        live.length === 0
            ? `no live task works under ${toggle.from} any more`
            : `${live.map((other) => `${other.id} (${other.status})`).join(", ")} still works under it`;
    throw new ToliError(
        `refusing to prepare ${taskId}: projects/${project.name} is toggled from ${toggle.from} to ` +
            `${project.workspace} since ${toggle.at} (${why}), so ${taskId} would be recorded on the shared clone. ` +
            `Switch it back (bin/toli project set ${project.name} --workspace ${toggle.from}), or keep ` +
            `${project.workspace} for new tasks too on ${persona().user}'s word: ` +
            `bin/toli project set ${project.name} --workspace ${project.workspace} --keep.`,
    );
}
