// The disk keeper: low free disk is never a reason to stop work. When free space on toli's volume is under its floor
// (capacity.diskKeepGB in config/machine.json, default 60, capped at 15% of the volume's size so a small disk is never
// emptied), it deletes rebuildable output only, cheapest to rebuild first and oldest first within each step, until
// free space is back at the floor:
//   1. build output finished no-mistakes runs left in their worktrees (no-mistakes-runs.ts), then whole `target/`
//      folders of project checkouts nothing uses (no running jawan, no process working there, no live build compiling
//      into it: a cargo or rustc, or a held heavy-build slot, live-builds.ts);
//   2. `node_modules/` and `dist/` of those idle checkouts, except a project main clone's `node_modules/` (builds run
//      there between jobs and cannot reinstall dependencies themselves; cargo rebuilds a wiped `target/` on its own);
//   3. Docker build cache and unused images, not while a pull or build runs and not every minute (docker-prune.ts);
//   4. sccache's local cache entries past its own cap;
// Under the emergency level (max(5 GB, 3% of the disk), at most the floor) it goes on, re-checking free disk after
// each item and stopping once it is over that level, so build output in use goes only when nothing idle is left:
//   5. Docker volumes of idle build output that no running container uses, never one that may hold data
//      (docker-volumes.ts);
//   6. `target/` folders of busy checkouts, between build steps: under cargo's own locks, with no cargo running in
//      its workspace, no live build compiling into it and no file in it open. A target that stays in use is kept
//      whole: never a partial delete under a live build, whose up-to-date artifacts can sit unwritten for hours;
//   7. last resort: the `target/` folders left, in use or not (those no live build uses first, each build cut off
//      named in the log), then `node_modules/` (but a main clone's), `dist/` and Playwright's browser cache. All of
//      it rebuilds itself; a build cut off fails once and compiles again.
// Over the emergency level build output in use is never touched, not even a sweep of its old artifacts.
// Only git-ignored, wholly untracked folders are candidates, so sources, git data and uncommitted work are never
// touched. A folder a live Docker container mounts (a bind, a volume's mountpoint, a mount hung on it inside a bind)
// is never deleted at any step, the last resort included (container-mounts.ts). Every action goes to logs/disk.log.
// It runs inline before every jawan start; the minute tick starts it detached (disk-state.ts keepDiskDetached), so a
// keeper slowed by a starved disk never holds the tick up.
// A live pid in state/disk-keep.pause (touched within 2 h) holds it off. On a full disk it writes nothing before it
// has freed something, and when it fails anyway the fallback sweeps stale artifacts out of every target nothing uses.
// capacity.diskKeep false switches all of this off but `bin/toli disk keep` by hand: low disk then only alerts the
// inbox (disk-alert.ts). Details: docs/disk.md.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { out, ToliError, warn } from "../core/util.ts";
import { dryRun as envDryRun } from "../jobs/os-scheduler.ts";
import { wipeTargetBetweenBuilds } from "./cargo-lock.ts";
import { containerUseOnce } from "./container-mounts.ts";
import { diskAlertBeforeWork, diskKeepSetting } from "./disk-alert.ts";
import { playwrightBrowsers, trimSccache } from "./disk-caches.ts";
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
    gb,
    KEEPER_LOCK,
    keepDiskDetached,
    machineFloor,
    PAUSE_EXPIRY_MS,
    pauseHold,
    releaseKeeper,
} from "./disk-state.ts";
import { pruneDocker } from "./docker-prune.ts";
import { freeBuildVolumes } from "./docker-volumes.ts";
import { liveBuilds, liveBuildUse } from "./live-builds.ts";
import { freeRunWorktrees } from "./no-mistakes-runs.ts";
import { diskEmergencyGB, measureDisk, measureVolume } from "./resources.ts";
import { fallbackSweep } from "./stale-sweep.ts";

export type KeepOptions = {
    /** Overrides the floor (capacity.diskKeepGB, capped at 15% of the disk); not capped itself. */
    floorGB?: number;
    /** Plan only: report what would go, counting each folder's size as freed. Also on with TOLI_DRY_RUN=1. */
    dryRun?: boolean;
    /** Also print each line (the CLI); every line goes to logs/disk.log either way. */
    echo?: boolean;
};

export type KeepReport = {
    floorGB: number;
    /**
     * Free disk under which idle build volumes and build output in use go too (steps 5 to 7): max(5 GB, 3% of the
     * disk), at most the floor.
     */
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
    /** True when the last resort ran: under the emergency level, so build output in use went too (step 7). */
    lastResort: boolean;
    /** False when capacity.diskKeep is false (or invalid): toli deletes nothing on its own, only this run by hand. */
    automatic: boolean;
    lines: string[];
};

/** `floor X GB`, with why when the cap lowered it. */
export const floorText = (report: KeepReport): string =>
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
    const volume = measureVolume(paths.root());
    if (typeof volume === "string") throw new ToliError(`cannot read free disk: ${volume}`);
    const freeBeforeGB = volume.freeGB;
    // An explicit floor is the caller's choice; the configured one is capped so a small disk is never emptied.
    const floor = options.floorGB === undefined ? machineFloor(machine, volume.totalGB) : { floorGB: options.floorGB };
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
        lastResort: false,
        automatic: diskKeepSetting(machine) === true,
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
        /**
         * A folder a live container mounts stays at every step, the last resort included: deleting it unhooks the
         * mount inside the running container (container-mounts.ts). Each kept folder is logged once.
         */
        const containerUse = containerUseOnce();
        const containerHeld = new Set<string>();
        const mounted = (path: string): boolean => {
            if (containerHeld.has(path)) return true;
            const why = containerUse(path);
            if (why === null) return false;
            containerHeld.add(path);
            kept.set(path, { reason: why, tried: true });
            say(`kept ${path}: ${why}; a folder a live container mounts is never deleted`);
            return true;
        };
        /** Delete `path` (`step` names the step, for the log), or record why it stays. */
        const remove = (path: string, step: string, deleteIt: () => string | null): void => {
            if (mounted(path)) return;
            if (dryRun) {
                const size = sizeGB(path);
                simulated += size;
                done.add(path);
                say(`would delete ${path} (${gb(size)}, ${step})`);
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
            say(`deleted ${path}, freed ${gb(Math.max(0, free() - before))} (${step})`);
        };
        const idleTier = (
            step: number,
            kinds: BuildDir["kind"][],
            deleteIt: (dir: BuildDir) => string | null,
        ): void => {
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
                if (reason === null) remove(dir.path, `step ${step}: idle ${dir.kind}`, () => deleteIt(dir));
                else {
                    kept.set(dir.path, { reason, tried: false });
                    say(`skipped ${dir.path}: ${reason}`);
                }
            }
        };
        freeRunWorktrees({ dryRun, checkouts, enough, remove, say });
        // 1 and 2: idle checkouts. The target wipe still takes cargo's locks once, for builds run from elsewhere.
        idleTier(1, ["target"], (dir) => wipeOutcome(dir.path));
        idleTier(2, ["node_modules", "dist"], (dir) => {
            const open = openBelow(dir.path);
            if (open.length > 0) return `open files, e.g. ${open.join(", ")}`;
            rmSync(dir.path, { recursive: true, force: true });
            return null;
        });
        // 3 and 4: machine-wide caches.
        if (!enough()) {
            const freeNow = free();
            pruneDocker({ dryRun, freeGB: freeNow, emergency: freeNow < report.emergencyGB }, say);
        }
        if (!enough()) trimSccache(dryRun, say);
        // 5: under the emergency level only, Docker volumes of idle build output, before any build folder in use:
        // the incident that made this a step lost a push gate's target while a stopped stack's 23 GB target volume
        // stayed. Only until free disk is over the emergency level, like 6 and 7.
        const over = (): boolean => free() >= report.emergencyGB;
        if (!enough() && !over()) {
            const simulate = (size: number): void => {
                simulated += size;
            };
            if (freeBuildVolumes({ dryRun, free, over, simulate }, say) > 0) log.open();
        }
        // 6: under the emergency level only, every target still here, busy ones included, between build steps.
        // Builds pause between cargo invocations; the wipe takes such a pause under cargo's locks. A target with no
        // pause right now (builds back to back) stays whole: deleting part of it under a live build breaks that build
        // (cargo links rlibs it compiled hours ago). Over the emergency level a target in use is never touched:
        // losing a long build's output costs more than the space.
        const busy = dirs.filter((dir) => dir.kind === "target" && !done.has(dir.path));
        for (const dir of busy) {
            if (enough()) break;
            if (over()) {
                const level = `the emergency level ${gb(report.emergencyGB)}`;
                say(`kept ${dir.path} in use: free ${gb(free())} is over ${level}`);
                continue;
            }
            if (mounted(dir.path)) continue;
            const why = kept.get(dir.path);
            if (why?.tried !== true) {
                say(`${dir.path} is in use (${why?.reason ?? "no reason recorded"}): wiping it between build steps`);
                remove(dir.path, "step 6: in use, between build steps", () => wipeOutcome(dir.path));
            }
        }
        // 7: the last resort, under the emergency level after 1 to 6: the targets left go now, in use or not, those no
        // live build compiles into first (the build a deletion cuts off is named), then node_modules (never a main
        // clone's, see 2), dist and Playwright's browsers, each only while free disk is under the emergency level.
        // Docker's build cache already went in 3, its idle build volumes in 5. Only what buildDirs listed.
        if (!over()) {
            report.lastResort = true;
            const level = `the emergency level ${gb(report.emergencyGB)}`;
            say(
                `free ${gb(free())} is under ${level}: deleting every build folder left, in use or not, until free space is over that level`,
            );
            const force = (path: string, build: string | null = null): void => {
                if (mounted(path)) return;
                const why = build ?? kept.get(path)?.reason;
                const cut = build === null ? "" : "; that build fails and must run again";
                if (why !== undefined) say(`${path} is in use (${why}): deleting it anyway${cut}`);
                remove(path, "step 7: last resort", () => forceDelete(path));
            };
            const left = (dir: BuildDir): boolean =>
                !done.has(dir.path) && ![...done].some((gone) => within(dir.path, gone)) && existsSync(dir.path);
            const live = liveBuilds();
            const targets = dirs.flatMap((dir) =>
                dir.kind === "target" && left(dir) ? [{ dir, build: liveBuildUse(dir.path, live) }] : [],
            );
            targets.sort((a, b) => Number(a.build !== null) - Number(b.build !== null));
            for (const { dir, build } of targets) if (!over() && left(dir)) force(dir.path, build);
            const mainDeps = (dir: BuildDir): boolean => dir.kind === "node_modules" && dir.checkout.main;
            for (const dir of dirs)
                if (dir.kind !== "target" && !mainDeps(dir) && !over() && left(dir)) force(dir.path);
            if (!over()) {
                const browsers = playwrightBrowsers();
                if (browsers.length === 0) say("playwright: no browser cache");
                for (const path of browsers) if (!over()) force(path);
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

function wipeOutcome(target: string): string | null {
    const outcome = wipeTargetBetweenBuilds(target, 0, pauseHold);
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
 * Before work starts (each jawan launch): free disk inline. `detached` (the minute tick) only starts the background
 * keeper, to do all of it. With capacity.diskKeep false nothing is deleted: low disk only alerts the inbox
 * (src/fleet/disk-alert.ts). Never throws: disk never stops work.
 */
export function keepDiskBeforeWork(mode: "inline" | "detached" = "inline"): string | null {
    let setting: boolean | string = true;
    try {
        setting = diskKeepSetting(loadMachine());
    } catch {
        // An unreadable config: the keeper below reports it and falls back to sweeping, as it always has.
    }
    if (typeof setting === "string") return `disk keeper: ${setting}: deleting nothing`;
    if (!setting) return diskAlertBeforeWork(mode, envDryRun());
    if (mode === "detached") return keepDiskDetached(envDryRun());
    let report: KeepReport;
    try {
        report = keepDisk();
    } catch (error) {
        fallbackSweep(error, false, envDryRun());
        return `disk keeper failed: ${describe(error)}; swept stale artifacts instead (logs/disk.log)`;
    }
    if (!report.ran) return null;
    const cut = report.lastResort ? "; build output in use was deleted too, so a build may need running again" : "";
    return `disk keeper: free ${gb(report.freeBeforeGB)} -> ${gb(report.freeAfterGB)} (${floorText(report)})${cut}`;
}
