// What keeps a jawan's `bin/toli task done|hold|drop` on its own task: a brief that names another id (a delegator's,
// a stale one) must never change an unrelated task on this machine, nor take its report path.
import { ToliError } from "../core/util.ts";
import type { Task } from "./backlog.ts";

/**
 * The task id a `done`, `hold` or `drop` names, refused when this process is a jawan `bin/toli spawn` started for
 * another task (`TOLI_TASK`, src/jawans/supervise.ts). The lead, and native subagents with its environment, have no
 * TOLI_TASK; their delegated briefs already name this machine's ids (src/fleet/delegation-receive.ts).
 */
export function ownTask(id: string): string {
    const own = process.env.TOLI_TASK ?? "";
    if (own !== "" && id.toUpperCase() !== own.toUpperCase())
        throw new ToliError(`this jawan runs for ${own}: only the lead changes ${id.toUpperCase()}`);
    return id;
}

/** Who runs a `task hold`, for the note on a closed task it reopens. */
export function holderName(): string {
    const own = process.env.TOLI_TASK ?? "";
    if (own !== "") return `${own.toUpperCase()}'s jawan`;
    return process.env.TOLI_LEAD_TURN ? "the lead" : "a command outside any jawan run";
}

/** `reports/T<n>.md` at the end of a report path: the task whose report it is. */
const REPORT_OF = /(?:^|[\\/])reports[\\/](T\d+)\.md$/i;

/** Refuse a `task done --report` path that is another task's report (`reports/T<n>.md` of a different `T<n>`). */
export function requireOwnReport(report: string | undefined, task: Pick<Task, "id" | "project">): void {
    const owner = report === undefined ? undefined : REPORT_OF.exec(report)?.[1]?.toUpperCase();
    if (owner !== undefined && owner !== task.id)
        throw new ToliError(
            `${report} is ${owner}'s report: ${task.id}'s goes in data/projects/${task.project}/reports/${task.id}.md`,
        );
}
