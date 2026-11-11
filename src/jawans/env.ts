// The environment a jawan runs in. Kept apart from supervise.ts, which also delivers outcomes (inbox, outbox), so
// code that only builds the environment does not load the delivery machinery.
import { delimiter } from "node:path";
import { paths } from "../core/paths.ts";
import { LEAD_TURN_ENV } from "../fleet/full.ts";

/** `path` without toli's cargo shim folder, so prepending it never repeats it. */
function withoutShims(path: string | undefined): string[] {
    const shims = paths.buildShimsDir();
    return path ? path.split(delimiter).filter((dir) => dir !== shims) : [];
}

/**
 * The build variables of a lead session (`bin/toli hook lead-build-env`): toli's cargo shim first on `path` and
 * `CARGO_BUILD_JOBS` at the machine's `capacity.cargoJobs`. The native harness subagents the lead starts (omp `task`,
 * Claude Code's Agent tool) inherit them, so their heavy cargo commands queue for a heavy-build slot as a `bin/toli
 * spawn` jawan's do.
 */
export function leadBuildEnv(path: string | undefined, cargoJobs: number): { PATH: string; CARGO_BUILD_JOBS: string } {
    return {
        PATH: [paths.buildShimsDir(), ...withoutShims(path)].join(delimiter),
        CARGO_BUILD_JOBS: String(cargoJobs),
    };
}

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
    // A jawan the headless lead started is not that lead turn: it must never inherit its refusals.
    delete env[LEAD_TURN_ENV];
    env.CARGO_BUILD_JOBS = String(cargoJobs);
    env.PATH = liveStack ? withoutShims(base.PATH).join(delimiter) : leadBuildEnv(base.PATH, cargoJobs).PATH;
    return env;
}
