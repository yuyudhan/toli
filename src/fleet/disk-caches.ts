// Machine-wide caches the disk keeper (src/fleet/disk.ts) shrinks after project build output: Docker's build cache and
// unused images (never volumes or containers), sccache's local cache when it has grown past its own cap, and, as its
// last resort, Playwright's downloaded browsers.
import { readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "../core/util.ts";
import { cacheFiles } from "./disk-scan.ts";

/** A browser build Playwright downloaded (`chromium-1140`, `chromium_headless_shell-1155`, `ffmpeg-1010`, ...). */
const PLAYWRIGHT_BUILD = /^[a-z][a-z_-]*-\d+$/;

/**
 * Playwright's downloaded browser builds, each one folder (`playwright install` downloads them again): from
 * PLAYWRIGHT_BROWSERS_PATH, else the platform's cache folder. Only folders named like a browser build, so a
 * PLAYWRIGHT_BROWSERS_PATH pointing somewhere shared loses nothing else. `0` keeps them in node_modules: none here.
 */
export function playwrightBrowsers(): string[] {
    const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (configured === "0") return [];
    const dir =
        configured !== undefined && configured !== ""
            ? configured
            : process.platform === "darwin"
              ? join(homedir(), "Library", "Caches", "ms-playwright")
              : join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ms-playwright");
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && PLAYWRIGHT_BUILD.test(entry.name))
            .map((entry) => join(dir, entry.name));
    } catch {
        return [];
    }
}

const DOCKER_PRUNE_TIMEOUT_MS = 30 * 60_000;

/** Docker build cache, then images no container uses; `say` gets one line per step. Never volumes or containers. */
export function pruneDocker(dryRun: boolean, say: (line: string) => void): void {
    const info = run(["docker", "info", "--format", "{{.ServerVersion}}"], { timeoutMs: 20_000 });
    if (info.code !== 0) {
        say(`docker: skipped (${info.code === 127 ? "not installed" : "daemon not reachable"})`);
        return;
    }
    for (const step of [
        ["builder", "prune", "-af"],
        ["image", "prune", "-af"],
    ]) {
        const command = `docker ${step.join(" ")}`;
        if (dryRun) {
            say(`would run ${command}`);
            continue;
        }
        const result = run(["docker", ...step], { timeoutMs: DOCKER_PRUNE_TIMEOUT_MS });
        const reclaimed = /Total(?: reclaimed space)?:\s*(.+)$/im.exec(result.stdout)?.[1]?.trim();
        say(
            result.code === 0
                ? `ran ${command}: reclaimed ${reclaimed ?? "nothing reported"}`
                : `${command} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().split("\n")[0]}`,
        );
    }
}

export type SccacheStats = { dir: string; bytes: number; maxBytes: number };

const UNIT_BYTES: Record<string, number> = {
    bytes: 1,
    B: 1,
    KiB: 1024,
    MiB: 1024 ** 2,
    GiB: 1024 ** 3,
    TiB: 1024 ** 4,
    KB: 1000,
    MB: 1000 ** 2,
    GB: 1000 ** 3,
    TB: 1000 ** 4,
};

function parseSize(text: string | undefined): number | null {
    const match = /^([\d.]+)\s*(\w+)$/.exec(text?.trim() ?? "");
    const unit = match?.[2] === undefined ? undefined : UNIT_BYTES[match[2]];
    if (match?.[1] === undefined || unit === undefined) return null;
    return Number(match[1]) * unit;
}

/** Local-disk cache directory, size and cap from `sccache --show-stats`; null for other backends or odd output. */
export function parseSccacheStats(text: string): SccacheStats | null {
    const dir = /^Cache location\s+Local disk:\s+"(.+)"\s*$/m.exec(text)?.[1];
    const bytes = parseSize(/^Cache size\s+(.+)$/m.exec(text)?.[1]);
    const maxBytes = parseSize(/^Max cache size\s+(.+)$/m.exec(text)?.[1]);
    if (dir === undefined || bytes === null || maxBytes === null) return null;
    return { dir, bytes, maxBytes };
}

/**
 * When sccache's local cache is over its own cap, delete its oldest entries until it is back under. sccache treats a
 * missing entry as a cache miss, so running builds are unaffected.
 */
export function trimSccache(dryRun: boolean, say: (line: string) => void): void {
    const result = run(["sccache", "--show-stats"], { timeoutMs: 30_000 });
    if (result.code !== 0) {
        if (result.code !== 127) say(`sccache: skipped (show-stats exit ${result.code})`);
        return;
    }
    const stats = parseSccacheStats(result.stdout);
    if (stats === null) {
        say("sccache: skipped (no local disk cache in its stats)");
        return;
    }
    const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
    if (stats.bytes <= stats.maxBytes) {
        say(`sccache: ${gib(stats.bytes)} is within its ${gib(stats.maxBytes)} cap`);
        return;
    }
    const files = cacheFiles(stats.dir).sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = files.reduce((sum, file) => sum + file.bytes, 0);
    let removed = 0;
    for (const file of files) {
        if (total <= stats.maxBytes) break;
        if (!dryRun) rmSync(file.path, { force: true });
        total -= file.bytes;
        removed += 1;
    }
    say(
        `${dryRun ? "would trim" : "trimmed"} sccache ${stats.dir}: ${removed} oldest entries, ${gib(stats.bytes)} -> ${gib(total)} (cap ${gib(stats.maxBytes)})`,
    );
}
