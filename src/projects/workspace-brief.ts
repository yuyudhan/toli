// The workspace block `bin/toli spawn` appends to a brief (src/jawans/spawn.ts), from the workspace
// src/projects/workspace.ts prepared and recorded on the task.
import type { TaskWorkspace } from "../records/backlog.ts";
import { perTask } from "./strategy.ts";

/** Markdown block spawn appends to a brief so the jawan works where the workspace was prepared. */
export function workspaceBrief(project: string, taskId: string, workspace: TaskWorkspace): string {
    const commit =
        perTask(workspace.strategy) || workspace.pinned === true
            ? `bin/toli commit ${project} --task ${taskId} -m "<message>" -- <paths...>`
            : `bin/toli commit ${project} -m "<message>" -- <paths...>`;
    return [
        "",
        "## Workspace (prepared by bin/toli spawn)",
        "",
        `- Strategy: ${workspace.strategy}`,
        `- Path: ${workspace.path} - work and run the project's commands here, not in any other checkout`,
        `- Branch: ${workspace.branch ?? "the checked-out branch"}${workspace.base === null ? "" : `, from ${workspace.base}`} - stay on it`,
        `- Commit (only where the Landing section allows it): ${commit}`,
        "",
    ].join("\n");
}
