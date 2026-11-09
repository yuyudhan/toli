// The disk keeper: low free disk is never a reason to stop work. When free space on toli's volume is under its floor
// (capacity.diskKeepGB in config/machine.json, default 60, capped at 15% of the volume's size so a small disk is never
// emptied), it deletes rebuildable output only, cheapest to rebuild first and oldest first within each step, until
// free space is back at the floor:
//   1. whole `target/` folders of project checkouts nothing uses (no running jawan, no process working there);
//   2. `node_modules/` and `dist/` of those idle checkouts, except a project main clone's `node_modules/`: builds run
//      there between jobs (a project's build queue) and cannot reinstall dependencies themselves, while cargo
//      rebuilds a wiped `target/` on its own (that wipe matches the cargo-sweep helper's: under cargo's locks, only
//      while no jawan of the project runs);
//   3. Docker build cache and unused images (`docker builder prune -af`, `docker image prune -af`; never volumes);
//   4. sccache's local cache entries past its own cap;
//   5. `target/` folders of busy checkouts, between build steps: under cargo's own locks, with no cargo running in
//      its workspace (cargo test runs its test binaries after dropping the locks) and no file in it open. A target
//      that stays in use (builds back to back) is swept instead: every artifact in it unused for
//      capacity.diskSweepStaleMinutes (default 180) goes, lock or no lock (src/fleet/stale-sweep.ts);
//   6. last resort, only under the emergency level (max(5 GB, 3% of the disk), at most the floor) after 1 to 5: every
//      `target/` left, in use or not, then every `node_modules/` (but a main clone's) and `dist/` and Playwright's
//      browser cache. All of it rebuilds itself; a build cut off fails once and compiles again. Between the floor and
//      the emergency level only idle output goes, so a disk a little under its floor never cuts a build off.
// Only git-ignored, wholly untracked folders are candidates, so sources, git data and uncommitted work are never
// touched. Every action goes to logs/disk.log. It runs inline before every jawan start and from the minute tick.
// Any long job that must keep its build output for now (a gate, a release build) writes its pid to
// state/disk-keep.pause; the keeper deletes nothing while that pid is alive and the file was touched within 2 h (a
// longer job touches it again). It ignores the file once the pid is dead, and drops it, logged once, once it is older.
// A keeper already waiting for a busy target to pause checks the marker again before every try.
// On a full disk it still works: it writes nothing before it has freed something (log lines wait in memory; a keeper
// lock it cannot write is done without), no failed write stops it, and when the keeper fails anyway the fallback
// sweeps stale artifacts out of every target, writing nothing first.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname } from "node:path";
import { Args } from "../core/args.ts";
import { loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { out, printJson, ToliError, warn } from "../core/util.ts";
import { dryRun as envDryRun } from "../jobs/os-scheduler.ts";
import { wipeTargetBetweenBuilds } from "./cargo-lock.ts";
import { playwrightBrowsers, pruneDocker, trimSccache } from "./disk-caches.ts";
import {
    type BuildDir,
    buildDirs,
    checkoutUse,
    currentHolders,
    openBelow,
    projectCheckouts,
    sizeGB,
    within,
} from "./disk-scan.ts";
import {
    claimKeeper,
    DiskLog,
    describe,
    diskPause,
    expirePause,
    GIB,
    gb,
    KEEPER_LOCK,
    PAUSE_EXPIRY_MS,
    releaseKeeper,
    startBackgroundKeeper,
} from "./disk-state.ts";
import {
    capacityFor,
    diskEmergencyGB,
    diskKeepFloor,
    diskSweepStaleMinutes,
    measureDisk,
    measureVolume,
} from "./resources.ts";
import { fallbackSweep, sweepLine, sweepStaleArtifacts } from "./stale-sweep.ts";

export type KeepOptions = {
    /** Overrides the floor (capacity.diskKeepGB, capped at 15% of the disk); not capped itself. */
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
    /** Free disk under which build output in use goes too (tier 6): max(5 GB, 3% of the disk), at most the floor. */
    emergencyGB: number;
    /** Why the floor is under capacity.diskKeepGB, when the 15% cap lowered it. */
    floorNote?: string;
    diskTotalGB: number;
    freeBeforeGB: number;
    freeAfterGB: number;
    dryRun: boolean;
    /** False when free space was already at or above the floor, another keeper is running, or a pause holds it. */
    ran: boolean;
    /** The live pid in state/disk-keep.pause that held the keeper off, if one did. */
    pausedBy?: number;
    /** Busy targets swept of stale artifacts (tier 5), with what each freed (or, in a dry run, would free). */
    swept: { target: string; artifacts: number; bytes: number }[];
    /** True when the last resort ran: under the emergency level, so build output in use went too (tier 6). */
    lastResort: boolean;
    lines: string[];
};

/** `floor X GB`, with why when the cap lowered it. */
const floorText = (report: KeepReport): string =>
    `floor ${gb(report.floorGB)}${report.floorNote === undefined ? "" : ` (${report.floorNote})`}`;

function freeGB(): number {
    const free = measureDisk(paths.root());
    if (typeof free === "string") throw new ToliError(`cannot read free disk: ${free}`);
    return free;
}

/**
 * Free disk up to the floor, in the order above. Never throws for a failed deletion or a failed write; it logs and
 * moves on. It throws only when it cannot start (free disk or config unreadable): see fallbackSweep.
 */
export function keepDisk(options: KeepOptions = {}): KeepReport {
    const dryRun = options.dryRun === true || envDryRun();
    const machine = loadMachine();
    const staleMinutes = diskSweepStaleMinutes(machine);
    const volume = measureVolume(paths.root());
    if (typeof volume === "string") throw new ToliError(`cannot read free disk: ${volume}`);
    const freeBeforeGB = volume.freeGB;
    // An explicit floor is the caller's choice; the configured one is capped so a small disk is never emptied.
    const floor =
        options.floorGB === undefined
            ? diskKeepFloor(capacityFor(machine, Math.max(1, cpus().length)).diskKeepGB, volume.totalGB)
            : { floorGB: options.floorGB };
    const floorGB = floor.floorGB;
    const report: KeepReport = {
        floorGB,
        emergencyGB: diskEmergencyGB(floorGB, volume.totalGB),
        ...(floor.note === undefined ? {} : { floorNote: floor.note }),
        diskTotalGB: volume.totalGB,
        freeBeforeGB,
        freeAfterGB: freeBeforeGB,
        dryRun,
        ran: false,
        swept: [],
        lastResort: false,
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
        const line = `free ${gb(freeBeforeGB)} < ${floorText(report)}: ${reason}`;
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
    // A pause past its expiry is dropped, once, with a line saying so; on a full disk the line waits in memory.
    const expired = expirePause();
    if (expired !== null) {
        say(`pause by pid ${expired} expired after ${PAUSE_EXPIRY_MS / 3_600_000} h; cleaning resumed`);
        log.flush();
    }
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
        const enough = (): boolean => free() >= floorGB;
        say(`free ${gb(freeBeforeGB)} < ${floorText(report)}: freeing build output until free space is back there`);
        if (claim.kind === "unwritable")
            say(`cannot write ${paths.lock(KEEPER_LOCK)} (${claim.reason}): freeing without the keeper lock`);
        const checkouts = projectCheckouts();
        const dirs = checkouts.flatMap(buildDirs).sort((a, b) => a.mtimeMs - b.mtimeMs);
        /** Folders deleted (or, in a dry run, counted as deleted), and why each other one was kept: in use, or tried. */
        const done = new Set<string>();
        const kept = new Map<string, { reason: string; tried: boolean }>();
        const remove = (path: string, deleteIt: () => string | null): void => {
            if (dryRun) {
                const size = sizeGB(path);
                simulated += size;
                done.add(path);
                say(`would delete ${path} (${gb(size)})`);
                return;
            }
            const before = free();
            const refusal = deleteIt();
            if (refusal !== null) {
                kept.set(path, { reason: refusal, tried: true });
                say(`kept ${path}: ${refusal}`);
                return;
            }
            done.add(path);
            log.open();
            say(`deleted ${path}, freed ${gb(Math.max(0, free() - before))}`);
        };
        const idleTier = (kinds: BuildDir["kind"][], deleteIt: (dir: BuildDir) => string | null): void => {
            const holders = currentHolders();
            for (const dir of dirs) {
                if (enough()) return;
                if (!kinds.includes(dir.kind)) continue;
                // A main clone's dependencies are never idle output. Use is checked again just before a real
                // deletion: a run may have started in that checkout meanwhile.
                if (dir.kind === "node_modules" && dir.checkout.main) {
                    say(`kept ${dir.path}: a main clone's dependencies (its builds cannot reinstall them)`);
                    continue;
                }
                let reason = checkoutUse(dir.checkout, holders, checkouts);
                if (reason === null && !dryRun) reason = checkoutUse(dir.checkout, currentHolders(), checkouts);
                if (reason === null) remove(dir.path, () => deleteIt(dir));
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
                remove(dir.path, () => wipeOutcome(dir.path, 0));
            }
            if (done.has(dir.path) || enough()) continue;
            const swept = sweepStaleArtifacts(dir.path, staleMinutes, dryRun);
            report.swept.push({ target: dir.path, artifacts: swept.artifacts, bytes: swept.bytes });
            if (dryRun) simulated += swept.bytes / GIB;
            else if (swept.artifacts > 0) log.open();
            say(sweepLine(dir.path, staleMinutes, swept, dryRun));
        }
        // 6: the last resort, under the emergency level after 1 to 5: every target left goes now, in use or not, then
        // node_modules (never a main clone's, see 2) and dist (Vite's cache lives in node_modules/.vite) and
        // Playwright's browsers, until the floor. Docker's build cache already went in 3. Only what buildDirs listed.
        if (free() < report.emergencyGB) {
            report.lastResort = true;
            const level = `the emergency level ${gb(report.emergencyGB)}`;
            say(`free ${gb(free())} is under ${level}: deleting every build folder left, in use or not`);
            const force = (path: string): void => {
                const why = kept.get(path)?.reason;
                if (why !== undefined) say(`${path} is in use (${why}): deleting it anyway`);
                remove(path, () => forceDelete(path));
            };
            const left = (dir: BuildDir): boolean =>
                !done.has(dir.path) && ![...done].some((gone) => within(dir.path, gone)) && existsSync(dir.path);
            for (const dir of dirs) if (dir.kind === "target" && left(dir)) force(dir.path);
            const mainDeps = (dir: BuildDir): boolean => dir.kind === "node_modules" && dir.checkout.main;
            for (const dir of dirs)
                if (dir.kind !== "target" && !mainDeps(dir) && !enough() && left(dir)) force(dir.path);
            if (!enough()) {
                const browsers = playwrightBrowsers();
                if (browsers.length === 0) say("playwright: no browser cache");
                for (const path of browsers) if (!enough()) force(path);
            }
        }
        // The background keeper then waits for a pause in what is still busy, for up to waitMs per target.
        const waitMs = options.lockWaitMs ?? 0;
        if (waitMs > 0 && !report.lastResort) {
            for (const dir of busy) {
                if (enough()) break;
                if (done.has(dir.path)) continue;
                const why = kept.get(dir.path)?.reason ?? "no reason recorded";
                const wait = `waiting up to ${Math.round(waitMs / 60_000)} min for a pause`;
                say(`${dir.path} is in use (${why}): wiping it between build steps, ${wait}`);
                remove(dir.path, () => wipeOutcome(dir.path, waitMs));
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

/** Delete `path` whatever uses it; the reason when it could not (a build may keep writing into it meanwhile). */
function forceDelete(path: string): string | null {
    try {
        rmSync(path, { recursive: true, force: true, maxRetries: 3 });
        return null;
    } catch (error) {
        return `could not delete it: ${describe(error)}`;
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
    const cut = report.lastResort ? "; build output in use was deleted too, so a build may need running again" : "";
    return `disk keeper: free ${gb(report.freeBeforeGB)} -> ${gb(report.freeAfterGB)} (${floorText(report)})${cut}`;
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
    else if (report.lines.length === 0) out(`free ${gb(report.freeBeforeGB)}, ${floorText(report)}: nothing to do`);
}
