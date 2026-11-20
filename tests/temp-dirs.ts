// How the test run names and removes its temp dirs (T2150); tests/helpers.ts `tempDir` makes them.
import { chmodSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidAlive } from "../src/core/util.ts";

/** A temp dir's `mkdtemp` prefix: `toli-<prefix>-p<pid>-` names the test process that owns it. */
export function tempPrefix(prefix: string): string {
    return `toli-${prefix}-p${process.pid}-`;
}

const OWNED = /^toli-.+-p(\d+)-[A-Za-z0-9]{6}$/;

/**
 * Removes the temp dirs under `base` whose owning test process is gone: what a run killed before its own cleanup
 * (SIGKILL, a crash) or a process still writing after the run ended left. Another run's dirs stay while it lives.
 */
export function sweepDeadRunTemps(base = tmpdir()): void {
    for (const name of readdirSync(base)) {
        const pid = OWNED.exec(name)?.[1];
        if (pid !== undefined && !pidAlive(Number(pid))) removeTemp(join(base, name));
    }
}

/**
 * Best-effort removal: a dir a test left read-only (a root-owned build output stand-in) is made writable and removed
 * again; one that still cannot be removed is reported, never left to stop the next dir's cleanup.
 */
export function removeTemp(dir: string): void {
    try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
        try {
            makeWritable(dir);
            rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
        } catch (error) {
            process.stderr.write(`tests: could not remove ${dir}: ${(error as Error).message}\n`);
        }
    }
}

function makeWritable(dir: string): void {
    chmodSync(dir, 0o700);
    for (const entry of readdirSync(dir, { withFileTypes: true }))
        if (entry.isDirectory() && !entry.isSymbolicLink()) makeWritable(join(dir, entry.name));
}
