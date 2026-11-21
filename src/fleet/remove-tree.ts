// Deleting build output the keeper may delete, including files a container wrote as root: those go through a
// throwaway container that binds the folder's parent (never sudo). Used by every keeper step that deletes a tree whole.
import { existsSync, rmSync } from "node:fs";
import { basename, dirname } from "node:path";
import { run } from "../core/util.ts";
import { describe } from "./disk-state.ts";
import { firstLine, THROWAWAY_IMAGE as REMOVER_IMAGE } from "./docker-volumes.ts";

/** Removing a 20 GB target can take minutes on a slow disk. */
const REMOVER_TIMEOUT_MS = 900_000;

/**
 * Delete `path` (retrying a few times, as a build may still write into it); files this account may not delete (a
 * container wrote them as root) go through `removeAsRoot`. The reason when it stays, else null.
 */
export function removeTree(path: string): string | null {
    try {
        rmSync(path, { recursive: true, force: true, maxRetries: 3 });
        return null;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM") return removeAsRoot(path);
        return `could not delete it: ${describe(error)}`;
    }
}

/**
 * Remove `path`, which holds files a container wrote as root, from a throwaway container that binds its parent folder
 * (`docker run --rm`, no network, as root inside it); never sudo. The reason when it could not.
 */
export function removeAsRoot(path: string): string | null {
    const why = "it holds root-owned files";
    const info = run(["docker", "info", "--format", "{{.ServerVersion}}"], { timeoutMs: 20_000 });
    if (info.code !== 0)
        return `${why}, and docker is ${info.code === 127 ? "not installed" : "not reachable"} to remove them (never sudo)`;
    const parent = dirname(path);
    // --mount takes comma-separated fields, so a path with a comma cannot be bound safely.
    if (parent.includes(",")) return `${why}, and its folder's path has a comma docker --mount cannot bind`;
    const removed = run(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--user",
            "0:0",
            "--mount",
            `type=bind,source=${parent},target=/toli-parent`,
            "--entrypoint",
            "rm",
            REMOVER_IMAGE,
            "-rf",
            `/toli-parent/${basename(path)}`,
        ],
        { timeoutMs: REMOVER_TIMEOUT_MS },
    );
    if (removed.code !== 0)
        return `${why}, and the throwaway container could not remove them: ${firstLine(removed.stderr || removed.stdout)}`;
    return existsSync(path) ? `${why}, still there after the throwaway container removed them` : null;
}
