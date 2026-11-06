// Model tiers: which model a jawan runs on, chosen per work type, and what a run that hits a rate or usage limit
// retries on. Pure functions over the `harness` block of config/machine.json (HarnessConfig); docs/harnesses.md
// "Model tiers" describes the table, the precedence and the fallback rule.
import { ToliError } from "../core/util.ts";
import type { Harness, HarnessConfig, WorkType } from "./harness.ts";

/** Cheapest to strongest. */
export const TIERS = ["light", "standard", "deep"] as const;
export type Tier = (typeof TIERS)[number];

const ANTHROPIC_TIERS: Record<Tier, string> = {
    light: "claude-haiku-5-5",
    standard: "claude-sonnet-5-5",
    deep: "claude-opus-5-5",
};

/**
 * Each harness's own model per tier, as its `--model` accepts it. A harness not named here (or a tier it lacks) keeps
 * its own default model unless `harness.tiers` in config/machine.json names one.
 */
export const DEFAULT_TIER_MODELS: Partial<Record<Harness, Record<Tier, string>>> = {
    omp: ANTHROPIC_TIERS,
    claude: ANTHROPIC_TIERS,
};

/** The tier each kind of work runs on unless `harness.workTiers` says otherwise. */
export const DEFAULT_WORK_TIERS: Record<WorkType, Tier> = {
    scout: "standard",
    mechanical: "light",
    ship: "standard",
    verify: "deep",
    release: "deep",
};

/**
 * The lowest tier a limit fallback may move a run of this work to: building, checking and releasing never drop to
 * light. A run of unknown work is held to standard too.
 */
const FLOOR: Record<WorkType, Tier> = {
    scout: "light",
    mechanical: "light",
    ship: "standard",
    verify: "standard",
    release: "standard",
};

/** Longest wait for a limit reset the error names before retrying the same model (`harness.limitWaitMinutes`). */
export const DEFAULT_LIMIT_WAIT_MINUTES = 300;
/** Wait when the error names no reset time. */
export const UNNAMED_RESET_WAIT_MINUTES = 15;

export function isTier(value: string): value is Tier {
    return (TIERS as readonly string[]).includes(value);
}

export function parseTier(value: string, label = "--tier"): Tier {
    if (!isTier(value)) throw new ToliError(`${label} must be one of ${TIERS.join(", ")} (got "${value}")`);
    return value;
}

/** A tier flag's value: absent stays absent; anything else must be a tier. */
export function parseOptionalTier(value: string | undefined, label = "--tier"): Tier | undefined {
    return value === undefined ? undefined : parseTier(value, label);
}

/** The model a harness runs for `tier`: the configured one, else toli's default, else none (the harness default). */
export function tierModel(harness: Harness, tier: Tier, config: HarnessConfig): string | null {
    return config.tiers?.[harness]?.[tier] ?? DEFAULT_TIER_MODELS[harness]?.[tier] ?? null;
}

/** The tier whose model `model` is on this harness, or null when the table does not name it. */
export function tierOf(harness: Harness, model: string, config: HarnessConfig): Tier | null {
    return TIERS.find((tier) => tierModel(harness, tier, config) === model) ?? null;
}

export function workTier(work: WorkType, config: HarnessConfig): Tier {
    return config.workTiers?.[work] ?? DEFAULT_WORK_TIERS[work];
}

/**
 * The `Tier: light|standard|deep` line of a brief's header (the lines before its first `## ` section), or null. A
 * misspelt tier is an error rather than silently ignored.
 */
export function briefTier(brief: string): Tier | null {
    for (const line of brief.split("\n")) {
        if (line.startsWith("## ")) return null;
        const match = /^Tier:\s*(\S+)\s*$/i.exec(line.trim());
        if (match?.[1] !== undefined) return parseTier(match[1].toLowerCase(), "the brief's Tier: line");
    }
    return null;
}

/** Where the chosen model came from, most specific first. */
export type ModelSource = "--model" | "--tier" | "brief" | "task" | "work" | "models" | "harness default";

export type ModelChoice = { model: string | null; tier: Tier | null; source: ModelSource };

export type ModelRequest = {
    model?: string | null | undefined;
    tier?: Tier | null | undefined;
    /** The brief's `Tier:` line. */
    briefTier?: Tier | null | undefined;
    /** The backlog task's tier (`task add --tier`). */
    taskTier?: Tier | null | undefined;
    work?: WorkType | null | undefined;
};

/**
 * The model for one run, most specific first: --model > --tier > the brief's Tier: line > the task's tier > the work
 * type's tier > `harness.models` > the harness's own default. A tier this harness has no model for falls through to
 * `harness.models`, then the harness default, and is still recorded.
 */
export function resolveModel(harness: Harness, request: ModelRequest, config: HarnessConfig): ModelChoice {
    const configured = config.models?.[harness] ?? null;
    if (request.model !== undefined && request.model !== null && request.model !== "")
        return { model: request.model, tier: tierOf(harness, request.model, config), source: "--model" };
    const picked: [Tier, ModelSource] | null =
        request.tier !== undefined && request.tier !== null
            ? [request.tier, "--tier"]
            : request.briefTier !== undefined && request.briefTier !== null
              ? [request.briefTier, "brief"]
              : request.taskTier !== undefined && request.taskTier !== null
                ? [request.taskTier, "task"]
                : request.work !== undefined && request.work !== null
                  ? [workTier(request.work, config), "work"]
                  : null;
    if (picked !== null) {
        const [tier, source] = picked;
        return { model: tierModel(harness, tier, config) ?? configured, tier, source };
    }
    if (configured !== null) return { model: configured, tier: tierOf(harness, configured, config), source: "models" };
    return { model: null, tier: null, source: "harness default" };
}

/** `claude-sonnet-5-5 (standard, work)`; `harness default` when no model is passed. */
export function choiceText(choice: Pick<ModelChoice, "model" | "tier"> & { source?: ModelSource }): string {
    const details = [choice.tier, choice.source].filter((part) => part !== null && part !== undefined);
    return `${choice.model ?? "harness default"}${details.length === 0 ? "" : ` (${details.join(", ")})`}`;
}

// A rate or usage limit as harnesses and provider APIs report it: Anthropic's rate_limit_error, Claude Code's
// "usage limit reached", HTTP 429 named next to a rate/limit/too-many word.
const LIMIT_PATTERNS: readonly RegExp[] = [
    /rate_limit_error/i,
    /usage limit/i,
    /rate limit(ed)?\b/i,
    /too many requests/i,
    /\b429\b.{0,80}\b(rate|limit|too many)/i,
    /\b(rate|limit|too many)\b.{0,80}\b429\b/i,
];

/** Lines of the attempt's output tail searched for a limit error; a report earlier in the log never counts. */
const LIMIT_TAIL_LINES = 15;

function tailLines(output: string, count: number): string[] {
    return output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .slice(-count);
}

/**
 * Whether a finished attempt stopped on a rate or usage limit: a failed exit whose output tail names one, or a clean
 * exit whose last line does (print modes that exit 0 after an API error).
 */
export function hitLimit(output: string, exitCode: number | null): boolean {
    const lines = exitCode === 0 ? tailLines(output, 1) : tailLines(output, LIMIT_TAIL_LINES);
    return lines.some((line) => LIMIT_PATTERNS.some((pattern) => pattern.test(line)));
}

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

/** The reset time the limit error names, or null: an ISO instant, Claude Code's `|<epoch>`, `in/after N units`, `retry-after: N`, or `resets 3pm`. */
export function limitReset(output: string, at: Date): Date | null {
    const text = tailLines(output, LIMIT_TAIL_LINES).join("\n");
    const iso = /reset\w*\D{0,20}(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d))/i.exec(text);
    if (iso?.[1] !== undefined) return new Date(iso[1]);
    const epoch = /limit reached\|(\d{10})\b/i.exec(text);
    if (epoch?.[1] !== undefined) return new Date(Number(epoch[1]) * 1000);
    const relative =
        /(?:try again|retry|resets?)\s+(?:in|after)\s+(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hours?)\b/i.exec(text);
    if (relative?.[1] !== undefined && relative[2] !== undefined)
        return new Date(at.getTime() + Number(relative[1]) * (UNIT_MS[relative[2][0]?.toLowerCase() ?? "s"] ?? 1000));
    const header = /retry-after["']?\s*[:=]\s*(\d+)/i.exec(text);
    if (header?.[1] !== undefined) return new Date(at.getTime() + Number(header[1]) * 1000);
    const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d\d))?\s*(am|pm)\b/i.exec(text);
    if (clock?.[1] !== undefined && clock[3] !== undefined) {
        const hour = (Number(clock[1]) % 12) + (clock[3].toLowerCase() === "pm" ? 12 : 0);
        const reset = new Date(at);
        reset.setHours(hour, Number(clock[2] ?? "0"), 0, 0);
        if (reset.getTime() <= at.getTime()) reset.setDate(reset.getDate() + 1);
        return reset;
    }
    return null;
}

export type LimitedRun = { harness: Harness; model: string | null; tier: Tier | null; work: WorkType | null };

/**
 * What a run that hit a limit retries on, once: `harness.fallback`'s alternative for its model (the same tier on
 * another account or provider), else the next lower tier with a model of its own on this harness, never below the
 * work's floor (ship, verify, release and unknown work stay at standard or above); else the same model after the
 * reset the error names (`reset` null: UNNAMED_RESET_WAIT_MINUTES), unless that is further away than
 * `harness.limitWaitMinutes`, when there is no retry.
 */
export type LimitPlan =
    | { kind: "switch"; model: string; tier: Tier | null; reason: string }
    | { kind: "wait"; model: string | null; tier: Tier | null; waitMinutes: number; reason: string }
    | { kind: "none"; reason: string };

export function limitPlan(run: LimitedRun, reset: Date | null, at: Date, config: HarnessConfig): LimitPlan {
    const alternative = run.model === null ? undefined : config.fallback?.[run.model];
    if (alternative !== undefined && alternative !== run.model)
        return {
            kind: "switch",
            model: alternative,
            tier: run.tier,
            reason: `harness.fallback names ${alternative} for ${run.model}`,
        };
    const current = run.tier ?? (run.model === null ? null : tierOf(run.harness, run.model, config));
    if (current !== null) {
        const floor = TIERS.indexOf(run.work === null ? "standard" : FLOOR[run.work]);
        for (let index = TIERS.indexOf(current) - 1; index >= floor; index--) {
            const tier = TIERS[index];
            if (tier === undefined) continue;
            const model = tierModel(run.harness, tier, config);
            if (model !== null && model !== run.model)
                return { kind: "switch", model, tier, reason: `${current} -> ${tier}` };
        }
    }
    const cap = config.limitWaitMinutes ?? DEFAULT_LIMIT_WAIT_MINUTES;
    if (reset === null)
        return {
            kind: "wait",
            model: run.model,
            tier: run.tier,
            waitMinutes: Math.min(UNNAMED_RESET_WAIT_MINUTES, cap),
            reason: "no lower tier allowed and no reset named",
        };
    const minutes = Math.max(1, Math.ceil((reset.getTime() - at.getTime()) / 60_000) + 1);
    if (minutes > cap)
        return {
            kind: "none",
            reason: `the limit resets at ${reset.toISOString()}, beyond harness.limitWaitMinutes (${cap})`,
        };
    return {
        kind: "wait",
        model: run.model,
        tier: run.tier,
        waitMinutes: minutes,
        reason: `no lower tier allowed; the limit resets at ${reset.toISOString()}`,
    };
}

/** What a limit fallback did, kept on the run record. */
export type FallbackRecord = {
    at: string;
    from: string | null;
    to: string | null;
    tier: Tier | null;
    waitedMinutes: number;
    reason: string;
};

/** Tokens and cost a harness printed for a run, when it prints them. */
export type Usage = { tokens?: number; costUsd?: number };

/**
 * Tokens and cost from the output tail, when the harness prints them: Codex's `tokens used` line, and `cost: $x` /
 * `total_cost_usd` lines. Null when none is there (omp, Claude Code and others in text mode print neither).
 */
export function parseUsage(output: string): Usage | null {
    const text = tailLines(output, 20).join("\n");
    const usage: Usage = {};
    const tokens = /tokens used[:\s]+([\d,]+)/i.exec(text);
    if (tokens?.[1] !== undefined) usage.tokens = Number(tokens[1].replaceAll(",", ""));
    const cost = /(?:total_cost_usd|total cost|^cost)["']?\s*[:=]?\s*\$?(\d+(?:\.\d+)?)/im.exec(text);
    if (cost?.[1] !== undefined) usage.costUsd = Number(cost[1]);
    return Object.keys(usage).length === 0 ? null : usage;
}

/** `12345 tokens, $0.42`. */
export function usageText(usage: Usage): string {
    return [
        usage.tokens === undefined ? null : `${usage.tokens} tokens`,
        usage.costUsd === undefined ? null : `$${usage.costUsd.toFixed(2)}`,
    ]
        .filter((part) => part !== null)
        .join(", ");
}
