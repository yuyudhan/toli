import { Args } from "./args.ts";
import { type Persona, persona, personaLine } from "./persona.ts";
import { out } from "./util.ts";

/** Names for tracked, installation-independent files (harness rule files); live sessions use the configured persona. */
export const GENERIC_NAMES: Persona = {
    user: "the user",
    lead: "the lead",
    leadPlural: "leads",
    worker: "jawan",
    workerPlural: "jawans",
};

/** The few rules a long lead chat tends to drift from, one bullet each. */
export function guidanceRules(names: Persona): string[] {
    return [
        `- Record every request that implies work as a task first, in this same turn, even small ones and mid-conversation asides: \`bin/toli task add <project> "<title>" --note "<${names.user}'s words>"\`. Questions you answer from toli's records need no task.`,
        `- Delegate everything: reading project code, edits, checks, commits, reports, and changes to toli itself go to ${names.workerPlural}. Load the toli-dispatch skill before every dispatch.`,
        `- Dispatch in the background (your harness's async subagents, or \`bin/toli spawn --harness <h> --task <id> --brief <file>\`) and record the ${names.worker} on the task (\`bin/toli task start <id> --agent <agent-id>\`; spawn records its run itself). Reply to ${names.user} in one or two lines and end the turn.`,
        `- Never wait on or poll ${names.workerPlural}; their results arrive as new turns ([toli wake] messages).`,
        `- What waits on ${names.user} lives only in the Needs-you queue (\`bin/toli needs\`): raise it batched at session start, after results that add questions, or when asked, never repeated every turn; record replies verbatim with \`bin/toli task answer\` and dispatch the unblocked task at once.`,
        "- Your own tools: bin/toli bookkeeping (task, digest, inbox/job ack, project list, runs) and toli's skills. `bin/toli digest` ends with a Next block of recommended actions.",
    ];
}

/**
 * The per-turn reminder for the lead session. The omp extension appends it to the lead's system prompt every
 * turn, the Claude Code UserPromptSubmit hook adds it as context, and harnesses without a per-turn hook get the
 * generic form in their rule file (`bin/toli harness sync`).
 */
export function leadGuidance(names: Persona = persona()): string {
    return [`[toli] You are the lead (${names.lead}) in toli. ${personaLine(names)}`, ...guidanceRules(names)].join(
        "\n",
    );
}

/** `toli guidance`: print the lead reminder (what the extension and hooks inject). */
export function guidanceCommand(argv: string[]): void {
    new Args(argv).maxPositional(0);
    out(leadGuidance());
}
