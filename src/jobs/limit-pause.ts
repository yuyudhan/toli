// Provider rate/usage limits that name their reset, kept per harness and model (a model name such as
// `other/claude-sonnet-5-5` already names its provider or account). A scheduled job whose model is paused skips its
// due runs until the reset, with one inbox notice per job, and runs again by itself after it (src/jobs/tick.ts). A
// manual `toli job run` is never skipped, and a run on the model that gets through lifts the pause early.
import type { Machine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, readJson, withLock, writeJsonAtomic } from "../core/util.ts";
import { type Harness, harnessConfig } from "../harness/harness.ts";
import { hitLimit, limitReset } from "../harness/limit-output.ts";
import { modelCatalog } from "../harness/model-catalog.ts";
import { limitPlan, type ModelChoice, resolveModel } from "../harness/models.ts";
import { addInboxItem } from "../records/inbox.ts";
import type { JobConfig } from "./jobs.ts";

export type LimitPause = {
    harness: Harness;
    /** The model the limit hit; null is the harness's default model. */
    model: string | null;
    /** When the provider said the limit resets. */
    until: string;
    /** When the run hit the limit. */
    at: string;
    /** The limit error as the run printed it. */
    error: string;
    /** Jobs already told they are paused until `until`. */
    noticed: string[];
};

type LimitsFile = { limits: LimitPause[] };

/** A headless attempt's exit code and combined output. */
export type Outcome = { code: number; output: string };

/** Longest limit error kept on a pause and quoted in its notice. */
const LIMIT_ERROR_CHARS = 300;

function loadPauses(): LimitPause[] {
    return readJson<LimitsFile>(paths.jobLimits(), { limits: [] }).limits;
}

function updatePauses(fn: (pauses: LimitPause[]) => LimitPause[]): void {
    withLock(paths.lock("job-limits"), () => {
        writeJsonAtomic(paths.jobLimits(), { limits: fn(loadPauses()) });
    });
}

function isFor(pause: LimitPause, harness: Harness, model: string | null): boolean {
    return pause.harness === harness && pause.model === model;
}

/** The pause on `model` still in force at `at`, or null once its reset has passed. */
function activePause(harness: Harness, model: string | null, at: Date): LimitPause | null {
    return loadPauses().find((pause) => isFor(pause, harness, model) && new Date(pause.until) > at) ?? null;
}

/** The model a job runs on: its own tier, else its shape's work type, on this machine's omp tiers. */
export function jobModel(job: Pick<JobConfig, "tier" | "shape">): ModelChoice {
    return resolveModel("omp", { tier: job.tier ?? null, work: job.shape }, harnessConfig(), modelCatalog("omp"));
}

/**
 * After a headless attempt on `model`: null when it hit no rate/usage limit (a run that got through lifts any pause on
 * the model), else when it hit one and the reset the error names. A later reset pauses the model until then, replacing
 * an older pause on it; expired pauses are dropped.
 */
function noteLimit(model: string | null, outcome: Outcome): { at: Date; reset: Date | null } | null {
    if (!hitLimit(outcome.output, outcome.code)) {
        if (outcome.code === 0 && loadPauses().some((pause) => isFor(pause, "omp", model)))
            updatePauses((pauses) => pauses.filter((pause) => !isFor(pause, "omp", model)));
        return null;
    }
    const at = now();
    const reset = limitReset(outcome.output, at);
    if (reset !== null && reset > at) {
        const error = (outcome.output.trimEnd().split("\n").at(-1)?.trim() ?? "").slice(0, LIMIT_ERROR_CHARS);
        const pause: LimitPause = {
            harness: "omp",
            model,
            until: reset.toISOString(),
            at: at.toISOString(),
            error,
            noticed: [],
        };
        updatePauses((pauses) => [
            ...pauses.filter((entry) => !isFor(entry, "omp", model) && new Date(entry.until) > at),
            pause,
        ]);
    }
    return { at, reset };
}

/**
 * Run `attempt` on the job's model; one that stops on a rate/usage limit retries once on the model limitPlan names,
 * never waiting (the tick runs every minute). Returns the last attempt, its model, and the run's fallback note.
 */
export async function attemptWithinLimits(
    job: JobConfig,
    choice: ModelChoice,
    attempt: (model: string | null) => Promise<Outcome>,
): Promise<{ result: Outcome; model: string | null; fallback: string }> {
    const first = await attempt(choice.model);
    const limit = noteLimit(choice.model, first);
    if (limit === null) return { result: first, model: choice.model, fallback: "" };
    const run = { harness: "omp" as const, model: choice.model, tier: choice.tier, work: job.shape };
    const plan = limitPlan(run, limit.reset, limit.at, harnessConfig(), modelCatalog("omp"));
    if (plan.kind !== "switch") {
        const paused =
            limit.reset !== null && limit.reset > limit.at
                ? `; due runs paused until ${limit.reset.toISOString()}`
                : "";
        return {
            result: first,
            model: choice.model,
            fallback: `; hit a rate/usage limit, no retry (${plan.reason})${paused}`,
        };
    }
    const result = await attempt(plan.model);
    noteLimit(plan.model, result);
    return {
        result,
        model: plan.model,
        fallback: `; limit fallback ${choice.model ?? "default"} -> ${plan.model} (${plan.reason})`,
    };
}

/**
 * The pause that keeps `job` from its due runs at `at`, or null: its model hit a limit that resets later, and the
 * retry it would get (a same-tier alternative or an allowed lower tier) is no way round it.
 */
export function limitPauseFor(job: JobConfig, at: Date): LimitPause | null {
    const choice = jobModel(job);
    const pause = activePause("omp", choice.model, at);
    if (pause === null) return null;
    const plan = limitPlan(
        { harness: "omp", model: choice.model, tier: choice.tier, work: job.shape },
        new Date(pause.until),
        at,
        harnessConfig(),
        modelCatalog("omp"),
    );
    return plan.kind === "switch" && activePause("omp", plan.model, at) === null ? null : pause;
}

/**
 * Tell this machine's lead that the job's due runs wait for the limit's reset: once per job and limit. Returns the line
 * to log when it posted the notice, else null.
 */
export function noticePause(machine: Machine, name: string, pause: LimitPause): string | null {
    let first = false;
    updatePauses((pauses) =>
        pauses.map((entry) => {
            if (!isFor(entry, pause.harness, pause.model) || entry.noticed.includes(name)) return entry;
            first = true;
            return { ...entry, noticed: [...entry.noticed, name] };
        }),
    );
    if (!first) return null;
    const local = new Date(pause.until).toLocaleString("en-GB", { timeZoneName: "short" });
    const model = pause.model ?? "its default model";
    const body = [
        `${pause.harness} on ${model} hit a rate/usage limit at ${pause.at} that resets at ${local} (${pause.until}).`,
        `Due runs of job ${name} are skipped until then and resume by themselves after it; \`bin/toli job run ${name}\` still runs it now.`,
        "",
        "```text",
        pause.error,
        "```",
    ].join("\n");
    const path = addInboxItem(machine.name, `job ${name} paused until ${pause.until} (rate/usage limit)`, body);
    return `job ${name}: due runs paused until ${pause.until} (${pause.harness} ${model} limit); notice ${path}`;
}
