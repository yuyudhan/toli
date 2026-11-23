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
 * Argument words that mark a harness's long-lived idle helper: it keeps the working directory it started in (a
 * project's clone) for its whole life and never builds there, so that directory does not put the clone in use (T2547).
 */
const HARNESS_HELPERS: Record<string, true> = { __omp_worker_daemon: true };

/** Whether a command line is a harness's idle helper (`omp __omp_worker_daemon`): one of its words, exactly. */
export function harnessHelper(args: string): boolean {
    return args.split(/\s+/).some((word) => HARNESS_HELPERS[word] === true);
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
