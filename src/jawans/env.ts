// The environment a jawan runs in. Kept apart from supervise.ts, which also delivers outcomes (inbox, outbox), so
// code that only builds the environment does not load the delivery machinery.
import { delimiter } from "node:path";
import { paths } from "../core/paths.ts";

/**
 * The jawan's environment: the supervisor's, marked as a jawan run. One code folder, one build folder: a jawan
 * builds into its checkout's own build folder, so an inherited `CARGO_TARGET_DIR` is dropped. toli's cargo shim
 * (bin/shims) goes first on PATH, so heavy cargo commands queue for one of the machine's heavy-build slots
 * (src/fleet/build-slots.ts), and every cargo run is capped with `CARGO_BUILD_JOBS` at the machine's
 * `capacity.cargoJobs` (one slot's share of the cores), the one setting for this machine; an inherited value never
 * overrides it, and an inherited `TOLI_BUILD_SLOT` is dropped: a jawan's builds never ride on a slot it did not take.
 * A live-stack project's jawan (`liveStack`, docs/projects.md "Live-stack mode") runs without the shim: the machine's
 * one build is the running stack's, its own scoped test builds share the checkout's build folder, where cargo's lock
 * already runs them one at a time, so they never also wait for a heavy-build slot.
 */
export function jawanEnv(
    base: Record<string, string | undefined>,
    runId: string,
    cargoJobs: number,
    liveStack = false,
): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...base, TOLI_ROLE: "jawan", TOLI_RUN_ID: runId };
    // A Claude Code lead exports these; a nested `claude -p` must start as its own top-level session.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CARGO_TARGET_DIR;
    delete env.TOLI_BUILD_SLOT;
    env.CARGO_BUILD_JOBS = String(cargoJobs);
    const shims = paths.buildShimsDir();
    const inherited = base.PATH ? base.PATH.split(delimiter).filter((dir) => dir !== shims) : [];
    env.PATH = (liveStack ? inherited : [shims, ...inherited]).join(delimiter);
    return env;
}
