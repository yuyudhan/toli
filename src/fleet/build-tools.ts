// The build tools whose process keeps a cargo target in use for the disk keeper (src/fleet/target-use.ts targetUse):
// generic ones that start binaries from a workspace's target at any moment, even between holding cargo's locks, plus
// the machine's own (capacity.diskBuildTools in config/machine.json), such as a project's build queue.
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
