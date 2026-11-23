// The build tools whose process keeps a cargo target in use for the disk keeper (src/fleet/target-use.ts targetUse):
// generic ones that start binaries from a workspace's target at any moment, even between holding cargo's locks, plus
// the machine's own (capacity.diskBuildTools in config/machine.json), such as a project's build queue. And the
// harness's own idle helpers, whose working directory says nothing about a build.
import { basename } from "node:path";
import { hasMachine, loadMachine } from "../core/config.ts";
import { diskBuildTools } from "./resources.ts";

const BUILD_TOOLS: Record<string, true> = {
    cargo: true,
    "cargo-clippy": true,
    "cargo-nextest": true,
    "clippy-driver": true,
    rustc: true,
    rustdoc: true,
    just: true,
};

/** The configured build tools; none on a machine not set up yet. */
export function configuredBuildTools(): string[] {
    return hasMachine() ? diskBuildTools(loadMachine()) : [];
}

/**
 * A harness's long-lived idle helper, as its program's file name and its first argument: it keeps the working
 * directory it started in (a project's clone) for its whole life and never builds there, so that directory does not
 * put the clone in use (T2547). Only the exact pair counts: a command that merely names the helper (`grep -r
 * __omp_worker_daemon src`, `cargo test __omp_worker_daemon`) is not one.
 */
const HARNESS_HELPERS: { program: string; argument: string }[] = [{ program: "omp", argument: "__omp_worker_daemon" }];

/** Whether a command line is a harness's idle helper (`/path/to/omp __omp_worker_daemon`). */
export function harnessHelper(args: string): boolean {
    const [program = "", argument] = args.trim().split(/\s+/);
    return HARNESS_HELPERS.some((helper) => basename(program) === helper.program && argument === helper.argument);
}

/**
 * The build tool a command line runs, or null: a generic one (`cargo`, `rustc`, `just`, ...) as its program, or one
 * of `extra` anywhere in it. An entry's words must follow each other, each compared by file name, and its first word
 * also matches as `<word>.<extension>` (a script run by an interpreter).
 */
export function buildTool(args: string, extra: string[]): string | null {
    const words = args
        .split(/\s+/)
        .filter((word) => word !== "")
        .map((word) => basename(word));
    const program = words[0] ?? "";
    if (BUILD_TOOLS[program] === true) return program;
    for (const tool of extra) {
        const [first = "", ...rest] = tool.trim().split(/\s+/);
        const found = words.some(
            (word, index) =>
                (word === first || word.startsWith(`${first}.`)) &&
                rest.every((next, offset) => words[index + 1 + offset] === next),
        );
        if (found) return tool.trim();
    }
    return null;
}
