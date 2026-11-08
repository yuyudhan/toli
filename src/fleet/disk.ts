// The disk keeper: low free disk is never a reason to stop work. When free space on toli's volume is under
// capacity.diskKeepGB (config/machine.json, default 60), it deletes rebuildable output only, cheapest to rebuild
// first, until free space is the floor plus 20 GB:
//   1. whole `target/` folders of project checkouts nothing uses (no running jawan, no process working there);
//   2. `node_modules/` and `dist/` of those idle checkouts;
//   3. Docker build cache and unused images (`docker builder prune -af`, `docker image prune -af`; never volumes);
//   4. sccache's local cache entries past its own cap;
//   5. `target/` folders of busy checkouts, between build steps: under cargo's own locks, with no cargo running in
//      its workspace (cargo test runs its test binaries after dropping the locks) and no file in it open. A target
//      that stays in use (builds back to back) is swept instead: every artifact in it unused for
//      capacity.diskSweepStaleMinutes (default 180) goes, lock or no lock (src/fleet/stale-sweep.ts).
// Only git-ignored, wholly untracked folders are candidates, so sources, git data and uncommitted work are never
// touched. Every action goes to logs/disk.log. It runs inline before every jawan start and from the minute tick.
// Any long job that must keep its build output for now (a gate, a release build) writes its pid to
// state/disk-keep.pause; the keeper deletes nothing while that pid is alive, and ignores the file once it is dead. A
// keeper already waiting for a busy target to pause checks the marker again before every try.
// On a full disk it still works: it writes nothing before it has freed something (log lines wait in memory; a keeper
// lock it cannot write is done without), no failed write stops it, and when the keeper fails anyway the fallback
// sweeps stale artifacts out of every target, writing nothing first.
import { spawn as spawnChild } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, resolve } from "node:path";
import { Args } from "../core/args.ts";
import { loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { out, printJson, ToliError, warn } from "../core/util.ts";
import { dryRun as envDryRun } from "../jobs/os-scheduler.ts";
import { wipeTargetBetweenBuilds } from "./cargo-lock.ts";
import { pruneDocker, trimSccache } from "./disk-caches.ts";
import {
    type BuildDir,
    buildDirs,
    checkoutUse,
    currentHolders,
    openBelow,
    projectCheckouts,
    sizeGB,
} from "./disk-scan.ts";
import { claimKeeper, DiskLog, describe, diskPause, GIB, gb, KEEPER_LOCK, releaseKeeper } from "./disk-state.ts";
import { capacityFor, diskSweepStaleMinutes, measureDisk } from "./resources.ts";
import { fallbackSweep, sweepLine, sweepStaleArtifacts } from "./stale-sweep.ts";

/** Free GB above the floor the keeper stops at, so it does not run again at once. */
export const DISK_HEADROOM_GB = 20;
/** How long the background keeper waits for busy builds to pause before it gives up on a target (tier 5). */
const BACKGROUND_LOCK_WAIT_MS = 30 * 60_000;
/** This checkout's CLI (not paths.toliBin(): TOLI_ROOT may point the data elsewhere, as in tests). */
const TOLI_SCRIPT = resolve(import.meta.dir, "..", "..", "bin", "toli");

export type KeepOptions = {
    /** Overrides capacity.diskKeepGB. */
    floorGB?: number;
    /** Plan only: report what would go, counting each folder's size as freed. Also on with TOLI_DRY_RUN=1. */
    dryRun?: boolean;
    /** How long to wait for a busy target's builds to pause (tier 5); 0 tries once. */
    lockWaitMs?: number;
    /** Also print each line (the CLI); every line goes to logs/disk.log either way. */
    echo?: boolean;
};

export type KeepReport = {
    floorGB: number;
    goalGB: number;
    freeBeforeGB: number;
    freeAfterGB: number;
    dryRun: boolean;
    /** False when free space was already at or above the floor, another keeper is running, or a pause holds it. */
    ran: boolean;
    /** The live pid in state/disk-keep.pause that held the keeper off, if one did. */
    pausedBy?: number;
    /** Busy targets swept of stale artifacts (tier 5), with what each freed (or, in a dry run, would free). */
    swept: { target: string; artifacts: number; bytes: number }[];
    lines: string[];
};

export function diskFloorGB(): number {
    return capacityFor(loadMachine(), Math.max(1, cpus().length)).diskKeepGB;
}

function freeGB(): number {
    const free = measureDisk(paths.root());
    if (typeof free === "string") throw new ToliError(`cannot read free disk: ${free}`);
    return free;
}

/**
 * Free disk down to the floor's goal, in the order above. Never throws for a failed deletion or a failed write; it
 * logs and moves on. It throws only when it cannot start (free disk or config unreadable): see fallbackSweep.
 */
export function keepDisk(options: KeepOptions = {}): KeepReport {
    const dryRun = options.dryRun === true || envDryRun();
    const floorGB = options.floorGB ?? diskFloorGB();
    const staleMinutes = diskSweepStaleMinutes(loadMachine());
    const goalGB = floorGB + DISK_HEADROOM_GB;
    const freeBeforeGB = freeGB();
    const report: KeepReport = {
        floorGB,
        goalGB,
        freeBeforeGB,
        freeAfterGB: freeBeforeGB,
        dryRun,
        ran: false,
        swept: [],
        lines: [],
    };
    if (freeBeforeGB >= floorGB) return report;
    const log = new DiskLog(dryRun);
    if (dryRun) log.open();
    const say = (line: string): void => {
        report.lines.push(line);
        if (options.echo) out(line);
        log.add(line);
    };
    // Why the keeper does not run this time: reported every time, logged only when the reason (`key`) changes, so a
    // minute tick under a long pause or beside a long background keeper writes one line, not one a minute.
    const skip = (key: string, reason: string): KeepReport => {
        const line = `free ${gb(freeBeforeGB)} < floor ${gb(floorGB)}: ${reason}`;
        report.lines.push(line);
        if (options.echo) out(line);
        let last = "";
        try {
            last = readFileSync(paths.diskKeepSkip(), "utf8");
        } catch {
            // Nothing skipped since the keeper last ran.
        }
        if (last !== key) {
            log.add(line);
            log.open();
            try {
                mkdirSync(dirname(paths.diskKeepSkip()), { recursive: true });
                writeFileSync(paths.diskKeepSkip(), key);
            } catch {
                // A full disk: the reason is logged again next time, which is all this costs.
            }
        }
        return report;
    };
    const pause = diskPause();
    if (pause !== null) {
        report.pausedBy = pause.pid;
        const why = pause.reason === "" ? "" : ` (${pause.reason})`;
        return skip(`paused ${pause.pid}`, `paused by pid ${pause.pid}${why} (state/disk-keep.pause)`);
    }
    const claim = claimKeeper();
    if (claim.kind === "held")
        return skip(`keeper ${claim.pid}`, `another disk keeper (pid ${claim.pid}) is already running`);
    try {
        rmSync(paths.diskKeepSkip(), { force: true });
    } catch {
        // Not a file (or not ours to remove): the next skip just logs its reason once more.
    }
    report.ran = true;
    try {
        let simulated = 0;
        const free = (): number => (dryRun ? freeBeforeGB + simulated : freeGB());
        const enough = (): boolean => free() >= goalGB;
        say(`free ${gb(freeBeforeGB)} < floor ${gb(floorGB)}: freeing build output until ${gb(goalGB)}`);
        if (claim.kind === "unwritable")
            say(`cannot write ${paths.lock(KEEPER_LOCK)} (${claim.reason}): freeing without the keeper lock`);
        const checkouts = projectCheckouts();
        const dirs = checkouts.flatMap(buildDirs).sort((a, b) => a.mtimeMs - b.mtimeMs);
        /** Folders deleted (or, in a dry run, counted as deleted), and why each other one was kept: in use, or tried. */
        const done = new Set<string>();
        const kept = new Map<string, { reason: string; tried: boolean }>();
        const remove = (dir: BuildDir, deleteIt: () => string | null): void => {
            if (dryRun) {
                const size = sizeGB(dir.path);
                simulated += size;
                done.add(dir.path);
                say(`would delete ${dir.path} (${gb(size)})`);
                return;
            }
            const before = free();
            const refusal = deleteIt();
            if (refusal !== null) {
                kept.set(dir.path, { reason: refusal, tried: true });
                say(`kept ${dir.path}: ${refusal}`);
                return;
            }
            done.add(dir.path);
            log.open();
            say(`deleted ${dir.path}, freed ${gb(Math.max(0, free() - before))}`);
        };
        const idleTier = (kinds: BuildDir["kind"][], deleteIt: (dir: BuildDir) => string | null): void => {
            const holders = currentHolders();
            for (const dir of dirs) {
                if (enough()) return;
                if (!kinds.includes(dir.kind)) continue;
                // Checked again just before a real deletion: a run may have started in that checkout meanwhile.
                let reason = checkoutUse(dir.checkout, holders, checkouts);
                if (reason === null && !dryRun) reason = checkoutUse(dir.checkout, currentHolders(), checkouts);
                if (reason === null) remove(dir, () => deleteIt(dir));
                else {
                    kept.set(dir.path, { reason, tried: false });
                    say(`skipped ${dir.path}: ${reason}`);
                }
            }
        };
        // 1 and 2: idle checkouts. The target wipe still takes cargo's locks once, for builds run from elsewhere.
        idleTier(["target"], (dir) => wipeOutcome(dir.path, 0));
        idleTier(["node_modules", "dist"], (dir) => {
            const open = openBelow(dir.path);
            if (open.length > 0) return `open files, e.g. ${open.join(", ")}`;
            rmSync(dir.path, { recursive: true, force: true });
            return null;
        });
        // 3 and 4: machine-wide caches.
        if (!enough()) pruneDocker(dryRun, say);
        if (!enough()) trimSccache(dryRun, say);
        // 5: every target still here, busy ones included, between build steps: "a run is active" never means
        // "do nothing". Builds pause between cargo invocations; the wipe takes such a pause under cargo's locks. A
        // target with no pause right now (builds back to back) has its stale artifacts swept instead, lock or not.
        const busy = dirs.filter((dir) => dir.kind === "target" && !done.has(dir.path));
        for (const dir of busy) {
            if (enough()) break;
            const why = kept.get(dir.path);
            if (why?.tried !== true) {
                say(`${dir.path} is in use (${why?.reason ?? "no reason recorded"}): wiping it between build steps`);
                remove(dir, () => wipeOutcome(dir.path, 0));
            }
            if (done.has(dir.path) || enough()) continue;
            const swept = sweepStaleArtifacts(dir.path, staleMinutes, dryRun);
            report.swept.push({ target: dir.path, artifacts: swept.artifacts, bytes: swept.bytes });
            if (dryRun) simulated += swept.bytes / GIB;
            else if (swept.artifacts > 0) log.open();
            say(sweepLine(dir.path, staleMinutes, swept, dryRun));
        }
        // The background keeper then waits for a pause in what is still busy, for up to waitMs per target.
        const waitMs = options.lockWaitMs ?? 0;
        if (waitMs > 0) {
            for (const dir of busy) {
                if (enough()) break;
                if (done.has(dir.path)) continue;
                const why = kept.get(dir.path)?.reason ?? "no reason recorded";
                const wait = `waiting up to ${Math.round(waitMs / 60_000)} min for a pause`;
                say(`${dir.path} is in use (${why}): wiping it between build steps, ${wait}`);
                remove(dir, () => wipeOutcome(dir.path, waitMs));
            }
        }
        report.freeAfterGB = free();
        say(
            report.freeAfterGB >= floorGB
                ? `done: free ${gb(freeBeforeGB)} -> ${gb(report.freeAfterGB)}`
                : `done, still under the floor: free ${gb(freeBeforeGB)} -> ${gb(report.freeAfterGB)}; nothing more is rebuildable and free right now`,
        );
    } finally {
        if (claim.kind === "claimed") releaseKeeper();
        const unwritten = log.flush();
        if (unwritten !== null) warn(`disk keeper: ${unwritten}`);
    }
    return report;
}

function wipeOutcome(target: string, waitMs: number): string | null {
    const outcome = wipeTargetBetweenBuilds(target, waitMs, () => {
        const pause = diskPause();
        return pause === null ? null : `paused by pid ${pause.pid} (state/disk-keep.pause)`;
    });
    return outcome.wiped ? null : outcome.reason;
}

/**
 * Start `bin/toli disk keep --wait` detached (its lines reach logs/disk.log), to wipe busy targets as builds pause.
 * Bun's transpiler cache is off for it, as `bin/toli disk` does: the disk may still be full.
 */
export function startBackgroundKeeper(): void {
    let log: number | "ignore" = "ignore";
    try {
        mkdirSync(paths.logsDir(), { recursive: true });
        log = openSync(paths.diskLog(), "a");
    } catch {
        // A full disk: the keeper's own lines still reach logs/disk.log once it has freed something.
    }
    try {
        const child = spawnChild(
            process.execPath,
            [TOLI_SCRIPT, "disk", "keep", "--wait", String(BACKGROUND_LOCK_WAIT_MS / 60_000)],
            {
                cwd: paths.root(),
                detached: true,
                stdio: ["ignore", "ignore", log],
                env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
            },
        );
        child.unref();
    } finally {
        if (log !== "ignore") closeSync(log);
    }
}

/**
 * Before work starts (each jawan launch, each tick): free disk inline without waiting on busy builds, then leave a
 * background keeper waiting for them if that was not enough. Never throws: disk never stops work.
 */
export function keepDiskBeforeWork(): string | null {
    let report: KeepReport;
    try {
        report = keepDisk({ lockWaitMs: 0 });
    } catch (error) {
        fallbackSweep(error, false, envDryRun());
        return `disk keeper failed: ${describe(error)}; swept stale artifacts instead (logs/disk.log)`;
    }
    if (!report.ran) return null;
    try {
        if (!report.dryRun && report.freeAfterGB < report.floorGB) startBackgroundKeeper();
    } catch (error) {
        return `disk keeper: free ${gb(report.freeBeforeGB)} -> ${gb(report.freeAfterGB)}; background keeper not started: ${describe(error)}`;
    }
    return `disk keeper: free ${gb(report.freeBeforeGB)} -> ${gb(report.freeAfterGB)} (floor ${gb(report.floorGB)})`;
}

/** `toli disk keep [--dry-run] [--floor <GB>] [--wait <minutes>] [--json]`. */
export function diskCommand(argv: string[]): void {
    const [sub, ...rest] = argv;
    if (sub !== "keep")
        throw new ToliError("usage: toli disk keep [--dry-run] [--floor <GB>] [--wait <minutes>] [--json]");
    const args = new Args(rest, { booleans: ["dry-run", "json"], values: ["floor", "wait"] });
    args.maxPositional(0);
    const number = (name: string): number | undefined => {
        const raw = args.str(name);
        if (raw === undefined) return undefined;
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) throw new ToliError(`--${name} must be a non-negative number`);
        return value;
    };
    const floorGB = number("floor");
    const waitMinutes = number("wait");
    const json = args.bool("json");
    const dryRun = args.bool("dry-run");
    let report: KeepReport;
    try {
        report = keepDisk({
            dryRun,
            ...(floorGB === undefined ? {} : { floorGB }),
            lockWaitMs: (waitMinutes ?? 0) * 60_000,
            echo: !json,
        });
    } catch (error) {
        const lines = fallbackSweep(error, !json, dryRun || envDryRun());
        if (json) printJson({ error: describe(error), fallback: lines });
        throw new ToliError(`disk keeper failed: ${describe(error)}; swept stale artifacts instead`);
    }
    if (json) printJson(report);
    else if (report.lines.length === 0)
        out(`free ${gb(report.freeBeforeGB)}, floor ${gb(report.floorGB)}: nothing to do`);
}
