import { describe, expect, test } from "bun:test";
import type { HarnessConfig } from "../src/harness/harness.ts";
import { hitLimit, limitReset, parseUsage } from "../src/harness/limit-output.ts";
import {
    briefTier,
    briefWork,
    catalogHas,
    defaultModels,
    limitPlan,
    parseModelTables,
    resolveModel,
    WORK_TYPES,
} from "../src/harness/models.ts";

const NONE: HarnessConfig = {};
const HAIKU = "anthropic/claude-haiku-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";

describe("model tiers", () => {
    test("each kind of work has its default tier: testing and scouting standard, mechanical light, verify deep", () => {
        expect(defaultModels().workTiers).toEqual({
            scout: "standard",
            qa: "standard",
            desk: "standard",
            mechanical: "light",
            ship: "standard",
            verify: "deep",
            release: "deep",
        });
        expect(Object.keys(defaultModels().workTiers ?? {}).sort()).toEqual([...WORK_TYPES].sort());
        expect(resolveModel("omp", { work: "scout" }, NONE).model).toBe(SONNET);
        expect(resolveModel("omp", { work: "qa" }, NONE)).toEqual({ model: SONNET, tier: "standard", source: "work" });
        expect(resolveModel("omp", { work: "desk" }, NONE).model).toBe(SONNET);
        expect(resolveModel("omp", { work: "mechanical" }, NONE).model).toBe(HAIKU);
        // Code changes stay on the harness's own default model (an empty list in the defaults).
        expect(resolveModel("omp", { work: "ship" }, NONE)).toEqual({ model: null, tier: "standard", source: "work" });
        expect(resolveModel("claude", { work: "verify" }, NONE).model).toBe("claude-opus-5-5");
        expect(resolveModel("claude", { work: "release" }, NONE).model).toBe("claude-opus-5-5");
    });

    test("a work kind's own list beats its tier's, for any provider; an empty list is the harness default", () => {
        const config: HarnessConfig = {
            workModels: { omp: { qa: ["google/gemini-3-flash", "openai/gpt-5-mini"], ship: [] } },
        };
        expect(resolveModel("omp", { work: "qa" }, config)).toEqual({
            model: "google/gemini-3-flash",
            tier: "standard",
            source: "work",
        });
        expect(resolveModel("omp", { work: "ship" }, config).model).toBeNull();
        expect(resolveModel("omp", { work: "ship" }, { ...config, models: { omp: "fallback/x" } }).model).toBe(
            "fallback/x",
        );
        // A tier, from any source, still wins over the kind's own list.
        expect(resolveModel("omp", { work: "qa", briefTier: "deep" }, config).model).toBe(OPUS);
        expect(resolveModel("claude", { work: "qa" }, config).model).toBe("claude-sonnet-5-5");
    });

    test("from a list it runs the first model this machine's catalog has, else the first", () => {
        const config: HarnessConfig = { workModels: { omp: { qa: ["google/gemini-3-flash", "openai/gpt-5-mini"] } } };
        const catalog = new Set(["openai/gpt-5-mini", "anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5"]);
        expect(resolveModel("omp", { work: "qa" }, config, catalog).model).toBe("openai/gpt-5-mini");
        expect(resolveModel("omp", { work: "scout" }, NONE, catalog).model).toBe("anthropic/claude-sonnet-4-6");
        expect(resolveModel("omp", { work: "scout" }, NONE, new Set(["xai/grok-5"])).model).toBe(SONNET);
        expect(resolveModel("omp", { work: "scout" }, NONE, null).model).toBe(SONNET);
        // A limit on the standard model steps down to the light model the catalog has.
        const plan = limitPlan(
            { harness: "omp", model: SONNET, tier: "standard", work: "qa" },
            null,
            new Date(),
            NONE,
            catalog,
        );
        expect(plan).toMatchObject({ kind: "switch", model: "anthropic/claude-haiku-4-5", tier: "light" });
    });

    test("catalog ids match a full selector, a bare id under any provider, and ignore a :level suffix", () => {
        const catalog = new Set(["anthropic/claude-sonnet-5", "ollama/qwen3:8b"]);
        expect(catalogHas(catalog, "anthropic/claude-sonnet-5")).toBe(true);
        expect(catalogHas(catalog, "claude-sonnet-5")).toBe(true);
        expect(catalogHas(catalog, "anthropic/claude-sonnet-5:low")).toBe(true);
        expect(catalogHas(catalog, "ollama/qwen3:8b")).toBe(true);
        expect(catalogHas(catalog, "google/claude-sonnet-5")).toBe(false);
        expect(catalogHas(catalog, "claude-sonnet-5-5")).toBe(false);
    });

    test("model tables are validated: a list or one id per entry, known harnesses, kinds and tiers", () => {
        const where = "config/machine.json harness";
        expect(parseModelTables({ tiers: { omp: { light: "local/small" } } }, where).tiers).toEqual({
            omp: { light: ["local/small"] },
        });
        expect(() => parseModelTables({ workModels: { omp: { testing: ["a/b"] } } }, where)).toThrow(
            `${where}.workModels.omp key must be one of`,
        );
        expect(() => parseModelTables({ workModels: { nope: {} } }, where)).toThrow("workModels key");
        expect(() => parseModelTables({ tiers: { omp: { light: [3] } } }, where)).toThrow(
            "must be a model id or a list of model ids",
        );
        expect(() => parseModelTables({ workTiers: { qa: "cheap" } }, where)).toThrow("workTiers.qa must be one of");
    });

    test("precedence: --model > --tier > brief > task > work > harness.models > harness default", () => {
        const config: HarnessConfig = { models: { omp: "configured" } };
        const all = {
            model: "explicit",
            tier: "light",
            briefTier: "deep",
            taskTier: "standard",
            work: "verify",
        } as const;
        expect(resolveModel("omp", all, config)).toEqual({ model: "explicit", tier: null, source: "--model" });
        const { model: _m, ...noModel } = all;
        expect(resolveModel("omp", noModel, config)).toEqual({ model: HAIKU, tier: "light", source: "--tier" });
        const { tier: _t, ...noTier } = noModel;
        expect(resolveModel("omp", noTier, config)).toEqual({ model: OPUS, tier: "deep", source: "brief" });
        const { briefTier: _b, ...noBrief } = noTier;
        expect(resolveModel("omp", noBrief, config)).toEqual({ model: SONNET, tier: "standard", source: "task" });
        const { taskTier: _k, ...noTask } = noBrief;
        expect(resolveModel("omp", noTask, config)).toEqual({ model: OPUS, tier: "deep", source: "work" });
        expect(resolveModel("omp", {}, config)).toEqual({ model: "configured", tier: null, source: "models" });
        expect(resolveModel("omp", {}, NONE)).toEqual({ model: null, tier: null, source: "harness default" });
        // A --model that is a tier's model is recorded with that tier.
        expect(resolveModel("omp", { model: SONNET }, NONE).tier).toBe("standard");
    });

    test("config overrides the tier table and the work mapping; a harness without a tier model keeps its own", () => {
        const config: HarnessConfig = {
            tiers: { omp: { light: ["local-small"] }, codex: { deep: ["gpt-big"] } },
            workTiers: { scout: "light" },
        };
        expect(resolveModel("omp", { work: "scout" }, config)).toEqual({
            model: "local-small",
            tier: "light",
            source: "work",
        });
        expect(resolveModel("omp", { work: "verify" }, config).model).toBe(OPUS);
        expect(resolveModel("codex", { work: "verify" }, config).model).toBe("gpt-big");
        expect(resolveModel("codex", { work: "ship" }, config)).toEqual({
            model: null,
            tier: "standard",
            source: "work",
        });
        expect(resolveModel("codex", { work: "ship" }, { models: { codex: "gpt-x" } }).model).toBe("gpt-x");
    });

    test("a brief's Tier: line counts only in its header, and a misspelt tier is refused", () => {
        expect(briefTier("TOLI_BRIEF v1\n# Task\nTier: deep\n## Goal\n")).toBe("deep");
        expect(briefTier("TOLI_BRIEF v1\nTier: Light\n")).toBe("light");
        expect(briefTier("TOLI_BRIEF v1\n## Spec\nTier: deep\n")).toBeNull();
        expect(() => briefTier("TOLI_BRIEF v1\nTier: hard\n")).toThrow("the brief's Tier: line must be one of");
    });

    test("a brief's Work: line names its kind of work in its header; a misspelt kind is refused", () => {
        expect(briefWork("TOLI_BRIEF v1\n# QA S1\nWork: qa\n## Goal\n")).toBe("qa");
        expect(briefWork("TOLI_BRIEF v1\nWork: Desk\n")).toBe("desk");
        expect(briefWork("TOLI_BRIEF v1\n## Spec\nWork: qa\n")).toBeNull();
        expect(briefWork("TOLI_BRIEF v1\nWork: on the toli checkout\n")).toBeNull();
        expect(() => briefWork("TOLI_BRIEF v1\nWork: testing\n")).toThrow("the brief's Work: line must be one of");
    });
});

describe("limit fallback", () => {
    const at = new Date("2026-11-07T10:00:00.000Z");

    test("recognises rate and usage limits in a failed attempt's tail, not in a successful report", () => {
        expect(hitLimit('API error: 429 {"type":"error","error":{"type":"rate_limit_error"}}', 1)).toBe(true);
        expect(hitLimit("Claude AI usage limit reached|1793959200", 1)).toBe(true);
        expect(hitLimit("HTTP 429 Too Many Requests", 1)).toBe(true);
        expect(hitLimit("build failed at line 429", 1)).toBe(false);
        expect(hitLimit("Fixed the rate limit handling.\nAll tests pass.", 0)).toBe(false);
        expect(hitLimit("done\nError: rate_limit_error", 0)).toBe(true);
        // A finished report whose last line mentions a limit is not a limit, even with an error-like word.
        expect(
            hitLimit("Did the work.\nTests pass.\nCommitted abc.\nNote: usage limit reached earlier, retried.", 0),
        ).toBe(false);
    });

    test("reads the reset the error names", () => {
        expect(limitReset("usage limit reached|1793959200", at)?.toISOString()).toBe("2026-11-06T10:00:00.000Z");
        expect(limitReset("rate limit; resets at 2026-11-07T12:30:00Z", at)?.toISOString()).toBe(
            "2026-11-07T12:30:00.000Z",
        );
        expect(limitReset("rate limited, try again in 20 minutes", at)?.toISOString()).toBe("2026-11-07T10:20:00.000Z");
        expect(limitReset("429 retry-after: 90", at)?.toISOString()).toBe("2026-11-07T10:01:30.000Z");
        expect(limitReset('{"retry-after": "90"}', at)?.toISOString()).toBe("2026-11-07T10:01:30.000Z");
        // Anthropic's millisecond header, as a scheduled run captured it.
        expect(limitReset("429 rate_limit_error ... retry-after-ms=147223000", at)?.toISOString()).toBe(
            "2026-11-09T02:53:43.000Z",
        );
        expect(limitReset('"retry-after-ms": "1500"', at)?.toISOString()).toBe("2026-11-07T10:00:01.500Z");
        expect(limitReset("rate_limit_error", at)).toBeNull();
    });

    test("steps down one tier, never below the work's floor: verify and ship stop at standard, scout may go light", () => {
        const plan = (work: "verify" | "ship" | "scout" | "mechanical" | null, model: string) =>
            limitPlan({ harness: "omp", model, tier: null, work }, null, at, NONE);
        expect(plan("verify", OPUS)).toMatchObject({ kind: "switch", model: SONNET, tier: "standard" });
        expect(plan("verify", SONNET)).toMatchObject({ kind: "wait", model: SONNET });
        expect(plan("ship", SONNET)).toMatchObject({ kind: "wait", model: SONNET });
        expect(plan(null, SONNET)).toMatchObject({ kind: "wait", model: SONNET });
        expect(plan("scout", SONNET)).toMatchObject({ kind: "switch", model: HAIKU, tier: "light" });
        expect(plan("mechanical", HAIKU)).toMatchObject({ kind: "wait", model: HAIKU });
        for (const work of ["verify", "ship"] as const)
            for (const model of [OPUS, SONNET]) {
                const next = plan(work, model);
                expect(next.kind === "switch" ? next.model : null).not.toBe(HAIKU);
            }
    });

    test("a configured same-tier alternative comes first; a far reset means no retry", () => {
        const config: HarnessConfig = { fallback: { [SONNET]: "other/claude-sonnet-5-5" }, limitWaitMinutes: 60 };
        expect(
            limitPlan({ harness: "omp", model: SONNET, tier: "standard", work: "verify" }, null, at, config),
        ).toEqual({
            kind: "switch",
            model: "other/claude-sonnet-5-5",
            tier: "standard",
            reason: `harness.fallback names other/claude-sonnet-5-5 for ${SONNET}`,
        });
        const soon = new Date(at.getTime() + 30 * 60_000);
        const late = new Date(at.getTime() + 3 * 60 * 60_000);
        const run = { harness: "omp", model: SONNET, tier: "standard", work: "ship" } as const;
        expect(limitPlan(run, soon, at, { limitWaitMinutes: 60 })).toMatchObject({ kind: "wait", waitMinutes: 31 });
        expect(limitPlan(run, late, at, { limitWaitMinutes: 60 })).toMatchObject({ kind: "none" });
    });

    test("records tokens and cost only when the harness prints them", () => {
        expect(parseUsage("final answer\ntokens used\n12,345")).toEqual({ tokens: 12345 });
        expect(parseUsage('{"total_cost_usd": 0.42}')).toEqual({ costUsd: 0.42 });
        expect(parseUsage("final answer")).toBeNull();
    });
});
