// Continuing a jawan run that stopped without a report, or that the lead resumes (`bin/toli resume`): the same omp
// session is resumed (`omp --resume`) with a short continue prompt, or, on harnesses toli cannot resume, a fresh run
// of the brief gets a RESUME section. Each continuation is recorded on both runs and in the task's notes; past
// capacity.autoResume automatic continuations a chain stops and the inbox says why.
import { relative } from "node:path";
import type { Machine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, warn } from "../core/util.ts";
import { autoResumeLimit } from "../fleet/resources.ts";
import { notify } from "../jobs/outbox.ts";
import { loadBacklog, updateTask } from "../records/backlog.ts";
import { baseBriefOf, sessionFile, startOrQueue } from "./launch.ts";
import { continuePrompt, type ResumeFacts, resumeSection } from "./limits.ts";
import { type JawanRun, loadRun, updateRun } from "./runs.ts";

/** Add one line to the run's task notes, when the run has a task that is in the backlog. */
function noteOnTask(run: JawanRun, line: string): void {
    const task = run.task;
    if (task === null || !loadBacklog().tasks.some((entry) => entry.id === task)) return;
    try {
        updateTask(task, (entry) => {
            entry.notes.push(`${now().toISOString()} ${line}`);
        });
    } catch (error) {
        warn(`could not note on ${task}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export type ContinueOptions = {
    /** Why the run is continued: `stalled`, `time-limit`, `rate/usage limit` or `lead`. */
    reason: string;
    /** How it stopped, in words: `stalled: no progress for 30 minutes (...)`. */
    stopped: string;
    /** capacity.autoResume for automatic continuations; null when the lead asked (`bin/toli resume`). */
    cap: number | null;
    /** Start even when every jawan slot is busy. */
    now: boolean;
    /** The lead's words added to the resume prompt. */
    note?: string | undefined;
    /** Overrides the wall-clock limit the continuation inherits (`bin/toli resume --max-time`). */
    maxMinutes?: number | null | undefined;
};

/**
 * Start (or queue) the continuation of `run`: on omp with a session left behind, the same session resumed with a
 * short continue prompt (`omp --resume`), so nothing is re-read or redone; otherwise a fresh run of the same brief with
 * a RESUME section. Same task, project, cwd, harness and model. Recorded on both runs and in the task's notes.
 */
export function continueRun(run: JawanRun, options: ContinueOptions): JawanRun {
    const number = (run.resumeCount ?? 0) + 1;
    const facts: ResumeFacts = {
        number,
        cap: options.cap,
        previousRun: run.id,
        stopped: options.stopped,
        cwd: run.cwd,
        previousLog: run.logPath,
    };
    const session = run.harness === "omp" ? sessionFile(run.sessionDir) : null;
    const note = options.note === undefined || options.note.trim() === "" ? "" : `\n${options.note.trim()}\n`;
    const next = startOrQueue(
        {
            harness: run.harness,
            task: run.task,
            project: run.project,
            work: run.work,
            model: run.model,
            tier: run.tier ?? null,
            modelSource: run.modelSource ?? "harness default",
            cwd: run.cwd,
            maxMinutes: options.maxMinutes === undefined ? run.maxMinutes : options.maxMinutes,
            baseBrief: baseBriefOf(run),
            extra: session === null ? `${resumeSection(facts)}${note}` : "",
            ...(session === null ? {} : { prompt: continuePrompt(facts, options.note) }),
            ...(run.sessionDir === undefined ? {} : { sessionDir: run.sessionDir }),
            ...(session === null ? {} : { resumeSession: session }),
            resumeOf: run.id,
            resumeCount: number,
            resumeReason: options.reason,
        },
        { now: options.now },
    );
    updateRun(run.id, (record) => {
        record.resumedBy = next.id;
    });
    const how = session === null ? "as a fresh run" : "in the same session";
    const place = options.cap === null ? "by the lead" : `automatically, ${number} of at most ${options.cap}`;
    noteOnTask(run, `run ${run.id} ${options.stopped}; resumed ${how} as ${next.id} (${place})`);
    return next;
}

/**
 * Continue a run that stopped without a report (`stopped` says how) through continueRun, queued like any spawn when
 * every slot is busy. Past capacity.autoResume continuations in the chain, the chain stops: an inbox item and the
 * task's notes say why. Returns the stopped run as recorded afterwards.
 */
export function autoResume(machine: Machine, run: JawanRun, reason: string, stopped: string): JawanRun {
    const cap = autoResumeLimit(machine);
    const number = (run.resumeCount ?? 0) + 1;
    if (number > cap) {
        const where = [run.task, run.project === null ? null : `(${run.project})`].filter(Boolean).join(" ");
        const why =
            cap === 0
                ? `It ${stopped} without a report, and resuming is off (config/machine.json capacity.autoResume is 0).`
                : `It ${stopped} without a report after ${cap} automatic resumes (config/machine.json capacity.autoResume), so toli stopped the chain here.`;
        const body = [
            `- run: ${run.id}${where === "" ? "" : ` ${where}`}`,
            `- log: ${relative(paths.root(), run.logPath)}`,
            `- brief: ${relative(paths.root(), run.briefPath)}`,
            "",
            why,
            `Its edits are uncommitted in ${run.cwd}. Look at the log, then \`bin/toli resume ${run.id}\` (optionally with --note), relaunch with a narrower brief, or finish it by hand.`,
        ].join("\n");
        const title = `jawan ${run.id} not resumed: auto-resume limit reached${where === "" ? "" : ` for ${where}`}`;
        notify(machine, title, body, `${run.id}-resume-cap`);
        noteOnTask(run, `run ${run.id} ${stopped}; not resumed: ${cap} automatic resumes used (capacity.autoResume)`);
        return run;
    }
    continueRun(run, { reason, stopped, cap, now: false });
    return loadRun(run.id);
}
