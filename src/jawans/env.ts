// The environment a jawan runs in. Kept apart from supervise.ts, which also delivers outcomes (inbox, outbox), so
// code that only builds the environment does not load the delivery machinery.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { Machine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { writeTextAtomic } from "../core/util.ts";
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
 * The test harnesses' worker variables, capped at one slot's share like the compile jobs unless already set:
 * `cargo test`'s threads, nextest's, and Vitest's workers (`VITEST_MAX_WORKERS` from Vitest 4, `VITEST_MAX_THREADS` /
 * `VITEST_MAX_FORKS` before it). A project's own config file or command-line count still wins over these. Jest has
 * no environment variable for its workers, so its `--maxWorkers` stays the project's.
 */
const TEST_THREAD_VARS = [
    "RUST_TEST_THREADS",
    "NEXTEST_TEST_THREADS",
    "VITEST_MAX_WORKERS",
    "VITEST_MAX_THREADS",
    "VITEST_MAX_FORKS",
] as const;

/** One heavy-build slot's share of the cores, as build variables (`slotShareEnv`). */
export type SlotShare = { CARGO_BUILD_JOBS: string } & Partial<Record<(typeof TEST_THREAD_VARS)[number], string>>;

/**
 * One heavy-build slot's share of the cores over the environment `base`: `CARGO_BUILD_JOBS` at `cargoJobs`, or at
 * `base`'s own value where that is a lower positive integer (a script that runs one memory-hungry crate's build with
 * `CARGO_BUILD_JOBS=1` keeps it; a higher or unusable value never raises the share), and the test harnesses' worker
 * variables (`TEST_THREAD_VARS`) at the same number where `base` has not set them, so `cargo test` (its test binaries,
 * and rustdoc, which compiles one doctest per test thread with a rustc of its own), nextest and Vitest never run one
 * per core. Cargo and the harnesses read them from the environment however they were reached: the shim, a `just`
 * recipe or a pre-push hook calling them directly.
 */
export function slotShareEnv(base: Record<string, string | undefined>, cargoJobs: number): SlotShare {
    const outer = /^\d+$/.test(base.CARGO_BUILD_JOBS ?? "") ? Number(base.CARGO_BUILD_JOBS) : 0;
    const jobs = String(outer > 0 ? Math.min(outer, cargoJobs) : cargoJobs);
    const share: SlotShare = { CARGO_BUILD_JOBS: jobs };
    for (const name of TEST_THREAD_VARS) if ((base[name] ?? "") === "") share[name] = jobs;
    return share;
}

/** toli's Node preload in the shim folder (bin/shims/toli-node-preload.cjs): Node test runners take a slot. */
export const NODE_PRELOAD_NAME = "toli-node-preload.cjs";

/**
 * The stable stub NODE_OPTIONS `--require`s instead of the preload itself: `~/.toli/preload/node-<hash>.cjs`, one per
 * checkout (`TOLI_PRELOAD_HOME` replaces `~/.toli/preload`, for tests). The stub loads the checkout's current preload
 * when that file exists and does nothing otherwise, so a session still carrying the setting after the checkout moved to
 * a commit without the preload, or lost it, never fails to start a Node process (`Cannot find module`).
 */
export function nodePreloadStub(): string {
    const hash = createHash("sha256").update(paths.buildShimsDir()).digest("hex").slice(0, 12);
    const home = process.env.TOLI_PRELOAD_HOME || join(homedir(), ".toli", "preload");
    return join(home, `node-${hash}.cjs`);
}

/**
 * Write the stub (`nodePreloadStub`) unless it already holds the same text: true once it is there. Its text is the
 * same for every toli version, only the preload path it names. False when it cannot be written; the caller then leaves
 * the preload out of NODE_OPTIONS, never naming a file that is not there. Every Node process of a session runs the
 * stub, so its folder is private: folders made for it are 0700, and its folder (and `~/.toli` above the default one)
 * loses group and world write if it had them, so no one else on a shared-group (umask 002) machine can swap it.
 */
export function ensureNodePreloadStub(): boolean {
    const stub = nodePreloadStub();
    const target = join(paths.buildShimsDir(), NODE_PRELOAD_NAME);
    const text = [
        "// toli's Node preload stub (src/jawans/env.ts nodePreloadStub): loads toli's preload while it exists.",
        '"use strict";',
        `try { const t = ${JSON.stringify(target)}; if (require("node:fs").existsSync(t)) require(t); } catch {}`,
        "",
    ].join("\n");
    try {
        const dir = dirname(stub);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        for (const folder of process.env.TOLI_PRELOAD_HOME ? [dir] : [dir, dirname(dir)]) {
            const mode = statSync(folder).mode & 0o777;
            if ((mode & 0o022) !== 0) chmodSync(folder, mode & ~0o022);
        }
        if (existsSync(stub) && readFileSync(stub, "utf8") === text) return true;
        writeTextAtomic(stub, text);
        return true;
    } catch {
        return false;
    }
}

/** `--require <path>`, quoted where the path holds a space (Node reads quotes in NODE_OPTIONS). */
const requireOption = (path: string): string => `--require ${path.includes(" ") ? `"${path}"` : path}`;

/** `base`'s NODE_OPTIONS without toli's preload: the stub's `--require`, or the preload's own from an older toli. */
export function nodeOptionsWithoutPreload(base: Record<string, string | undefined>): string {
    let options = base.NODE_OPTIONS ?? "";
    for (const path of [nodePreloadStub(), join(paths.buildShimsDir(), NODE_PRELOAD_NAME)])
        options = options.split(requireOption(path)).join("");
    return options.replace(/\s+/g, " ").trim();
}

/**
 * `NODE_OPTIONS` over `base`'s with toli's Node preload stub (`nodePreloadStub`) `--require`d once, so a Node test
 * runner (Vitest, Jest) started outside a heavy-build slot takes one before it runs
 * (bin/shims/toli-node-preload.cjs). The caller writes the stub first (`ensureNodePreloadStub`).
 */
export function nodePreloadOptions(base: Record<string, string | undefined>): string {
    const options = nodeOptionsWithoutPreload(base);
    const require = requireOption(nodePreloadStub());
    return options === "" ? require : `${options} ${require}`;
}

/**
 * The build variables of a lead session (`bin/toli hook lead-build-env`) over its environment `base`: toli's shims
 * (cargo, bun) first on PATH, one heavy-build slot's share of the cores (`slotShareEnv`), toli's rustc wrapper
 * (`rustcWrapperEnv`) and toli's Node preload stub in NODE_OPTIONS (`nodePreloadOptions`; `preload` false, when the
 * stub could not be written, leaves it out), with `CARGO_CACHE_RUSTC_INFO=0`:
 * cargo otherwise caches its `rustc -vV` probe in the build folder, so a cargo with nothing left to compile (a `cargo
 * test` that only runs its tests and doctests) never calls the wrapper and never takes a slot; uncached, the probe is
 * every cargo's first act and takes the slot before anything runs. The native harness subagents the lead starts (omp
 * `task`, Claude Code's Agent tool) inherit them, so their heavy cargo commands, `bun test` and Node test runners queue
 * for a heavy-build slot as a `bin/toli spawn` jawan's do.
 */
export function leadBuildEnv(
    base: Record<string, string | undefined>,
    cargoJobs: number,
    preload = true,
): SlotShare & {
    PATH: string;
    CARGO_CACHE_RUSTC_INFO: string;
    RUSTC_WRAPPER: string;
    TOLI_RUSTC_WRAPPER_NEXT: string;
    NODE_OPTIONS: string;
} {
    return {
        PATH: [paths.buildShimsDir(), ...withoutShims(base.PATH)].join(delimiter),
        ...slotShareEnv(base, cargoJobs),
        CARGO_CACHE_RUSTC_INFO: "0",
        ...rustcWrapperEnv(base),
        NODE_OPTIONS: preload ? nodePreloadOptions(base) : nodeOptionsWithoutPreload(base),
    };
}

/**
 * The configured fake camera file of `machine` (config/machine.json `browser.fakeVideoFile`), absolute: a relative
 * path is under the toli root; "" when none is set.
 */
export function machineFakeVideoFile(machine: Partial<Machine>): string {
    const file = machine.browser?.fakeVideoFile ?? "";
    return file === "" ? "" : resolve(paths.root(), file);
}

/**
 * The browser variables of a toli harness session over its environment `base`: omp's browser (and any other
 * puppeteer) starts Chrome through toli's wrapper (bin/chrome-fake-media, `PUPPETEER_EXECUTABLE_PATH`), which adds
 * Chrome's fake camera, microphone and auto-accepted media prompt, so no session ever opens the machine's real camera
 * or microphone (fleet rule; docs/harnesses.md "Browsers use fake media"). A Chrome `base` already chose through
 * `PUPPETEER_EXECUTABLE_PATH` stays the one the wrapper runs (`TOLI_CHROME`), unless it is a toli wrapper itself (this
 * root's or another's), which would run itself. The fake camera plays `TOLI_FAKE_VIDEO_FILE` when `base` sets it,
 * else `fakeVideoFile` (`machineFakeVideoFile`) when given.
 */
export function fakeMediaEnv(base: Record<string, string | undefined>, fakeVideoFile: string): Record<string, string> {
    const wrapper = paths.chromeWrapper();
    const vars: Record<string, string> = { PUPPETEER_EXECUTABLE_PATH: wrapper };
    const chosen = base.PUPPETEER_EXECUTABLE_PATH ?? "";
    if (chosen !== "" && basename(chosen) !== basename(wrapper)) vars.TOLI_CHROME = chosen;
    if ((base.TOLI_FAKE_VIDEO_FILE ?? "") === "" && fakeVideoFile !== "") vars.TOLI_FAKE_VIDEO_FILE = fakeVideoFile;
    return vars;
}

/**
 * The jawan's environment: the supervisor's, marked as a jawan run. One code folder, one build folder: a jawan
 * builds into its checkout's own build folder, so an inherited `CARGO_TARGET_DIR` is dropped. toli's cargo shim
 * (bin/shims) goes first on PATH and toli's rustc wrapper is cargo's `RUSTC_WRAPPER` (`leadBuildEnv`), so heavy cargo
 * commands queue for one of the machine's heavy-build slots (src/fleet/build-slots.ts) even when something puts
 * another cargo ahead of the shim on PATH, and every cargo run, a pre-push hook's of a plain `git push` included, gets
 * one slot's share of the cores (`slotShareEnv`): `CARGO_BUILD_JOBS` at the machine's `capacity.cargoJobs`, the one
 * setting for this machine (an inherited value only ever lowers it), and the test-thread caps. An inherited
 * `TOLI_BUILD_SLOT` and `TOLI_BUILD_SLOT_HOLDER` (and a compile job, `TOLI_BUILD_JOB`) are dropped: a jawan's builds
 * never ride on a slot it did not take. A live-stack project's jawan (`liveStack`, docs/projects.md "Live-stack mode")
 * runs without the shim or the wrapper, at the same share: the machine's one build is the running stack's, its own
 * scoped test builds share the checkout's build folder, where cargo's lock already runs them one at a time, so they
 * never also wait for a heavy-build slot. `preload`: whether the Node preload stub is there to `--require`
 * (`ensureNodePreloadStub`). Every jawan's browser uses fake media (`fakeMediaEnv`, with the machine's
 * `fakeVideoFile`).
 */
export function jawanEnv(
    base: Record<string, string | undefined>,
    runId: string,
    cargoJobs: number,
    liveStack = false,
    preload = true,
    fakeVideoFile = "",
): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...base, TOLI_ROLE: "jawan", TOLI_RUN_ID: runId };
    // A Claude Code lead exports these; a nested `claude -p` must start as its own top-level session.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CARGO_TARGET_DIR;
    delete env.TOLI_BUILD_SLOT;
    delete env.TOLI_BUILD_SLOT_HOLDER;
    delete env.TOLI_BUILD_JOB;
    // The run's own task is set by its supervisor (src/jawans/supervise.ts); an inherited one is never this run's.
    delete env.TOLI_TASK;
    // A jawan the headless lead started is not that lead turn: it must never inherit its refusals.
    delete env[LEAD_TURN_ENV];
    Object.assign(env, slotShareEnv(base, cargoJobs), fakeMediaEnv(base, fakeVideoFile));
    if (!liveStack) return { ...env, ...leadBuildEnv(base, cargoJobs, preload) };
    env.PATH = withoutShims(base.PATH).join(delimiter);
    // An inherited toli wrapper (a lead's) gives way to the one it chained to.
    const wrapper = rustcWrapperEnv(base);
    if (base.RUSTC_WRAPPER === wrapper.RUSTC_WRAPPER) {
        if (wrapper.TOLI_RUSTC_WRAPPER_NEXT === "") delete env.RUSTC_WRAPPER;
        else env.RUSTC_WRAPPER = wrapper.TOLI_RUSTC_WRAPPER_NEXT;
    }
    delete env.TOLI_RUSTC_WRAPPER_NEXT;
    // An inherited toli Node preload (a lead's) goes too: its test runners never wait for a slot either.
    const options = nodeOptionsWithoutPreload(base);
    if (options === "") delete env.NODE_OPTIONS;
    else env.NODE_OPTIONS = options;
    return env;
}
