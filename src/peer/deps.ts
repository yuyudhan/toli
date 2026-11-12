// toli's one runtime dependency, the audited @noble/curves (pinned in package.json, docs/peers.md "Dependency"), used
// only by pairing (src/peer/cpace.ts). It is loaded on demand, so every other command runs without node_modules.
// The installed runtime is a `git archive` snapshot without node_modules: it links the checkout's (runtime.ts), and the
// checkout's is found here too, so a snapshot made by an older toli still pairs.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type * as NobleModule from "@noble/curves/ed25519.js";
import { codeRoot, paths } from "../core/paths.ts";
import { readJson, run, ToliError } from "../core/util.ts";

const SPECIFIER = "@noble/curves/ed25519.js";

/** Where the dependency resolves from this code or from the checkout it serves, or null when it is not installed. */
export function nobleLocation(): string | null {
    for (const dir of [codeRoot(), paths.root()]) {
        try {
            return Bun.resolveSync(SPECIFIER, dir);
        } catch {
            // not installed for this directory; try the next
        }
    }
    return null;
}

export type Noble = typeof NobleModule;

/** The dependency; when it is missing (a checkout upgraded by an older toli), it is installed into the checkout first. */
export async function loadNoble(): Promise<Noble> {
    let location = nobleLocation();
    if (location === null) {
        ensureDependencies(paths.root());
        location = nobleLocation();
    }
    if (location === null)
        throw new ToliError(
            `@noble/curves is not installed: run \`bun install --production --frozen-lockfile\` in ${paths.root()}`,
        );
    // A runtime-resolved path, not a static import: the snapshot may lack node_modules and resolve the checkout's.
    const loaded: Noble = await import(location);
    return loaded;
}

/**
 * Install the pinned dependencies into `root` when it declares them and they are missing (`bun install --production
 * --frozen-lockfile`), as `upgrade` does after a checkout; returns what happened, or throws with bun's output.
 */
export function ensureDependencies(root: string = paths.root()): string {
    const manifest = readJson<{ dependencies?: Record<string, string> }>(join(root, "package.json"), {});
    if (Object.keys(manifest.dependencies ?? {}).length === 0) return "no dependencies to install";
    if (existsSync(join(root, "node_modules", "@noble", "curves", "package.json"))) return "dependencies installed";
    const installed = run([process.execPath, "install", "--production", "--frozen-lockfile"], {
        cwd: root,
        timeoutMs: 300_000,
    });
    if (installed.code !== 0)
        throw new ToliError(
            `bun install --production --frozen-lockfile failed in ${root} (exit ${installed.code}): ${(installed.stderr || installed.stdout).trim()}`,
        );
    return "dependencies installed now (bun install --production --frozen-lockfile)";
}
