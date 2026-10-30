// The digest's Next block: concrete recommended actions for the lead, computed from an already-built digest. Pure, and
// kept apart from digest.ts so tests can call it in-process without loading every record and job module.
import type { Harness } from "../harness/harness.ts";
import { SPECS } from "../harness/harness.ts";
import type { Task } from "./backlog.ts";
import type { Digest, ProjectDigest } from "./digest.ts";
import type { Needs } from "./needs.ts";

export type NextAction = { action: string; command: string };

/** "Setup: N steps remain": the head of the setup notice and of the Next block's setup action. */
export function setupRemaining(remaining: number, label = "Setup"): string {
    return `${label}: ${remaining} step${remaining === 1 ? "" : "s"} remain${remaining === 1 ? "s" : ""}`;
}

export type NextInput = {
    projects: ProjectDigest[];
    backlog: Digest["backlog"];
    needs: Needs;
    unseenResults: number;
    urls: Map<string, string>;
    setup: { name: string; missing: string[] }[];
    /** Titles of this machine's missing install-level setup steps (src/setup/checklist.ts). */
    setupSteps: string[];
    /** The user snoozed setup (`bin/toli setup snooze`): the setup action stays a quiet one-liner. */
    setupSnoozed: boolean;
    missingHarnesses: Harness[];
    /** Active tasks with no recorded jawan, or whose `bin/toli spawn` run has ended. */
    unattended: Task[];
};

const NEXT_LIST_LIMIT = 5;

/** Concrete recommended actions for the lead, most urgent first, each naming the exact skill or command. */
export function nextActions(input: NextInput): NextAction[] {
    const actions: NextAction[] = [];
    const items = input.needs.groups.flatMap((group) => group.items);
    const asked = items.filter((item) => item.question !== null);
    if (asked.length > 0)
        actions.push({
            action:
                asked.length === 1
                    ? `Ask the user about ${asked[0]?.id} (${asked[0]?.project}): ${asked[0]?.question}`
                    : `Ask the user the ${asked.length} Needs-you questions together as one numbered list (${asked.map((item) => item.id).join(", ")})`,
            command: `bin/toli needs; record each reply verbatim with bin/toli task answer T<n> "<answer>" and dispatch the unblocked task at once (the toli-ahoy skill)`,
        });
    for (const item of items.filter((entry) => entry.question === null).slice(0, NEXT_LIST_LIMIT))
        actions.push({
            action: `${item.id} (${item.project}) is held with no question, so the user cannot answer it`,
            command: `get the question from its jawan or report, then bin/toli task hold ${item.id} --question "..." --option "<choice> => <then>"`,
        });
    if (input.unseenResults > 0)
        actions.push({
            action: `Relay ${input.unseenResults} new result${input.unseenResults === 1 ? "" : "s"} to the user in plain words`,
            command: "then bin/toli inbox ack / bin/toli job ack (follow-up work goes to a jawan)",
        });
    for (const project of input.projects.filter((entry) => entry.branchMismatch))
        actions.push({
            action: `Tell the user ${project.name} is off its working branch ${project.branch} (on ${project.status?.branch ?? "?"})`,
            command: "never switch it yourself; the user may switch back or change it with bin/toli project set",
        });
    for (const task of input.unattended.slice(0, NEXT_LIST_LIMIT))
        actions.push({
            action: `${task.id} (${task.project}) is active but no running jawan is recorded on it${task.agent ? ` (last: ${task.agent})` : ""}`,
            command: `dispatch one and record it (bin/toli task start ${task.id} --agent <id>, or bin/toli spawn --task ${task.id} --brief <file>), or hold/drop it`,
        });
    for (const task of input.backlog.queued.slice(0, NEXT_LIST_LIMIT))
        actions.push({
            action: `Dispatch ${task.id} (${task.project}, ${task.shape}): ${task.title}`,
            command: `load the toli-dispatch skill, then a background jawan recorded on the task (bin/toli task start ${task.id} --agent <id>, or bin/toli spawn --task ${task.id} --brief <file>)`,
        });
    for (const project of input.projects.filter((entry) => !entry.cloned))
        actions.push({
            action: `Clone ${project.name} on this machine`,
            command: `dispatch a jawan to run bin/toli project ensure ${project.name} ${input.urls.get(project.name) ?? "<git-url>"}`,
        });
    if (input.setup.length > 0)
        actions.push({
            action: `${input.setup.length} project${input.setup.length === 1 ? " needs" : "s need"} setup (${input.setup
                .slice(0, NEXT_LIST_LIMIT)
                .map((entry) => `${entry.name}: ${entry.missing.join(", ")}`)
                .join("; ")})`,
            command: `/setup-project ${input.setup[0]?.name ?? "<name>"} (the toli-projects skill; bin/toli project setup --all)`,
        });
    for (const harness of input.missingHarnesses)
        actions.push({
            action: `Install ${SPECS[harness].label}: config/machine.json routes jawans to it`,
            command: `${SPECS[harness].install}; then ${SPECS[harness].login} (docs/harnesses.md), or change harness in config/machine.json`,
        });
    if (input.setupSteps.length > 0 && input.setupSnoozed)
        actions.push({
            action: setupRemaining(input.setupSteps.length, "Setup snoozed"),
            command: "bin/toli setup status lists them",
        });
    else if (input.setupSteps.length > 0)
        actions.push({
            action: `${setupRemaining(input.setupSteps.length)} (${input.setupSteps.slice(0, NEXT_LIST_LIMIT).join(", ")}${input.setupSteps.length > NEXT_LIST_LIMIT ? ", ..." : ""})`,
            command: 'say "set up toli" to close them (the toli-setup skill; bin/toli setup status lists them)',
        });
    if (actions.length === 0)
        actions.push({ action: "Nothing pending", command: "greet the user and wait for a request" });
    return actions;
}
