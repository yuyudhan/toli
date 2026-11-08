// Delete a cargo target folder between build steps: take cargo's own file locks (flock on `.cargo-lock` and friends,
// held while cargo compiles), make sure no cargo runs in the target's workspace and no process uses the folder (cargo
// releases its locks before it runs the test binaries, so a test binary, a process working in the workspace, or a
// build tool there counts as using it; so does any open file under it), rename it aside under the locks, release them,
// then delete the renamed tree. A cargo that starts meanwhile waits on the lock, then builds into a fresh, empty target.
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, type Dirent, openSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { platform } from "../core/util.ts";
import { cargoRunsIn, openBelow, targetUse } from "./disk-scan.ts";

/** The lock files cargo holds while it compiles; only a whole-target wipe under them ever removes one. */
export const CARGO_LOCKS: Readonly<Record<string, true>> = {
    ".cargo-lock": true,
    ".cargo-build-lock": true,
    ".cargo-artifact-lock": true,
};
/** Profile dirs sit at most this deep: `target/debug`, `target/<triple>/debug`, `target/clippy/debug`. */
export const LOCK_DEPTH = 3;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const RETRY_MS = 2000;

type Flock = (fd: number, operation: number) => number;

let flockFn: Flock | null | undefined;

/** libc flock(2) through Bun's FFI; null where libc cannot be loaded (then no lock is ever taken). */
function flock(): Flock | null {
    if (flockFn !== undefined) return flockFn;
    const candidates =
        platform() === "darwin" ? ["libc.dylib", "/usr/lib/libSystem.B.dylib"] : ["libc.so.6", "libc.so"];
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

function openIn(target: string): string | null {
    const open = openBelow(target);
    return open.length > 0 ? `open files, e.g. ${open.join(", ")}` : null;
}

/**
 * Wipe `target` once no build holds its locks, no cargo runs in its workspace (the folder holding it), no process uses
 * it and `holdOff` (checked on every try) gives no reason to wait, retrying for up to `waitMs`. Nothing is deleted
 * when that moment never comes; the returned reason says why.
 */
export function wipeTargetBetweenBuilds(
    target: string,
    waitMs: number,
    holdOff: () => string | null = () => null,
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
                const busy = holdOff() ?? cargoRunsIn(dirname(target)) ?? targetUse(target) ?? openIn(target);
                if (busy !== null) reason = busy;
                else {
                    // Renaming can need a directory block that a full disk lacks: then delete in place, still under
                    // the locks, so the space comes back either way.
                    const aside = renameAside(target);
                    if (aside === null) rmSync(target, { recursive: true, force: true });
                    release(held, lock);
                    held.length = 0;
                    if (aside !== null) rmSync(aside, { recursive: true, force: true });
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

/** Rename `target` to a sibling `<target>.toli-wipe-<ms>`; null when the rename fails. */
function renameAside(target: string): string | null {
    const aside = `${target}.toli-wipe-${Date.now()}`;
    try {
        renameSync(target, aside);
        return aside;
    } catch {
        return null;
    }
}
