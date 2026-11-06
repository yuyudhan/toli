import { describe, expect, test } from "bun:test";
import type { HarnessConfig } from "../src/harness/harness.ts";
import {
    briefTier,
    DEFAULT_WORK_TIERS,
    hitLimit,
    limitPlan,
    limitReset,
    parseUsage,
    resolveModel,
} from "../src/harness/models.ts";

const NONE: HarnessConfig = {};
const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";

describe("model tiers", () => {
    test("each kind of work has its default tier: scout standard, mechanical light, ship standard, verify and release deep", () => {
        expect(DEFAULT_WORK_TIERS).toEqual({
            scout: "standard",
            mechanical: "light",
            ship: "standard",
            verify: "deep",
            release: "deep",
        });
        expect(resolveModel("omp", { work: "scout" }, NONE).model).toBe(SONNET);
        expect(resolveModel("omp", { work: "mechanical" }, NONE).model).toBe(HAIKU);
        expect(resolveModel("omp", { work: "ship" }, NONE).model).toBe(SONNET);
        expect(resolveModel("claude", { work: "verify" }, NONE).model).toBe(OPUS);
        expect(resolveModel("claude", { work: "release" }, NONE).model).toBe(OPUS);
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
            tiers: { omp: { light: "local-small" }, codex: { deep: "gpt-big" } },
            workTiers: { scout: "light" },
        };
        expect(resolveModel("omp", { work: "scout" }, config)).toEqual({
            model: "local-small",
            tier: "light",
            source: "work",
        });
        expect(resolveModel("omp", { work: "ship" }, config).model).toBe(SONNET);
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
    });

    test("reads the reset the error names", () => {
        expect(limitReset("usage limit reached|1793959200", at)?.toISOString()).toBe("2026-11-06T10:00:00.000Z");
        expect(limitReset("rate limit; resets at 2026-11-07T12:30:00Z", at)?.toISOString()).toBe(
            "2026-11-07T12:30:00.000Z",
        );
        expect(limitReset("rate limited, try again in 20 minutes", at)?.toISOString()).toBe("2026-11-07T10:20:00.000Z");
        expect(limitReset("429 retry-after: 90", at)?.toISOString()).toBe("2026-11-07T10:01:30.000Z");
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
