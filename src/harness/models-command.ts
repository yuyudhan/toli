// `bin/toli models show|set|unset|check`: the model each kind of work and each tier runs on, per harness, from this
// machine's config/machine.json `harness` tables over toli's shipped defaults (src/harness/default-models.json).
// `set` takes any model id the harness accepts (any provider) or an ordered list of them; `--fleet` makes the same
// change on every fleet machine over ssh, so one sentence from the user switches the whole fleet. `check` asks the
// harness which models this machine can run (src/harness/model-catalog.ts) and says which entry each list runs.
import { Args } from "../core/args.ts";
import {
    inboundOff,
    inboundOffText,
    loadMachine,
    machineSettings,
    otherFleetMachines,
    remoteToliCommand,
    sshArgs,
} from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { out, printJson, run, shellQuote, ToliError, warn, writeJsonAtomic } from "../core/util.ts";
import { agentName } from "./agents.ts";
import { configuredHarnesses, type Harness, type HarnessConfig, harnessConfig, parseHarness } from "./harness.ts";
import { catalogCheckedAt, listsModels, modelCatalog, refreshCatalog } from "./model-catalog.ts";
import {
    catalogHas,
    isTier,
    type ModelCatalog,
    type ModelList,
    parseModelList,
    parseWork,
    pickModel,
    TIERS,
    type Tier,
    tierModels,
    WORK_TYPES,
    workModels,
    workTier,
} from "./models.ts";
import { syncAgents } from "./sync.ts";

const USAGE =
    "usage: toli models show [--harness <h>] [--json] | set <kind|tier> <model>[,<model>...]|none [--harness <h>] [--fleet] | unset <kind|tier> [--harness <h>] [--fleet] | check [--json] [--fleet]";

/** One kind of work or tier and the models it runs on. */
export type ModelRow = {
    key: string;
    /** The tier a kind of work belongs to (its limit fallback steps down from it), or the tier itself. */
    tier: Tier;
    models: ModelList;
    /** `machine`: config/machine.json names this list; `default`: toli's shipped default; `tier`: the kind's tier's. */
    source: "machine" | "default" | "tier";
    /** The model a run takes from the list here (null: the harness's own default). */
    runs: string | null;
    /** Whether this machine's catalog has any of the models; null when the harness cannot list its models. */
    available: boolean | null;
};

function row(key: string, tier: Tier, models: ModelList, source: ModelRow["source"], catalog: ModelCatalog): ModelRow {
    const available = catalog === null ? null : models.length === 0 || models.some((id) => catalogHas(catalog, id));
    return { key, tier, models, source, runs: pickModel(models, catalog), available };
}

/** Every kind of work, then every tier, with the models it runs on `harness` here. */
export function modelRows(harness: Harness, config: HarnessConfig, catalog: ModelCatalog): ModelRow[] {
    const work = WORK_TYPES.map((kind): ModelRow => {
        const tier = workTier(kind, config);
        const own = workModels(harness, kind, config);
        if (own === null) return row(kind, tier, tierModels(harness, tier, config), "tier", catalog);
        return row(
            kind,
            tier,
            own,
            config.workModels?.[harness]?.[kind] === undefined ? "default" : "machine",
            catalog,
        );
    });
    const tiers = TIERS.map((tier) =>
        row(
            tier,
            tier,
            tierModels(harness, tier, config),
            config.tiers?.[harness]?.[tier] === undefined ? "default" : "machine",
            catalog,
        ),
    );
    return [...work, ...tiers];
}

function rowText(harness: Harness, entry: ModelRow): string {
    const list = entry.models.length === 0 ? "(the harness's own default)" : entry.models.join(", ");
    const source = entry.source === "tier" ? `${entry.tier} tier` : entry.source;
    const missing = entry.available === false ? "; NONE available here" : "";
    const agent = harness === "omp" && !isTier(entry.key) ? `; subagent ${agentName(parseWork(entry.key))}` : "";
    return `  ${entry.key.padEnd(10)} ${list} -> runs ${entry.runs ?? "harness default"} (${source}${missing})${agent}`;
}

function show(argv: string[]): number {
    const args = new Args(argv, { booleans: ["json"], values: ["harness"] });
    args.maxPositional(0);
    const harness = parseHarness(args.str("harness") ?? "omp");
    const rows = modelRows(harness, harnessConfig(), modelCatalog(harness));
    if (args.bool("json")) {
        printJson({ harness, checkedAt: listsModels(harness) ? catalogCheckedAt() : null, rows });
        return 0;
    }
    const checked = catalogCheckedAt();
    out(
        `${harness} models${listsModels(harness) ? ` (catalog ${checked === null ? "never checked: bin/toli models check" : `checked ${checked}`})` : " (this harness cannot list its models: the first of each list runs)"}:`,
    );
    for (const entry of rows) out(rowText(harness, entry));
    return 0;
}

/** `tables` with `harness`'s `key` set to `models` (removed when undefined); empty tables are dropped. */
function withEntry<K extends string>(
    tables: Partial<Record<Harness, Partial<Record<K, ModelList>>>> | undefined,
    harness: Harness,
    key: K,
    models: ModelList | undefined,
): Partial<Record<Harness, Partial<Record<K, ModelList>>>> | undefined {
    const next = { ...tables };
    const table: Partial<Record<K, ModelList>> = { ...next[harness] };
    if (models === undefined) delete table[key];
    else table[key] = models;
    if (Object.keys(table).length === 0) delete next[harness];
    else next[harness] = table;
    return Object.keys(next).length === 0 ? undefined : next;
}

/** Write one list (or remove it with `models` undefined) into config/machine.json's `harness` tables. */
function writeEntry(harness: Harness, key: string, models: ModelList | undefined): void {
    loadMachine();
    const settings = machineSettings();
    const { tiers, workModels: own, ...rest } = settings.harness ?? {};
    const nextTiers = isTier(key) ? withEntry(tiers, harness, key, models) : tiers;
    const nextWork = isTier(key) ? own : withEntry(own, harness, parseWork(key), models);
    const config: HarnessConfig = {
        ...rest,
        ...(nextTiers === undefined ? {} : { tiers: nextTiers }),
        ...(nextWork === undefined ? {} : { workModels: nextWork }),
    };
    writeJsonAtomic(paths.machine(), { ...settings, harness: config });
    // Read back through the validator, so a bad write fails here rather than at the next spawn.
    harnessConfig();
}

/** A `set`/`unset` key: a kind of work or a tier. */
function parseKey(key: string): string {
    if (isTier(key)) return key;
    return parseWork(key, "the first argument (a kind of work or a tier)");
}

/** Run `bin/toli models <words>` on every other fleet machine; returns how many failed. */
function onFleet(words: string[]): number {
    const command = ["models", ...words].map(shellQuote).join(" ");
    let failures = 0;
    for (const machine of otherFleetMachines()) {
        if (inboundOff(machine)) {
            warn(
                `${machine.name}: skipped: ${inboundOffText(machine)}; tell its Sardar: bin/toli talk ${machine.name} "run bin/toli ${command}"`,
            );
            failures += 1;
            continue;
        }
        const result = run([...sshArgs(machine.ssh, 15), remoteToliCommand(machine.root, command)], {
            timeoutMs: 180_000,
        });
        const text = (result.stdout + result.stderr).trimEnd();
        if (result.code === 0) out(`== ${machine.name} ==\n${text}`);
        else {
            failures += 1;
            warn(`== ${machine.name}: failed (exit ${result.code}) ==\n${text}`);
        }
    }
    return failures;
}

function change(argv: string[], unset: boolean): number {
    const args = new Args(argv, { booleans: ["fleet"], values: ["harness"] });
    args.maxPositional(unset ? 1 : 2);
    const key = parseKey(args.pos(0, "kind of work or tier"));
    const harnessName = args.str("harness") ?? "omp";
    const harness = parseHarness(harnessName);
    const value = unset ? undefined : args.pos(1, "model list");
    const models =
        value === undefined ? undefined : value === "none" ? [] : parseModelList(value.split(","), "the model list");
    writeEntry(harness, key, models);
    syncAgents(paths.root(), false);
    if (listsModels(harness))
        for (const read of refreshCatalog())
            if (!read.ok) warn(`toli: ${read.harness} models not checked: ${read.error}`);
    const entry = modelRows(harness, harnessConfig(), modelCatalog(harness)).find((candidate) => candidate.key === key);
    out(`${loadMachine().name}: ${harness} ${unset ? "back to the default" : "set"}:`);
    if (entry !== undefined) out(rowText(harness, entry));
    if (!args.bool("fleet")) return 0;
    const words = unset
        ? ["unset", key, "--harness", harnessName]
        : ["set", key, value ?? "none", "--harness", harnessName];
    return onFleet(words) === 0 ? 0 : 1;
}

function check(argv: string[]): number {
    const args = new Args(argv, { booleans: ["json", "fleet"] });
    args.maxPositional(0);
    const reads = refreshCatalog();
    const config = harnessConfig();
    // The harnesses this machine routes jawans to (harness.jawan, harness.byWork; omp by default).
    const report = configuredHarnesses().map((harness) => ({
        harness,
        rows: modelRows(harness, config, modelCatalog(harness)),
    }));
    const missing = report.flatMap(({ harness, rows }) =>
        rows.filter((entry) => entry.available === false).map((entry) => `${harness} ${entry.key}`),
    );
    if (args.bool("json")) printJson({ machine: loadMachine().name, reads, report, missing });
    else {
        out(`${loadMachine().name}:`);
        for (const read of reads)
            out(
                read.ok
                    ? `${read.harness}: runs ${read.models.length} models here`
                    : `${read.harness}: not checked: ${read.error}`,
            );
        for (const { harness, rows } of report) {
            out(`${harness}${listsModels(harness) ? "" : " (cannot list its models: the first of each list runs)"}:`);
            for (const entry of rows) out(rowText(harness, entry));
        }
        if (missing.length > 0)
            out(`no model available here for: ${missing.join(", ")} (bin/toli models set <kind> <model>,...)`);
    }
    const fleetFailures = args.bool("fleet") ? onFleet(["check"]) : 0;
    return missing.length === 0 && fleetFailures === 0 ? 0 : 1;
}

export function modelsCommand(argv: string[]): number {
    const [sub, ...rest] = argv;
    switch (sub) {
        case "show":
            return show(rest);
        case "set":
            return change(rest, false);
        case "unset":
            return change(rest, true);
        case "check":
            return check(rest);
        default:
            throw new ToliError(USAGE);
    }
}
