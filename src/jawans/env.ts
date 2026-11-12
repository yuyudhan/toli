// The environment a jawan runs in. Kept apart from supervise.ts, which also delivers outcomes (inbox, outbox), so
// code that only builds the environment does not load the delivery machinery.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { paths } from "../core/paths.ts";
import { LEAD_TURN_ENV } from "../fleet/full.ts";

/** toli's rustc wrapper in the cargo shim folder (bin/shims/toli-rustc-wrapper). */
export const RUSTC_WRAPPER_NAME = "toli-rustc-wrapper";

/** Cargo's user config, where `[build] jobs` caps every cargo run on the machine, not only toli-spawned jawans. */
export function cargoConfigPath(env: Record<string, string | undefined> = process.env): string {
    return join(env.CARGO_HOME || join(homedir(), ".cargo"), "config.toml");
}

/** `path` without toli's cargo shim folder, so prepending it never repeats it. */
function withoutShims(path: string | undefined): string[] {
    const shims = paths.buildShimsDir();
    return path ? path.split(delimiter).filter((dir) => dir !== shims) : [];
}

/** The `[build] rustc-wrapper` of cargo's user config, resolved as cargo does; "" when unset or unreadable. */
function configRustcWrapper(env: Record<string, string | undefined>): string {
    const file = cargoConfigPath(env);
    if (!existsSync(file)) return "";
    let wrapper: unknown;
    try {
        const config = Bun.TOML.parse(readFileSync(file, "utf8")) as { build?: { "rustc-wrapper"?: unknown } };
        wrapper = config.build?.["rustc-wrapper"];
    } catch {
        return ""; // Cargo itself reports a broken config; the wrapper then runs rustc directly.
    }
    if (typeof wrapper !== "string" || wrapper === "") return "";
    // A bare name is looked up on PATH; a relative path is relative to the folder holding `.cargo`.
    return wrapper.includes("/") && !isAbsolute(wrapper) ? join(dirname(dirname(file)), wrapper) : wrapper;
}

/**
 * The rustc wrapper variables of a build environment over `base`: `RUSTC_WRAPPER` at toli's wrapper, and
 * `TOLI_RUSTC_WRAPPER_NEXT` at the wrapper it replaces (an inherited `RUSTC_WRAPPER` or `CARGO_BUILD_RUSTC_WRAPPER`,
 * else cargo's user config `[build] rustc-wrapper`, such as sccache), which it chains to. Cargo calls the wrapper for
 * every rustc it runs, whichever cargo binary PATH found, so a cargo that bypassed the shim (a shell profile or git
 * putting `~/.cargo/bin` first) still waits for and holds a heavy-build slot (src/fleet/build-slots.ts).
 */
export function rustcWrapperEnv(base: Record<string, string | undefined>): {
    RUSTC_WRAPPER: string;
    TOLI_RUSTC_WRAPPER_NEXT: string;
} {
    const ours = join(paths.buildShimsDir(), RUSTC_WRAPPER_NAME);
    const inherited = base.RUSTC_WRAPPER ?? "";
    const next =
        inherited === ours
            ? (base.TOLI_RUSTC_WRAPPER_NEXT ?? "")
            : inherited || base.CARGO_BUILD_RUSTC_WRAPPER || configRustcWrapper(base);
    return { RUSTC_WRAPPER: ours, TOLI_RUSTC_WRAPPER_NEXT: next };
}

/**
 * The build variables of a lead session (`bin/toli hook lead-build-env`) over its environment `base`: toli's cargo
 * shim first on PATH, `CARGO_BUILD_JOBS` at the machine's `capacity.cargoJobs` and toli's rustc wrapper
 * (`rustcWrapperEnv`). The native harness subagents the lead starts (omp `task`, Claude Code's Agent tool) inherit
 * them, so their heavy cargo commands queue for a heavy-build slot as a `bin/toli spawn` jawan's do.
 */
export function leadBuildEnv(
    base: Record<string, string | undefined>,
    cargoJobs: number,
): { PATH: string; CARGO_BUILD_JOBS: string; RUSTC_WRAPPER: string; TOLI_RUSTC_WRAPPER_NEXT: string } {
    return {
        PATH: [paths.buildShimsDir(), ...withoutShims(base.PATH)].join(delimiter),
        CARGO_BUILD_JOBS: String(cargoJobs),
        ...rustcWrapperEnv(base),
    };
}

/**
 * The jawan's environment: the supervisor's, marked as a jawan run. One code folder, one build folder: a jawan
 * builds into its checkout's own build folder, so an inherited `CARGO_TARGET_DIR` is dropped. toli's cargo shim
 * (bin/shims) goes first on PATH and toli's rustc wrapper is cargo's `RUSTC_WRAPPER`, so heavy cargo commands queue
 * for one of the machine's heavy-build slots (src/fleet/build-slots.ts) even when something puts another cargo ahead
 * of the shim on PATH, and every cargo run is capped with `CARGO_BUILD_JOBS` at the machine's `capacity.cargoJobs`
 * (one slot's share of the cores), the one setting for this machine; an inherited value never overrides it, and an
 * inherited `TOLI_BUILD_SLOT` is dropped: a jawan's builds never ride on a slot it did not take. A live-stack
 * project's jawan (`liveStack`, docs/projects.md "Live-stack mode") runs without the shim or the wrapper: the
 * machine's one build is the running stack's, its own scoped test builds share the checkout's build folder, where
 * cargo's lock already runs them one at a time, so they never also wait for a heavy-build slot.
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
    if (!liveStack) return { ...env, ...leadBuildEnv(base, cargoJobs) };
    env.PATH = withoutShims(base.PATH).join(delimiter);
    // An inherited toli wrapper (a lead's) gives way to the one it chained to.
    const wrapper = rustcWrapperEnv(base);
    if (base.RUSTC_WRAPPER === wrapper.RUSTC_WRAPPER) {
        if (wrapper.TOLI_RUSTC_WRAPPER_NEXT === "") delete env.RUSTC_WRAPPER;
        else env.RUSTC_WRAPPER = wrapper.TOLI_RUSTC_WRAPPER_NEXT;
    }
    delete env.TOLI_RUSTC_WRAPPER_NEXT;
    return env;
}
