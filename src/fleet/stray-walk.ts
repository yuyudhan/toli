// The stray-build scan's walk of one folder tree (src/fleet/build-place.ts), run as a process of its own so its caller
// can stop it: on macOS opening a privacy-protected folder (a home folder like ~/Music, or an app's
// $TMPDIR/<app>/TemporaryItems) waits for an answer to a privacy prompt, the kernel returns EINTR every 5 s and Bun
// retries the read forever (T2243). `bun stray-walk.ts` reads one WalkJob as JSON on stdin and writes one WalkEvent per
// line to stdout as it goes: a folder before it is read, each build folder's owner found, and the end. What it found
// before it was stopped is never lost, and the last folder it started to read is the one that never answered.
// Imports only node built-ins, so the process starts fast.
import { type Dirent, readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

export type WalkJob = {
    /** The resolved folder the walk starts in. */
    root: string;
    /** Resolved folders never opened: the known places and the home folder's privacy-protected ones. */
    never: string[];
    /** Folder names never descended into, at any depth. */
    skipNames: string[];
    /** Folder names whose presence marks a folder as a build's working tree. */
    buildFolders: string[];
    /** How many levels below `root` are read. */
    depth: number;
    /** At most this many folders are read. */
    limit: number;
    /** At most this long is spent reading, between folders. */
    ms: number;
};

export type WalkEvent = { reading: string } | { found: string; builds: string[] } | { end: true; stopped: boolean };

/** Walk `job.root`, emitting each event; `stopped` in the end event: the walk hit its folder limit or time limit. */
export function walk(job: WalkJob, emit: (event: WalkEvent) => void): void {
    const never = new Set(job.never);
    const skip = new Set(job.skipNames);
    const deadline = Date.now() + job.ms;
    let budget = job.limit;
    let stopped = false;
    const visit = (dir: string, depth: number): void => {
        if (stopped || never.has(dir)) return;
        if (budget <= 0 || Date.now() > deadline) {
            stopped = true;
            return;
        }
        budget--;
        emit({ reading: dir });
        let entries: Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        const folders = entries.filter((entry) => entry.isDirectory());
        const builds = folders.filter((entry) => job.buildFolders.includes(entry.name)).map((entry) => entry.name);
        if (builds.length > 0) {
            emit({ found: dir, builds });
            return;
        }
        if (depth >= job.depth) return;
        for (const entry of folders) {
            if (entry.name.startsWith(".") || skip.has(entry.name)) continue;
            visit(join(dir, entry.name), depth + 1);
        }
    };
    visit(job.root, 0);
    emit({ end: true, stopped });
}

if (import.meta.main) {
    const job = JSON.parse(readFileSync(0, "utf8")) as WalkJob;
    walk(job, (event) => {
        writeSync(1, `${JSON.stringify(event)}\n`);
    });
}
