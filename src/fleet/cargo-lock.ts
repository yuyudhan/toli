// Delete a cargo target folder between build steps: take cargo's own file locks (flock on `.cargo-lock` and friends,
// held while cargo compiles), make sure no cargo runs in the target's workspace and no process uses the folder (cargo
// releases its locks before it runs the test binaries, so a test binary, a process working in the workspace, or a
// build tool there counts as using it; so does any open file under it), rename it aside under the locks, release them,
// then delete the renamed tree. A cargo that starts meanwhile waits on the lock, then builds into a fresh, empty target.
// The renamed tree (`<target>.toli-wipe-<ms>`) is in the checkout's git excludes, so git (`git status`, a dirty-tree
// check) never lists it; root-owned files in it go through a throwaway container (remove-tree.ts), and a tree that
// still stays is reported and deleted by the next keeper run.
import { dlopen, FFIType } from "bun:ffi";
import {
    appendFileSync,
    closeSync,
    type Dirent,
    existsSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { run } from "../core/util.ts";
import { openBelow, WIPE_ASIDE } from "./disk-scan.ts";
import { liveBuildUse } from "./live-builds.ts";
import { removeTree } from "./remove-tree.ts";
import { cargoRunsIn, LIVE_PROBES, targetUse, type UseProbes } from "./target-use.ts";

/** The lock files cargo holds while it compiles; only a whole-target wipe under them ever removes one. */
export const CARGO_LOCKS: Readonly<Record<string, true>> = {
    ".cargo-lock": true,
    ".cargo-build-lock": true,
    ".cargo-artifact-lock": true,
};
/** Profile dirs sit at most this deep: `target/debug`, `target/<triple>/debug`, `target/clippy/debug`. */
export const LOCK_DEPTH = 3;
export const LOCK_EX = 2;
export const LOCK_NB = 4;
export const LOCK_UN = 8;
const RETRY_MS = 2000;

export type Flock = (fd: number, operation: number) => number;

let flockFn: Flock | null | undefined;

/**
 * libc flock(2) through Bun's FFI (also the build slots' lock); null where libc cannot be loaded. The library is the
 * host's own, so it follows the real OS, never `TOLI_PLATFORM`.
 */
export function flock(): Flock | null {
    if (flockFn !== undefined) return flockFn;
    const candidates =
        process.platform === "darwin" ? ["libc.dylib", "/usr/lib/libSystem.B.dylib"] : ["libc.so.6", "libc.so"];
    flockFn = null;
    for (const name of candidates) {
        try {
            const lib = dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
            flockFn = (fd, operation) => lib.symbols.flock(fd, operation);
            break;
        } catch {
            // Try the next name.
        }
    }
    return flockFn;
}

/** Every cargo lock file in the target folder's top levels. */
export function cargoLockFiles(target: string): string[] {
    const found: string[] = [];
    const walk = (dir: string, depth: number): void => {
        let entries: Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const path = join(dir, entry.name);
            if (entry.isFile() && CARGO_LOCKS[entry.name] === true) found.push(path);
            else if (entry.isDirectory() && depth < LOCK_DEPTH) walk(path, depth + 1);
        }
    };
    walk(target, 0);
    return found;
}

/** Take every lock without blocking; all or none. Returns the held fds, or the first busy lock's path. */
function tryLockAll(files: string[], lock: Flock): number[] | string {
    const held: number[] = [];
    for (const file of files) {
        let fd: number;
        try {
            fd = openSync(file, "r");
        } catch {
            continue; // Removed meanwhile: nothing to hold.
        }
        if (lock(fd, LOCK_EX | LOCK_NB) !== 0) {
            closeSync(fd);
            release(held, lock);
            return file;
        }
        held.push(fd);
    }
    return held;
}

function release(fds: number[], lock: Flock): void {
    for (const fd of fds) {
        lock(fd, LOCK_UN);
        closeSync(fd);
    }
}

export type WipeOutcome = { wiped: true } | { wiped: false; reason: string };

function openIn(target: string, probes: UseProbes): string | null {
    const open = openBelow(target, 3, probes.openFiles);
    return open.length > 0 ? `open files, e.g. ${open.join(", ")}` : null;
}

/**
 * Why something other than a lock uses `target`: a cargo in its workspace, a live build compiling into it (a cargo or
 * rustc told its CARGO_TARGET_DIR, a held heavy-build slot), a process running from it, an open file.
 */
function useBesideLocks(target: string, probes: UseProbes): string | null {
    return (
        cargoRunsIn(dirname(target), probes.cargos) ??
        liveBuildUse(target, probes.builds()) ??
        targetUse(target, probes.processes, probes.buildTools) ??
        openIn(target, probes)
    );
}

export type IdleOutcome<T> = { ran: true; value: T } | { ran: false; reason: string };

/**
 * Run `body` while holding every cargo lock of `target`, only when no build holds one, `holdOff` gives no reason to
 * wait and nothing else uses the target (see useBesideLocks); otherwise run nothing and say why. A cargo that starts
 * meanwhile waits on the lock.
 */
export function whileIdle<T>(
    target: string,
    body: () => T,
    probes: UseProbes = LIVE_PROBES,
    holdOff: () => string | null = () => null,
): IdleOutcome<T> {
    const lock = flock();
    if (lock === null) return { ran: false, reason: "cannot load libc flock to take cargo's locks" };
    const held = tryLockAll(cargoLockFiles(target), lock);
    if (typeof held === "string") return { ran: false, reason: `a build holds ${held}` };
    try {
        const busy = holdOff() ?? useBesideLocks(target, probes);
        return busy === null ? { ran: true, value: body() } : { ran: false, reason: busy };
    } finally {
        release(held, lock);
    }
}

/**
 * One try at wiping `target` between build steps (wipeTargetBetweenBuilds, no waiting): why it stays, or null once it
 * is gone. With `dryRun` it makes the same checks (cargo's locks, `holdOff`, useBesideLocks) and deletes nothing, so
 * the keeper's dry run keeps what the real run keeps.
 */
export function wipeNow(
    target: string,
    dryRun: boolean,
    holdOff: () => string | null = () => null,
    probes: UseProbes = LIVE_PROBES,
): string | null {
    if (dryRun) {
        const outcome = whileIdle(target, () => null, probes, holdOff);
        return outcome.ran ? null : outcome.reason;
    }
    const outcome = wipeTargetBetweenBuilds(target, 0, holdOff, probes);
    return outcome.wiped ? null : outcome.reason;
}

/**
 * Wipe `target` once no build holds its locks, no cargo runs in its workspace (the folder holding it), no process uses
 * it and `holdOff` (checked on every try) gives no reason to wait, retrying for up to `waitMs`. Nothing is deleted
 * when that moment never comes; the returned reason says why. `probes` say who uses the target: the live machine
 * unless a test injects its own process list.
 */
export function wipeTargetBetweenBuilds(
    target: string,
    waitMs: number,
    holdOff: () => string | null = () => null,
    probes: UseProbes = LIVE_PROBES,
): WipeOutcome {
    const lock = flock();
    if (lock === null) return { wiped: false, reason: "cannot load libc flock to take cargo's locks" };
    const deadline = Date.now() + waitMs;
    let reason = "";
    for (;;) {
        const held = tryLockAll(cargoLockFiles(target), lock);
        if (typeof held === "string") reason = `a build holds ${held}`;
        else {
            try {
                const busy = holdOff() ?? useBesideLocks(target, probes);
                if (busy !== null) reason = busy;
                else {
                    // Renaming can need a directory block that a full disk lacks: then delete in place, still under
                    // the locks, so the space comes back either way.
                    const aside = renameAside(target);
                    const stays = aside === null ? removeTree(target) : null;
                    release(held, lock);
                    held.length = 0;
                    if (stays !== null) return { wiped: false, reason: stays };
                    // Builds already have a fresh target; a renamed tree that stays is said, and the next keeper
                    // run tries it again (disk.ts step 0), never left silently.
                    const left = aside === null ? null : removeTree(aside);
                    if (left !== null)
                        return { wiped: false, reason: `renamed aside to ${aside}, which stays: ${left}` };
                    return { wiped: true };
                }
            } finally {
                release(held, lock);
            }
        }
        if (Date.now() + RETRY_MS > deadline) return { wiped: false, reason };
        Bun.sleepSync(RETRY_MS);
    }
}

/**
 * Rename `target` to a sibling `<target>.toli-wipe-<ms>`; null when the rename fails. The checkout's git excludes
 * (`info/exclude`) get `*.toli-wipe-*` first, so `git status` and a dirty-tree check never list the renamed tree,
 * which `target`'s own ignore pattern no longer matches, even when it holds root-owned files that cannot go at once.
 */
export function renameAside(target: string): string | null {
    excludeAsides(dirname(target));
    const aside = `${target}${WIPE_ASIDE}${Date.now()}`;
    try {
        renameSync(target, aside);
        return aside;
    } catch {
        return null;
    }
}

/** Add `*.toli-wipe-*` to the excludes of the git checkout holding `dir`, once; nothing outside a checkout. */
function excludeAsides(dir: string): void {
    const common = run(["git", "-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (common.code !== 0) return;
    const file = join(common.stdout.trim(), "info", "exclude");
    const line = `*${WIPE_ASIDE}*`;
    try {
        const current = existsSync(file) ? readFileSync(file, "utf8") : "";
        if (current.split("\n").includes(line)) return;
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, `${current === "" || current.endsWith("\n") ? "" : "\n"}${line}\n`);
    } catch {
        // A full disk may refuse even this line: the leftover is still swept by name (disk.ts step 0).
    }
}
