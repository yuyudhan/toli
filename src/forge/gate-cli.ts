// `bin/toli gate run|check|status`: the command line of src/forge/gate.ts's gates and their proofs.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Args } from "../core/args.ts";
import { headSha, treeSha } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { out, printJson, ToliError, warn } from "../core/util.ts";
import { toliSelfCheckout } from "../projects/projects.ts";
import { workDir } from "../projects/workspace.ts";
import { changesText, checkoutChanges, runGate, runGateProcess } from "./gate.ts";
import { type GateRecord, logDecision, outcomeText, provenPass, reconcile, recordFile, short } from "./gate-record.ts";

const TASK_FLAG = "task";

/** `--stall <minutes>`; undefined when absent (the gate then uses capacity.gateStallMinutes). */
function parseStall(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes <= 0) throw new ToliError("--stall must be a positive number of minutes");
    return minutes;
}

function requireRecipe(args: Args): string {
    const recipe = args.str("recipe");
    if (recipe === undefined || recipe.trim() === "") throw new ToliError('missing --recipe "<shell command>"');
    return recipe;
}

async function gateRun(argv: string[]): Promise<number> {
    const args = new Args(argv, { booleans: ["json"], values: [TASK_FLAG, "recipe", "stall"] });
    args.maxPositional(1);
    const project = args.pos(0, "project");
    const recipe = requireRecipe(args);
    const stallMinutes = parseStall(args.str("stall"));
    const dir = toliSelfCheckout(project) ?? workDir(project, args.str(TASK_FLAG)).dir;
    const json = args.bool("json");
    const record = await runGate({ project, dir, recipe, stallMinutes, json });
    if (json) printJson(record);
    if (record.status === "passed") return 0;
    warn(`toli: gate ${outcomeText(record)}`);
    return 1;
}

/**
 * Exit 0 only when this installation's gate runner recorded a pass of the recipe on the tree of the commit (`--sha`,
 * default HEAD). Without `--sha` the checkout must also be exactly HEAD: a hook that tests the working tree may not
 * skip its test for files the pass never covered. Each use of a proof is one `proof` line in logs/gates.log.
 */
function gateCheck(argv: string[]): number {
    const args = new Args(argv, { booleans: ["json"], values: [TASK_FLAG, "recipe", "sha"] });
    args.maxPositional(1);
    const project = args.pos(0, "project");
    const recipe = requireRecipe(args);
    const dir = toliSelfCheckout(project) ?? workDir(project, args.str(TASK_FLAG)).dir;
    const rev = args.str("sha");
    const sha = headSha(dir, rev ?? "HEAD");
    if (rev === undefined) {
        const changes = checkoutChanges(dir);
        if (changes !== null) {
            warn(
                `gate: ${dir} differs from its HEAD commit (${changesText(changes)}), so a pass on that commit's tree ` +
                    "does not cover it",
            );
            return 1;
        }
    }
    const tree = treeSha(dir, sha);
    const file = recordFile(project, tree, recipe);
    const record = reconcile(file);
    if (record?.status === "passed" && !provenPass(record, project, tree, recipe)) {
        logDecision({ project, sha }, "forged", `${file} says passed but carries no valid proof; refusing it`);
        warn(`gate: ${file} says passed but carries no valid proof from this installation's gate runner; ignoring it`);
        return 1;
    }
    if (record === null || record.status !== "passed") {
        const last = record === null ? "" : `; its last run is ${record.status}, log ${record.log}`;
        warn(`gate: ${recipe} has not passed on tree ${short(tree)} (commit ${short(sha)})${last}`);
        return 1;
    }
    logDecision(
        { project, sha },
        "proof",
        `${recipe} passed at ${short(record.sha)} on tree ${short(tree)} (${record.endedAt}, proof ${short(record.proof ?? "")}); commit ${short(sha)} needs no re-run`,
    );
    if (args.bool("json")) printJson(record);
    else
        out(
            `gate: ${recipe} passed on tree ${short(tree)} (${record.endedAt}), proof ${short(record.proof ?? "")}, log ${record.log}`,
        );
    return 0;
}

function gateStatus(argv: string[]): number {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(1);
    const project = args.pos(0, "project");
    const dir = paths.gatesDir(project);
    const records = existsSync(dir)
        ? readdirSync(dir)
              .filter((name) => name.endsWith(".json"))
              .map((name) => reconcile(join(dir, name)))
              .filter((record): record is GateRecord => record !== null)
              .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        : [];
    if (args.bool("json")) {
        printJson(records);
        return 0;
    }
    if (records.length === 0) {
        out(`no gates recorded for ${project}`);
        return 0;
    }
    for (const record of records)
        out(
            [record.status, short(record.sha), record.startedAt, record.endedAt ?? "-", record.recipe, record.log].join(
                "\t",
            ),
        );
    return 0;
}

/** `bin/toli gate run|check|status`; `gate runner <record>` is the detached runner `gate run` starts. */
export async function gateCommand(argv: string[]): Promise<number> {
    const [sub, ...rest] = argv;
    switch (sub) {
        case "run":
            return await gateRun(rest);
        case "check":
            return gateCheck(rest);
        case "status":
            return gateStatus(rest);
        case "runner": {
            const args = new Args(rest);
            args.maxPositional(1);
            await runGateProcess(args.pos(0, "record"));
            return 0;
        }
        default:
            throw new ToliError("usage: bin/toli gate run|check|status <project> ...");
    }
}
