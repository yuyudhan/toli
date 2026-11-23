// The models each harness can run on this machine, as `bin/toli models check` (also run by `models set` and
// `harness sync`) last read them, kept in state/model-catalog.json. spawn, exec and scheduled jobs run the first model
// of a list this catalog has (src/harness/models.ts pickModel), so a list's later entries are fallbacks for a model
// this machine's logins or providers do not offer.
import { paths } from "../core/paths.ts";
import { isJsonObject, now, readJson, run, writeJsonAtomic } from "../core/util.ts";
import type { Harness } from "./harness.ts";
import type { ModelCatalog } from "./models.ts";

/** The harnesses that can list the models they run here, and the command that prints them as JSON. */
const LISTINGS: readonly { harness: Harness; argv: readonly string[] }[] = [
    { harness: "omp", argv: ["omp", "models", "--json"] },
];

type CatalogFile = { checkedAt?: string; harnesses?: Partial<Record<Harness, unknown>> };

export type CatalogRead =
    | { harness: Harness; ok: true; models: string[] }
    | { harness: Harness; ok: false; error: string };

/** Whether `harness` can list the models it runs here (only those get a catalog). */
export function listsModels(harness: Harness): boolean {
    return LISTINGS.some((listing) => listing.harness === harness);
}

/** The models `harness` last reported it runs here, or null: never checked, or a harness that cannot list them. */
export function modelCatalog(harness: Harness): ModelCatalog {
    const models = readJson<CatalogFile>(paths.modelCatalog(), {}).harnesses?.[harness];
    if (!Array.isArray(models)) return null;
    return new Set(models.filter((model): model is string => typeof model === "string"));
}

/** When the catalog was last read, or null. */
export function catalogCheckedAt(): string | null {
    return readJson<CatalogFile>(paths.modelCatalog(), {}).checkedAt ?? null;
}

/** The `provider/id` selectors in `omp models --json` output (`{"models": [{"selector": ...}]}`), or null. */
export function catalogSelectors(output: string): string[] | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(output);
    } catch {
        return null;
    }
    const models = isJsonObject(parsed) ? parsed.models : undefined;
    if (!Array.isArray(models)) return null;
    return models.flatMap((model): string[] => {
        if (!isJsonObject(model)) return [];
        const { selector, provider, id } = model;
        if (typeof selector === "string") return [selector];
        return typeof provider === "string" && typeof id === "string" ? [`${provider}/${id}`] : [];
    });
}

/**
 * Ask each harness that can list its models which it runs here, and record them. A harness whose listing fails loses
 * its old entry, so its lists fall back to their first model rather than trust a stale catalog. Never throws.
 */
export function refreshCatalog(): CatalogRead[] {
    const harnesses = { ...readJson<CatalogFile>(paths.modelCatalog(), {}).harnesses };
    const reads = LISTINGS.map(({ harness, argv }): CatalogRead => {
        const result = run([...argv], { timeoutMs: 60_000 });
        const models = result.code === 0 ? catalogSelectors(result.stdout) : null;
        if (models !== null) {
            harnesses[harness] = models;
            return { harness, ok: true, models };
        }
        delete harnesses[harness];
        const detail = (result.stderr || result.stdout).trim().split("\n")[0] ?? "";
        return {
            harness,
            ok: false,
            error:
                result.code === 0
                    ? `\`${argv.join(" ")}\` printed no model list`
                    : `\`${argv.join(" ")}\` exited ${result.code}${detail === "" ? "" : `: ${detail}`}`,
        };
    });
    writeJsonAtomic(paths.modelCatalog(), { checkedAt: now().toISOString(), harnesses });
    return reads;
}
