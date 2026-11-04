// Pure helpers for a jawan run's time limit: the Deadline section every spawned brief gets at launch, whether a
// finished run hit its limit without a report, and the RESUME section of the automatic continuation that follows.

/** Lines harnesses print around a run that are not the jawan's answer (omp: MCP warnings and its spinner). */
const HARNESS_NOISE: readonly RegExp[] = [/^Warning: /, /^Working\.\.\.$/];

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
        "A run stopped by its limit without a report is continued by a new run, which costs a whole new start.",
        "",
    ].join("\n");
}

export type ResumeFacts = {
    /** The continuation's place in the chain, 1 for the first. */
    number: number;
    /** Most continuations a chain may get (config/machine.json capacity.autoResume). */
    cap: number;
    previousRun: string;
    maxMinutes: number;
    cwd: string;
    previousLog: string;
};

/** The section a continuation's brief gets after the original brief. */
export function resumeSection(facts: ResumeFacts): string {
    return [
        "",
        `## RESUME (auto, ${facts.number})`,
        "",
        `The previous run of this brief (${facts.previousRun}) hit its ${facts.maxMinutes}-minute time limit without writing a report. This is automatic continuation ${facts.number} of at most ${facts.cap}.`,
        `- Its edits are uncommitted in the working tree, ${facts.cwd}: start with \`git status\` and \`git diff\`, keep the finished work, and do not redo or revert it.`,
        `- Its log: ${facts.previousLog}`,
        "- Continue from there to the brief's Stop when, and write the report before your own limit (Deadline below).",
        "",
    ].join("\n");
}
