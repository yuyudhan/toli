// Model tiers: which model a jawan runs on, chosen per work kind, and what a run that hits a rate or usage limit
// retries on. Pure functions over the `harness` block of config/machine.json (HarnessConfig) and toli's shipped
// defaults (default-models.json, no model names in code); docs/harnesses.md "Model tiers" describes the tables, the
// precedence and the fallback rule.
import { isJsonObject, ToliError } from "../core/util.ts";
import SHIPPED_MODELS from "./default-models.json";
import { type Harness, type HarnessConfig, parseHarness } from "./harness.ts";

/** Cheapest to strongest. */
export const TIERS = ["light", "standard", "deep"] as const;
export type Tier = (typeof TIERS)[number];

/**
 * Kinds of jawan work. Each runs on its own model list or its tier's, and may route to a different harness
 * (`harness.byWork` in config/machine.json). `qa` runs test cases against a product, `desk` triages and files what
 * testers find.
 */
export const WORK_TYPES = ["scout", "qa", "desk", "mechanical", "ship", "verify", "release"] as const;
export type WorkType = (typeof WORK_TYPES)[number];

export function parseWork(value: string, label = "--work"): WorkType {
    const work = WORK_TYPES.find((name) => name === value);
    if (work === undefined) throw new ToliError(`${label} must be one of ${WORK_TYPES.join(", ")} (got "${value}")`);
    return work;
}

/** Model ids as the harness's `--model` takes them (any provider), in order: the first this machine has wins. */
export type ModelList = readonly string[];

/** The model tables of `harness` in config/machine.json; toli's defaults (default-models.json) have the same shape. */
export type ModelTables = {
    /** Per harness, each tier's model list. */
    tiers?: Partial<Record<Harness, Partial<Record<Tier, ModelList>>>>;
    /** Per work kind, its tier. */
    workTiers?: Partial<Record<WorkType, Tier>>;
    /** Per harness, a work kind's own model list, over its tier's; an empty list is the harness's own default. */
    workModels?: Partial<Record<Harness, Partial<Record<WorkType, ModelList>>>>;
};

/**
 * The lowest tier a limit fallback may move a run of this work to: building, checking and releasing never drop to
 * light. A run of unknown work is held to standard too.
 */
const FLOOR: Record<WorkType, Tier> = {
    scout: "light",
    qa: "light",
    desk: "light",
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

/** `raw`'s own entries when it is a JSON object; anything else is refused, naming `where`. */
function objectEntries(raw: unknown, where: string): [string, unknown][] {
    if (!isJsonObject(raw)) throw new ToliError(`${where} must be an object`);
    return Object.entries(raw);
}

/** One model id or a list of them (an empty list: the harness's own default), as a list. */
export function parseModelList(value: unknown, label: string): ModelList {
    const entries: unknown[] = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    const ids = entries.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
    if ((typeof value !== "string" && !Array.isArray(value)) || ids.length !== entries.length)
        throw new ToliError(`${label} must be a model id or a list of model ids`);
    return ids.map((id) => id.trim());
}

function parseTable<K extends string, V>(
    raw: unknown,
    where: string,
    key: (name: string, label: string) => K,
    value: (entry: unknown, label: string) => V,
): Partial<Record<K, V>> {
    if (raw === undefined) return {};
    const table: Partial<Record<K, V>> = {};
    for (const [name, entry] of objectEntries(raw, where))
        table[key(name, `${where} key`)] = value(entry, `${where}.${name}`);
    return table;
}

/** The validated model tables in `raw` (config/machine.json's `harness`, or toli's defaults); `where` names it. */
export function parseModelTables(raw: unknown, where: string): ModelTables {
    const fields = new Map(objectEntries(raw, where));
    return {
        tiers: parseTable(fields.get("tiers"), `${where}.tiers`, parseHarness, (table, label) =>
            parseTable(table, label, parseTier, parseModelList),
        ),
        workTiers: parseTable(fields.get("workTiers"), `${where}.workTiers`, parseWork, (tier, label) =>
            parseTier(String(tier), label),
        ),
        workModels: parseTable(fields.get("workModels"), `${where}.workModels`, parseHarness, (table, label) =>
            parseTable(table, label, parseWork, parseModelList),
        ),
    };
}

let shipped: ModelTables | undefined;

/** toli's shipped model tables (default-models.json); config/machine.json's `harness` overrides them entry by entry. */
export function defaultModels(): ModelTables {
    shipped ??= parseModelTables(SHIPPED_MODELS, "src/harness/default-models.json");
    return shipped;
}

/** The ordered models `harness` has for `tier`: configured, else toli's defaults; empty when neither names any. */
export function tierModels(harness: Harness, tier: Tier, config: HarnessConfig): ModelList {
    return config.tiers?.[harness]?.[tier] ?? defaultModels().tiers?.[harness]?.[tier] ?? [];
}

/** A work kind's own model list on `harness` (configured, else toli's), or null: it runs on its tier's list. */
export function workModels(harness: Harness, work: WorkType, config: HarnessConfig): ModelList | null {
    return config.workModels?.[harness]?.[work] ?? defaultModels().workModels?.[harness]?.[work] ?? null;
}

export function workTier(work: WorkType, config: HarnessConfig): Tier {
    return config.workTiers?.[work] ?? defaultModels().workTiers?.[work] ?? "standard";
}

/** The model list a work kind runs on: its own, else its tier's. */
export function workModelList(harness: Harness, work: WorkType, config: HarnessConfig): ModelList {
    return workModels(harness, work, config) ?? tierModels(harness, workTier(work, config), config);
}

/**
 * The models a harness can run on this machine, by full `provider/id` selector (`bin/toli models check`, recorded in
 * state/model-catalog.json); null when unknown.
 */
export type ModelCatalog = ReadonlySet<string> | null;

/** Whether the catalog has `id`: an exact selector, or a bare id under any provider, with or without a `:level`. */
export function catalogHas(catalog: ReadonlySet<string>, id: string): boolean {
    const names = [id, id.replace(/:[a-z]+$/, "")];
    if (names.some((name) => catalog.has(name))) return true;
    if (id.includes("/")) return false;
    return [...catalog].some((selector) => names.some((name) => selector.endsWith(`/${name}`)));
}

/** The model to run from `list`: the first the catalog has, else (no catalog, or none listed) the first; null if empty. */
export function pickModel(list: ModelList, catalog: ModelCatalog): string | null {
    const found = catalog === null ? undefined : list.find((id) => catalogHas(catalog, id));
    return found ?? list[0] ?? null;
}

/** The model a harness runs for `tier`: the first of its list this machine has, else none (the harness default). */
export function tierModel(
    harness: Harness,
    tier: Tier,
    config: HarnessConfig,
    catalog: ModelCatalog = null,
): string | null {
    return pickModel(tierModels(harness, tier, config), catalog);
}

/** The tier whose list names `model` on this harness, or null when no tier does. */
export function tierOf(harness: Harness, model: string, config: HarnessConfig): Tier | null {
    return TIERS.find((tier) => tierModels(harness, tier, config).includes(model)) ?? null;
}

/** The value of a brief header's `<key>: <value>` line (the lines before its first `## ` section), or null. */
function briefHeader(brief: string, key: string): string | null {
    const pattern = new RegExp(`^${key}:\\s*(\\S+)\\s*$`, "i");
    for (const line of brief.split("\n")) {
        if (line.startsWith("## ")) return null;
        const value = pattern.exec(line.trim())?.[1];
        if (value !== undefined) return value.toLowerCase();
    }
    return null;
}

/** The brief header's `Tier: light|standard|deep` line, or null; a misspelt tier is refused, never ignored. */
export function briefTier(brief: string): Tier | null {
    const tier = briefHeader(brief, "Tier");
    return tier === null ? null : parseTier(tier, "the brief's Tier: line");
}

/** The brief header's `Work: <kind>` line (qa, scout, ...), or null; a misspelt kind is refused, never ignored. */
export function briefWork(brief: string): WorkType | null {
    const work = briefHeader(brief, "Work");
    return work === null ? null : parseWork(work, "the brief's Work: line");
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
 * kind's own model list, else its tier's > `harness.models` > the harness's own default. From a list it takes the
 * first model the catalog has (the first when there is no catalog). A tier or kind this harness has no model for
 * falls through to `harness.models`, then the harness default, and its tier is still recorded.
 */
export function resolveModel(
    harness: Harness,
    request: ModelRequest,
    config: HarnessConfig,
    catalog: ModelCatalog = null,
): ModelChoice {
    const configured = config.models?.[harness] ?? null;
    if (request.model !== undefined && request.model !== null && request.model !== "")
        return { model: request.model, tier: tierOf(harness, request.model, config), source: "--model" };
    const tiered = (tier: Tier, source: ModelSource): ModelChoice => ({
        model: tierModel(harness, tier, config, catalog) ?? configured,
        tier,
        source,
    });
    if (request.tier !== undefined && request.tier !== null) return tiered(request.tier, "--tier");
    if (request.briefTier !== undefined && request.briefTier !== null) return tiered(request.briefTier, "brief");
    if (request.taskTier !== undefined && request.taskTier !== null) return tiered(request.taskTier, "task");
    if (request.work !== undefined && request.work !== null) {
        const model = pickModel(workModelList(harness, request.work, config), catalog);
        return { model: model ?? configured, tier: workTier(request.work, config), source: "work" };
    }
    if (configured !== null) return { model: configured, tier: tierOf(harness, configured, config), source: "models" };
    return { model: null, tier: null, source: "harness default" };
}

/** `claude-sonnet-5-5 (standard, work)`; `harness default` when no model is passed. */
export function choiceText(choice: Pick<ModelChoice, "model" | "tier"> & { source?: ModelSource }): string {
    const details = [choice.tier, choice.source].filter((part) => part !== null && part !== undefined);
    return `${choice.model ?? "harness default"}${details.length === 0 ? "" : ` (${details.join(", ")})`}`;
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

export function limitPlan(
    run: LimitedRun,
    reset: Date | null,
    at: Date,
    config: HarnessConfig,
    catalog: ModelCatalog = null,
): LimitPlan {
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
            const model = tierModel(run.harness, tier, config, catalog);
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
