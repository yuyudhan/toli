// A gate's detached runner (`bin/toli gate runner <record>`, started by src/forge/gate.ts): it runs the recipe in one
// heavy-build slot and records the outcome. It outlives a caller that comes back (a hook timing out, ssh dropping,
// a retried push attaches again), but not all of them: once every process waiting on the gate has been gone for
// CALLER_GRACE_MINUTES (src/forge/gate-caller.ts), it leaves the slot's line, or stops its recipe and frees the slot.
import { appendFileSync } from "node:fs";
import { headSha, treeSha } from "../core/git.ts";
import { now, ToliError } from "../core/util.ts";
import { launchInScope, scopeFailedWarning } from "../fleet/build-slots.ts";
import { withCheckSlot } from "../fleet/check-slot.ts";
import type { Argv } from "../jawans/scope.ts";
import { changesText, checkoutChanges } from "./gate.ts";
import { watchCallers } from "./gate-caller.ts";
import {
    type GateRecord,
    inProgress,
    logDecision,
    outcomeText,
    readRecord,
    recipeEstimateMs,
    sealPass,
    short,
    updateRecord,
} from "./gate-record.ts";
import { type RecipeRun, superviseRecipe } from "./gate-supervise.ts";

/** Record the outcome of the recipe run `run` in `entry`; a pass counts only on the very tree the gate is for. */
function recordOutcome(entry: GateRecord, run: RecipeRun): void {
    const { end, stopped, survivors, elapsedMs, slotWaitMs } = run;
    entry.endedAt = now().toISOString();
    entry.exitCode = end.code;
    entry.recipeMs = elapsedMs;
    entry.slotWaitMs = slotWaitMs;
    if (stopped !== null) {
        entry.status = stopped.status;
        entry.reason =
            survivors.length === 0 ? stopped.reason : `${stopped.reason}; pid ${survivors.join(", ")} outlived SIGKILL`;
    } else if (end.error !== undefined) {
        entry.status = "failed";
        entry.reason = `could not run it: ${end.error}`;
    } else if (end.signal !== null) {
        entry.status = "killed";
        entry.reason = `it was killed by ${end.signal}`;
    } else if (end.code !== 0) {
        entry.status = "failed";
    } else {
        // A pass counts only if the checkout still was exactly the tree when the gate ended.
        const head = headSha(entry.dir);
        const changes = checkoutChanges(entry.dir);
        if (treeSha(entry.dir) !== entry.tree) {
            entry.status = "failed";
            entry.reason = `HEAD moved to ${short(head)} (another tree) while it ran, so the pass may not hold for ${short(entry.tree)}`;
        } else if (changes !== null) {
            entry.status = "failed";
            entry.reason = `the checkout changed while it ran (${changesText(changes)}), so the pass may not hold for ${short(entry.sha)}`;
        } else {
            // A pass the runner cannot seal (an unsafe or broken state/gate-key) is no pass anyone can reuse.
            entry.status = "passed";
            try {
                sealPass(entry);
            } catch (error) {
                entry.status = "failed";
                entry.reason = `the pass could not be sealed: ${error instanceof Error ? error.message : String(error)}`;
            }
        }
    }
}

/** Record that the gate in `file` was stopped before its recipe ran, because `reason`. */
function recordNeverRan(file: string, reason: string): void {
    const final = updateRecord(file, (entry) => {
        if (!inProgress(entry.status)) return;
        entry.status = "killed";
        entry.endedAt = now().toISOString();
        entry.reason = `${reason}; its recipe never ran`;
    });
    logDecision(final, final.status, outcomeText(final));
}

/**
 * The detached runner: in one heavy-build slot (cargo via `just` too) and that slot's memory-capped systemd scope where
 * the host has one, run the recipe; stop it only when it stalls, runs away or nothing waits on it any more. A recipe
 * whose scope systemd-run could not make never ran: it runs once more without the scope, after one warning line.
 */
export async function runGateProcess(file: string): Promise<void> {
    const record = readRecord(file);
    if (record === null) throw new ToliError(`gate record ${file} is gone`);
    // A closed terminal or dropped ssh session never stops a gate by itself; silence, SIGTERM/SIGINT or every caller
    // staying gone does.
    process.on("SIGHUP", () => {});
    const callersGone = new AbortController();
    const endWatch = watchCallers(file, (reason) => {
        logDecision(record, "callers-gone", `${record.recipe} at ${short(record.sha)}: ${reason}`);
        callersGone.abort(reason);
    });
    try {
        // The recipe may run the project's browser tests against its local stack: keep that stack running (T1492).
        await withCheckSlot(
            record.dir,
            record.project,
            record.stallMinutes,
            async ({ env: slotEnv, scope }) => {
                if (callersGone.signal.aborted) return recordNeverRan(file, String(callersGone.signal.reason));
                // The runaway limit (src/forge/gate-supervise.ts) follows the recipe's passes up to the moment it starts.
                const estimateMs = recipeEstimateMs(record.project, record.recipe);
                const supervised = updateRecord(file, (entry) => {
                    if (estimateMs === undefined) delete entry.estimateMs;
                    else entry.estimateMs = estimateMs;
                });
                const recipe: Argv = ["sh", "-c", record.recipe];
                const env = { ...process.env, ...slotEnv };
                const launch = launchInScope(scope, recipe);
                const stop = callersGone.signal;
                let run = await superviseRecipe(file, supervised, launch.argv, { ...env, ...launch.env }, stop);
                if (launch.scopeFailed() && run.stopped === null) {
                    appendFileSync(record.log, `${scopeFailedWarning(run.end.code ?? 1)}\n`);
                    run = await superviseRecipe(file, supervised, recipe, env, stop);
                }
                const final = updateRecord(file, (entry) => recordOutcome(entry, run));
                logDecision(final, final.status, outcomeText(final));
            },
            () => !callersGone.signal.aborted,
        );
    } catch (error) {
        // Waiting in line for the slot ends once nothing waits on the gate: that wait's refusal is this stop.
        if (!callersGone.signal.aborted) throw error;
        recordNeverRan(file, String(callersGone.signal.reason));
    } finally {
        endWatch();
    }
}
