// `bin/toli remote` refuses: no machine starts a jawan on another machine (docs/sardars.md). Work moves between
// machines only by delegation to that machine's lead. What `bin/toli exec` (src/fleet/exec.ts) still reads from the
// old dispatch lives here: its environment variables, its kill margin, and the prompt header of runs dispatched
// before the cutover.
import { ToliError } from "../core/util.ts";

/** The first line of a prompt dispatched by `remote` before the cutover; exec skips it for the run's title. */
export const REMOTE_HEADER = "[toli remote from ";

/** Why a jawan is never started for another machine, and what to do instead: `remote` and `exec --from` say it. */
export const DELEGATE_POINTER =
    'no machine starts a jawan on another machine; choose with `bin/toli pick --project <p>` (queue-ranked) and hand the task over with `bin/toli delegate <machine> "<title>" --brief <file> [--project <p>]` (see docs/sardars.md)';

/** Past an explicit `exec` limit (omp's own `--max-time`), the run is killed this much later. */
export const KILL_MARGIN_MINUTES = 5;
/**
 * `exec` takes its time limit, project, tier and work type from these variables rather than flags, so a caller on an
 * older toli still runs a prompt: an `exec` that does not know them keeps its own limit and model. The tier or work
 * type resolves to a model with this machine's own harness config.
 */
export const EXEC_MAX_MINUTES_ENV = "TOLI_EXEC_MAX_MINUTES";
export const EXEC_PROJECT_ENV = "TOLI_EXEC_PROJECT";
export const EXEC_TIER_ENV = "TOLI_EXEC_TIER";
export const EXEC_WORK_ENV = "TOLI_EXEC_WORK";
/** The task's tier, which ranks below the prompt's Tier: line (unlike `TOLI_EXEC_TIER`). */
export const EXEC_TASK_TIER_ENV = "TOLI_EXEC_TASK_TIER";
/** Milliseconds after which a run with an explicit omp limit of `maxMinutes` is killed; none without a limit. */
export function execKillMs(maxMinutes: number | null): number | undefined {
    return maxMinutes === null ? undefined : (maxMinutes + KILL_MARGIN_MINUTES) * 60 * 1000;
}

/** `toli remote ...`: always refused (exit 1) with the delegation pointer, whatever its arguments; nothing is sent. */
export function remoteCommand(_argv: string[]): never {
    throw new ToliError(`remote: ${DELEGATE_POINTER}`);
}
