// The command line of every headless omp run toli starts: spawned jawans (src/harness/harness.ts headlessCommand),
// `bin/toli exec` and scheduled jobs.
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Where an omp run keeps its session and, to resume it, the session file to continue. */
export type OmpSession = { dir: string; resume?: string | undefined };

/**
 * Flags every headless omp run gets. `--wait-async` keeps print mode alive while background work the run started (an
 * async `task` subagent, a background `bash` build or poll) is still going and wakes the session with each result;
 * without it omp ends at the first turn that yields and cancels that work. There is no `--max-time` unless the caller
 * asked for one: toli stops a run only when it stalls (src/jawans/progress.ts). `--config` loads toli's committed
 * overlay (`.omp/config.yml` in toli's root: no subagent request budget) when the run works outside toli's root, where
 * omp would not read it as project settings.
 */
export function headlessOmpFlags(
    cwd: string,
    root: string,
    maxTime: string | null,
    session: OmpSession | null,
): string[] {
    const overlay = join(root, ".omp", "config.yml");
    return [
        "omp",
        "-p",
        "--wait-async",
        "--cwd",
        cwd,
        "--no-title",
        "--approval-mode",
        "yolo",
        ...(maxTime === null ? [] : ["--max-time", maxTime]),
        ...(cwd !== root && existsSync(overlay) ? ["--config", overlay] : []),
        ...(session === null ? [] : ["--session-dir", session.dir]),
        ...(session?.resume === undefined ? [] : ["--resume", session.resume]),
    ];
}

/** The argv for one headless omp run of `prompt` in toli's `root` (scheduled jobs, `bin/toli exec`). */
export function headlessOmpArgs(
    prompt: string,
    root: string,
    maxTime: string | null,
    model: string | null = null,
    session: OmpSession | null = null,
): string[] {
    return [...headlessOmpFlags(root, root, maxTime, session), ...(model === null ? [] : ["--model", model]), prompt];
}
