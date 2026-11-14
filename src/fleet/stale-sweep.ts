// Sweep stale artifacts out of a cargo target nothing uses: the keeper's fallback when it fails (fallbackSweep), which
// needs nothing but deletions, so it works on a full disk. Cargo rebuilds any artifact it finds missing, so the sweep
// deletes every entry directly inside `<profile>/{deps,build,.fingerprint,incremental}` that nothing used for
// `capacity.diskSweepStaleMinutes` (default 180): no file in it read (atime) or written (mtime) since, none of cargo's
// lock files in it, and no process holding a file in it open, running or mapping it. Use is read from atime only
// where the mount keeps atime current enough for that age (see atimeVerdict); elsewhere from mtime alone. It never
// touches a target in use: it takes cargo's own locks first (whileIdle) and holds them while it deletes. A live build
// links up-to-date artifacts it has not rewritten for hours, so a partial delete under it breaks that build.
import { type Dirent, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, type Stats } from "node:fs";
import { join } from "node:path";
import { loadMachine } from "../core/config.ts";
import { out, platform, run, warn } from "../core/util.ts";
import { CARGO_LOCKS, LOCK_DEPTH, whileIdle } from "./cargo-lock.ts";
import {
    type BuildDir,
    buildDirs,
    type Checkout,
    checkoutUse,
    currentHolders,
    heldOpenBelow,
    projectCheckouts,
    within,
} from "./disk-scan.ts";
import { DiskLog, describe, diskPause, GIB, gb } from "./disk-state.ts";
import { DEFAULT_DISK_SWEEP_STALE_MINUTES, diskSweepStaleMinutes, procFile } from "./resources.ts";
import { LIVE_PROBES, type UseProbes } from "./target-use.ts";

/** The folders of a cargo profile dir whose entries cargo rebuilds when they are missing. */
const ARTIFACT_DIRS: Readonly<Record<string, true>> = {
    deps: true,
    build: true,
    ".fingerprint": true,
    incremental: true,
};
/** Linux relatime refreshes a file's atime at most once a day, so for younger ages atime cannot tell use. */
const RELATIME_MINUTES = 24 * 60;

/** Whether access times can tell use within the stale age on this mount, and why. */
export type AtimeVerdict = { atime: boolean; why: string };

/**
 * Whether atime can tell an artifact's last use within `staleMinutes` on a mount with `options`. `noatime`: never
 * updated. Linux `relatime` (the kernel default): updated at most once a day, so trusted only for a day or more. macOS
 * updates atime lazily unless the volume is mounted `strictatime`. Anything else (Linux `strictatime`): every read.
 */
export function atimeVerdict(os: string, options: readonly string[], staleMinutes: number): AtimeVerdict {
    if (options.includes("noatime")) return { atime: false, why: "by mtime: noatime mount" };
    if (os === "darwin") {
        return options.includes("strictatime")
            ? { atime: true, why: "by atime: strictatime mount" }
            : { atime: false, why: "by mtime: macOS updates atime lazily without strictatime" };
    }
    if (options.includes("relatime")) {
        return staleMinutes >= RELATIME_MINUTES
            ? { atime: true, why: "by atime: relatime mount, age of a day or more" }
            : { atime: false, why: "by mtime: relatime mount updates atime at most once a day" };
    }
    return { atime: true, why: "by atime: updated on every read" };
}

type Mount = { point: string; options: string[] };

/** Mounts from /proc/self/mounts (Linux; octal escapes such as `\040` decoded) or `mount` (macOS); null if unreadable. */
function mounts(): Mount[] | null {
    if (platform() === "darwin") {
        const listed = run(["mount"], { timeoutMs: 10_000 });
        if (listed.code !== 0) return null;
        const found: Mount[] = [];
        for (const line of listed.stdout.split("\n")) {
            const match = /^.+? on (.+) \(([^()]*)\)$/.exec(line);
            if (match?.[1] !== undefined && match[2] !== undefined)
                found.push({ point: match[1], options: match[2].split(/,\s*/) });
        }
        return found;
    }
    let text: string;
    try {
        text = readFileSync(procFile("self/mounts"), "utf8");
    } catch {
        return null;
    }
    const found: Mount[] = [];
    for (const line of text.split("\n")) {
        const [, point, , options] = line.split(" ");
        if (point === undefined || options === undefined) continue;
        const decoded = point.replace(/\\([0-7]{3})/g, (_, octal: string) =>
            String.fromCharCode(Number.parseInt(octal, 8)),
        );
        found.push({ point: decoded, options: options.split(",") });
    }
    return found;
}

/** How use is read for artifacts under `target`: from the options of the mount holding it. */
export function timeSource(target: string, staleMinutes: number): AtimeVerdict {
    let real: string;
    try {
        real = realpathSync(target);
    } catch {
        return { atime: false, why: "by mtime: target unreadable" };
    }
    let best: Mount | null = null;
    for (const mount of mounts() ?? []) {
        if (within(real, mount.point) && (best === null || mount.point.length > best.point.length)) best = mount;
    }
    if (best === null) return { atime: false, why: "by mtime: mount options unreadable" };
    return atimeVerdict(platform(), best.options, staleMinutes);
}

/**
 * `<profile>/{deps,build,.fingerprint,incremental}` folders in the target's top levels (where cargo's locks sit). A
 * profile dir is one holding `.fingerprint` or a cargo lock, so `target/doc/<crate named build>` never counts.
 */
export function artifactRoots(target: string): string[] {
    const found: string[] = [];
    const walk = (dir: string, depth: number): void => {
        let entries: Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        const profile = entries.some((entry) => entry.name === ".fingerprint" || CARGO_LOCKS[entry.name] === true);
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const path = join(dir, entry.name);
            if (profile && ARTIFACT_DIRS[entry.name] === true) found.push(path);
            else if (depth < LOCK_DEPTH) walk(path, depth + 1);
        }
    };
    walk(target, 0);
    return found;
}

/**
 * Bytes an entry would free (blocks of files with no other hard link; cargo links final binaries into the profile
 * dir) when nothing in it was used at or after `cutoffMs` and it holds no cargo lock; null otherwise. Folders count by
 * their mtime only: listing them (this walk included) moves their atime.
 */
function staleBytes(path: string, atime: boolean, cutoffMs: number): number | null {
    let stat: Stats;
    try {
        stat = lstatSync(path);
    } catch {
        return null;
    }
    const usedMs = atime && stat.isFile() ? Math.max(stat.atimeMs, stat.mtimeMs) : stat.mtimeMs;
    if (usedMs >= cutoffMs) return null;
    if (!stat.isDirectory()) return stat.isFile() && stat.nlink <= 1 ? stat.blocks * 512 : 0;
    let names: string[];
    try {
        names = readdirSync(path);
    } catch {
        return null;
    }
    let bytes = 0;
    for (const name of names) {
        if (CARGO_LOCKS[name] === true) return null;
        const child = staleBytes(join(path, name), atime, cutoffMs);
        if (child === null) return null;
        bytes += child;
    }
    return bytes;
}

export type SweepResult = {
    /** Entries deleted (or, in a dry run, that would be). */
    artifacts: number;
    /** Bytes they free. */
    bytes: number;
    /** How last use was read, e.g. `by mtime: noatime mount`. */
    by: string;
    /** Stale entries that could not be deleted, with the error. */
    failed: string[];
    /** Why the target was left whole (a build holds a lock, a process uses it), if it was. */
    kept?: string;
};

/**
 * Delete every stale entry directly inside the target's artifact folders (see the header) while holding cargo's
 * locks; a target in use is left whole (`kept` says why). Writes nothing, so it also works on a full disk. `dryRun`
 * only counts. `probes` say who uses the target: the live machine unless a test injects its own process list.
 */
export function sweepStaleArtifacts(
    target: string,
    staleMinutes: number,
    dryRun: boolean,
    probes: UseProbes = LIVE_PROBES,
): SweepResult {
    const source = timeSource(target, staleMinutes);
    const result: SweepResult = { artifacts: 0, bytes: 0, by: source.why, failed: [] };
    const outcome = whileIdle(
        target,
        () => deleteStale(target, source.atime, staleMinutes, dryRun, result, probes),
        probes,
    );
    if (!outcome.ran) result.kept = outcome.reason;
    return result;
}

/** The sweep itself, counted into `result`; only ever run under cargo's locks. */
function deleteStale(
    target: string,
    atime: boolean,
    staleMinutes: number,
    dryRun: boolean,
    result: SweepResult,
    probes: UseProbes,
): void {
    const cutoffMs = Date.now() - staleMinutes * 60_000;
    const stale: { path: string; bytes: number }[] = [];
    for (const root of artifactRoots(target)) {
        let names: string[];
        try {
            names = readdirSync(root);
        } catch {
            continue;
        }
        for (const name of names) {
            if (CARGO_LOCKS[name] === true) continue;
            const path = join(root, name);
            const bytes = staleBytes(path, atime, cutoffMs);
            if (bytes !== null) stale.push({ path, bytes });
        }
    }
    if (stale.length === 0) return;
    const held = heldOpenBelow(target, Number.POSITIVE_INFINITY, probes.openFiles).map((file) => file.path);
    for (const entry of stale) {
        if (held.some((path) => within(path, entry.path))) continue;
        if (!dryRun) {
            try {
                rmSync(entry.path, { recursive: true, force: true });
            } catch (error) {
                result.failed.push(`${entry.path} (${error instanceof Error ? error.message : String(error)})`);
                continue;
            }
        }
        result.artifacts += 1;
        result.bytes += entry.bytes;
    }
}

/** What a sweep of `target` freed, in GB and exact bytes, or why it freed nothing. */
export function sweepLine(target: string, staleMinutes: number, swept: SweepResult, dryRun: boolean): string {
    if (swept.kept !== undefined) return `kept ${target}: in use (${swept.kept})`;
    const age = `unused for ${staleMinutes} min, ${swept.by}`;
    const failed =
        swept.failed.length === 0 ? "" : `; ${swept.failed.length} could not be deleted, e.g. ${swept.failed[0]}`;
    if (swept.artifacts === 0) return `swept ${target}: no artifacts ${age}${failed}`;
    const freed = `${gb(swept.bytes / GIB)} (${swept.bytes} bytes)`;
    return dryRun
        ? `would sweep ${swept.artifacts} stale artifacts from ${target} (${age}), freeing ${freed}`
        : `swept ${swept.artifacts} stale artifacts from ${target} (${age}), freed ${freed}${failed}`;
}

/**
 * The keeper's fallback when it fails anyway (free disk or config unreadable, anything unforeseen): sweep the stale
 * artifacts out of every target nothing uses, the one step that needs nothing but deletions. A target in use (a jawan
 * or process working in its checkout, a build holding its lock, anything a wipe checks) is kept whole. It reads no
 * free disk and takes no keeper lock, honours state/disk-keep.pause, writes logs/disk.log only once it has deleted
 * something, and never throws. Returns its lines.
 */
export function fallbackSweep(failure: unknown, echo: boolean, dryRun: boolean): string[] {
    const lines: string[] = [];
    const log = new DiskLog(dryRun);
    if (dryRun) log.open();
    const say = (line: string): void => {
        lines.push(line);
        if (echo) out(line);
        log.add(line);
    };
    try {
        say(`disk keeper failed (${describe(failure)}): sweeping stale artifacts out of every idle target instead`);
        const pause = diskPause();
        if (pause !== null) {
            say(`paused by pid ${pause.pid} (state/disk-keep.pause): deleting nothing`);
            return lines;
        }
        let staleMinutes = DEFAULT_DISK_SWEEP_STALE_MINUTES;
        try {
            staleMinutes = diskSweepStaleMinutes(loadMachine());
        } catch (error) {
            say(`${describe(error)}: sweeping what was unused for the default ${staleMinutes} min`);
        }
        let checkouts: Checkout[] = [];
        let targets: BuildDir[] = [];
        try {
            checkouts = projectCheckouts();
            targets = checkouts.flatMap(buildDirs).filter((dir) => dir.kind === "target");
        } catch (error) {
            say(`cannot list the checkouts' targets: ${describe(error)}`);
        }
        for (const dir of targets) {
            const target = dir.path;
            try {
                const use = checkoutUse(dir.checkout, currentHolders(), checkouts);
                if (use !== null) {
                    say(`kept ${target}: in use (${use})`);
                    continue;
                }
                const swept = sweepStaleArtifacts(target, staleMinutes, dryRun);
                if (!dryRun && swept.artifacts > 0) log.open();
                say(sweepLine(target, staleMinutes, swept, dryRun));
            } catch (error) {
                say(`cannot sweep ${target}: ${describe(error)}`);
            }
        }
    } catch (error) {
        lines.push(`the fallback sweep stopped: ${describe(error)}`);
    } finally {
        const unwritten = log.flush();
        if (unwritten !== null) warn(`disk keeper: ${unwritten}`);
    }
    return lines;
}
