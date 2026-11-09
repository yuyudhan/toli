// Pure helpers for how a jawan run stops and continues: the Deadline section a brief gets when its run has an explicit
// `--max-time`, whether a finished run stopped without a report, and what its continuation is told: the prompt that
// resumes the same omp session, or the RESUME section of a fresh run on harnesses toli cannot resume.

/**
 * Lines around a run that are not the jawan's answer: omp's MCP warnings and spinner, and toli's own `[toli]` notes
 * (a stall, a limit retry) that the supervisor writes into the log.
 */
const HARNESS_NOISE: readonly RegExp[] = [/^Warning: /, /^Working\.\.\.$/, /^\[toli\] /];

/** How long before its limit a jawan is asked to have written its report. */
export const REPORT_MARGIN_MINUTES = 10;

/** Whether the run's output holds anything beyond harness warnings: a final answer, i.e. a report. */
export function hasReport(output: string): boolean {
    return output
        .split("\n")
        .map((line) => line.trim())
        .some((line) => line !== "" && !HARNESS_NOISE.some((noise) => noise.test(line)));
}

/**
 * Whether a run lasting `elapsedMs` used up its `maxMinutes` limit: the supervisor killed it for time, or it lasted
 * at least 95% of the limit (omp's own `--max-time` stops it at the limit and exits 0).
 */
export function usedTimeLimit(
    elapsedMs: number,
    maxMinutes: number,
    minuteMs: number,
    killedForTime: boolean,
): boolean {
    return killedForTime || elapsedMs >= maxMinutes * minuteMs * 0.95;
}

/** `14:30 GMT+5:30 (2026-11-04T09:00:00.000Z)`: the local wall-clock time with its UTC instant. */
export function clockText(at: Date): string {
    const local = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
    return `${local.format(at)} (${at.toISOString()})`;
}

/** The section appended to the brief when the run starts: its wall-clock limit and when to have reported by. */
export function deadlineSection(startedAt: Date, maxMinutes: number, minuteMs: number): string {
    // Under 20 minutes, halfway: a 1-minute limit asks for the report after 30 seconds, not at the limit.
    const margin = Math.min(REPORT_MARGIN_MINUTES, maxMinutes / 2);
    const limit = new Date(startedAt.getTime() + maxMinutes * minuteMs);
    const reportBy = new Date(limit.getTime() - margin * minuteMs);
    return [
        "",
        "## Deadline (auto)",
        "",
        `This run started at ${clockText(startedAt)} and is stopped at its ${maxMinutes}-minute time limit, at ${clockText(limit)}.`,
        `Write your report (the brief's Report section, also as your final message) by ${clockText(reportBy)}, ${margin} minutes before the limit, even if the work is not finished: what is done, what is left, and what is uncommitted.`,
        "A run stopped by its limit without a report is resumed, which costs a restart of its session.",
        "",
    ].join("\n");
}

export type ResumeFacts = {
    /** The continuation's place in the chain, 1 for the first. */
    number: number;
    /** Most automatic continuations a chain may get (config/machine.json capacity.autoResume); null for the lead's. */
    cap: number | null;
    previousRun: string;
    /** How the previous run stopped: `hit its 180-minute time limit`, `stalled: no progress for 30 minutes (...)`. */
    stopped: string;
    cwd: string;
    previousLog: string;
};

function placeText(facts: ResumeFacts): string {
    return facts.cap === null
        ? `This continuation ${facts.number} was started by the lead.`
        : `This is automatic continuation ${facts.number} of at most ${facts.cap}.`;
}

/** The section a fresh continuation's brief gets after the original brief (harnesses whose session is not resumed). */
export function resumeSection(facts: ResumeFacts): string {
    return [
        "",
        `## RESUME (auto, ${facts.number})`,
        "",
        `The previous run of this brief (${facts.previousRun}) ${facts.stopped} without writing a report. ${placeText(facts)}`,
        `- Its edits are uncommitted in the working tree, ${facts.cwd}: start with \`git status\` and \`git diff\`, keep the finished work, and do not redo or revert it.`,
        `- Its log: ${facts.previousLog}`,
        "- Continue from there to the brief's Stop when, and end with the brief's report as your final message.",
        "",
    ].join("\n");
}

/**
 * The prompt that resumes the same omp session: the session already holds the brief and all the work so far, so it
 * only says why it stopped and to carry on. It starts with the brief header, so the resumed session stays a jawan.
 */
export function continuePrompt(facts: ResumeFacts, note?: string): string {
    return [
        "TOLI_BRIEF v1",
        `## RESUME (${facts.cap === null ? "lead" : "auto"}, ${facts.number})`,
        "",
        `Your run ${facts.previousRun} ${facts.stopped} before you wrote your report. ${placeText(facts)} This is the same session: everything above is still your work.`,
        `- Continue from where you stopped; do not redo finished work (\`git status\` and \`git diff\` in ${facts.cwd} show what is uncommitted).`,
        "- Background jobs, builds or subagents you started may have ended with the stop: check them before waiting on them.",
        "- Commit as you go, then finish the brief's goal and end with its report as your final message.",
        ...(note === undefined || note.trim() === "" ? [] : ["", note.trim()]),
        "",
    ].join("\n");
}
