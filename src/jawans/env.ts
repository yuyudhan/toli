// The environment a jawan runs in. Kept apart from supervise.ts, which also delivers outcomes (inbox, outbox), so
// code that only builds the environment does not load the delivery machinery.

/**
 * The jawan's environment: the supervisor's, marked as a jawan run. One code folder, one build folder: a jawan
 * builds into its checkout's own build folder, so an inherited `CARGO_TARGET_DIR` is dropped, and every cargo run is
 * capped with `CARGO_BUILD_JOBS` at the machine's `capacity.cargoJobs` (config/machine.json, default half the cores),
 * the one setting for this machine; an inherited value never overrides it.
 */
export function jawanEnv(
    base: Record<string, string | undefined>,
    runId: string,
    cargoJobs: number,
): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...base, TOLI_ROLE: "jawan", TOLI_RUN_ID: runId };
    // A Claude Code lead exports these; a nested `claude -p` must start as its own top-level session.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CARGO_TARGET_DIR;
    env.CARGO_BUILD_JOBS = String(cargoJobs);
    return env;
}
