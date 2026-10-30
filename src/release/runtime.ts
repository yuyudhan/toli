// The installed runtime: a pinned snapshot of toli's committed code that the live session runs.
//
// Jawans edit toli in place, in the same checkout that Sardar's omp, the extension's minute tick and the OS ticker
// call `bin/toli` in. `bin/toli` is a launcher: when the checkout has an installed runtime it imports the runtime's
// src/main.ts instead of the working tree's, so a half-edited working tree never breaks the live session.
//
//   ~/.toli/runtime/<checkout>-<hash>/<commit>/   `git archive` of one commit: tracked files only (src/ imports only
//                                                 Bun and node built-ins, so no node_modules)
//     .toli-runtime.json                          {checkout, commit, syncedAt}: paths.root() reads the checkout from
//                                                 it, so config/, data/, state/ and projects/ stay in the checkout
//   <checkout>/state/runtime                      the active snapshot directory (one line), read by bin/toli
//
// `bin/toli self sync` snapshots the checkout's HEAD, runs the snapshot once (`self status --json`, which loads every
// command module and proves the snapshot serves this checkout) and only then repoints state/runtime; a snapshot that
// does not load is refused and the live session keeps the previous one. `bin/toli commit toli` and `bin/toli upgrade`
// sync after they move HEAD. TOLI_DEV=1 (or TOLI_ROOT, which the tests set) makes bin/toli run the working tree.
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Args } from "../core/args.ts";
import { gitOk } from "../core/git.ts";
import { codeRoot, paths, RUNTIME_MARKER } from "../core/paths.ts";
import { isJsonObject, out, printJson, run, ToliError, writeJsonAtomic, writeTextAtomic } from "../core/util.ts";

/** Snapshots kept per checkout: the active one and the two before it (a running process may still import from them). */
const KEEP = 3;
const LOAD_TIMEOUT_MS = 60_000;
const TAIL_LINES = 20;

export type RuntimeStatus = {
    /** The checkout whose data this process serves (paths.root()). */
    root: string;
    /** Where this process's code runs from: the active snapshot, or the working tree. */
    code: string;
    /** The active snapshot directory named by state/runtime, or null when none is installed. */
    runtime: string | null;
    /** The commit the active snapshot holds, or null when none is installed or its marker is gone. */
    commit: string | null;
    /** The checkout's HEAD commit. */
    head: string;
    /** installed and on HEAD | installed but behind HEAD (run self sync) | pointer to a deleted snapshot | none. */
    state: "current" | "stale" | "missing" | "none";
};

export type Synced = { runtime: string; commit: string; previous: string | null; changed: boolean };

/**
 * The snapshot store of one checkout: `<home>/<name>-<hash of its real path>`, so two clones never share one. The
 * home is `TOLI_RUNTIME_HOME` (tests), else ~/.toli/runtime.
 */
function storeFor(checkout: string): string {
    const real = realpathSync(checkout);
    const hash = createHash("sha256").update(real).digest("hex").slice(0, 8);
    const home = process.env.TOLI_RUNTIME_HOME || join(homedir(), ".toli", "runtime");
    return join(home, `${basename(real)}-${hash}`);
}

/** The active snapshot directory named by `<checkout>/state/runtime`, or null when none is installed. */
export function activeRuntime(checkout: string = paths.root()): string | null {
    const pointer = paths.runtimePointer(checkout);
    if (!existsSync(pointer)) return null;
    const dir = readFileSync(pointer, "utf8").trim();
    return dir === "" ? null : dir;
}

function markerCommit(dir: string): string | null {
    const marker = join(dir, RUNTIME_MARKER);
    if (!existsSync(marker)) return null;
    const parsed: unknown = JSON.parse(readFileSync(marker, "utf8"));
    const commit = isJsonObject(parsed) ? parsed.commit : undefined;
    return typeof commit === "string" ? commit : null;
}

export function runtimeStatus(checkout: string = paths.root()): RuntimeStatus {
    const head = gitOk(checkout, ["rev-parse", "HEAD"]);
    const runtime = activeRuntime(checkout);
    const commit = runtime === null ? null : markerCommit(runtime);
    const state = runtime === null ? "none" : commit === null ? "missing" : commit === head ? "current" : "stale";
    return { root: checkout, code: codeRoot(), runtime, commit, head, state };
}

/** Export `commit` into a fresh directory of `store` and prove it loads and serves `checkout`; returns the directory. */
function buildSnapshot(checkout: string, store: string, commit: string): string {
    const staging = mkdtempSync(join(store, `.${commit.slice(0, 12)}-`));
    try {
        const tar = join(staging, ".snapshot.tar");
        gitOk(checkout, ["archive", "--format=tar", "-o", tar, commit]);
        const unpacked = run(["tar", "-xf", tar, "-C", staging]);
        if (unpacked.code !== 0) throw new ToliError(`tar -xf failed: ${(unpacked.stderr || unpacked.stdout).trim()}`);
        rmSync(tar);
        writeJsonAtomic(join(staging, RUNTIME_MARKER), {
            checkout: realpathSync(checkout),
            commit,
            syncedAt: new Date().toISOString(),
        });
        const probe = run([process.execPath, join(staging, "bin", "toli"), "self", "status", "--json"], {
            cwd: checkout,
            env: { TOLI_ROOT: undefined, TOLI_DEV: undefined },
            timeoutMs: LOAD_TIMEOUT_MS,
        });
        const served = probe.code === 0 ? servedRoot(probe.stdout) : null;
        if (served !== realpathSync(checkout))
            throw new ToliError(
                `the snapshot of ${commit.slice(0, 12)} does not run (${probe.code === 0 ? `it serves ${served ?? "no checkout"}` : `exit ${probe.code}`}); ` +
                    `the live session keeps its current runtime. Fix the commit, run just check, then bin/toli self sync.\n` +
                    `${probe.stdout}${probe.stderr}`.trimEnd().split("\n").slice(-TAIL_LINES).join("\n"),
            );
        return staging;
    } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
    }
}

function servedRoot(stdout: string): string | null {
    try {
        const parsed: unknown = JSON.parse(stdout);
        const root = isJsonObject(parsed) ? parsed.root : undefined;
        return typeof root === "string" && existsSync(root) ? realpathSync(root) : null;
    } catch {
        return null;
    }
}

/** Remove all but the newest KEEP snapshots of `store` (never `active`) and leftover staging directories. */
function prune(store: string, active: string): void {
    const snapshots = readdirSync(store)
        .map((name) => join(store, name))
        .filter((dir) => statSync(dir).isDirectory())
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    let kept = 0;
    for (const dir of snapshots) {
        const staging = basename(dir).startsWith(".");
        if (!staging && (dir === active || kept < KEEP)) {
            kept += 1;
            continue;
        }
        // A staging directory younger than the load timeout may belong to a concurrent sync.
        if (staging && Date.now() - statSync(dir).mtimeMs < LOAD_TIMEOUT_MS * 2) continue;
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * Install the checkout's HEAD as its runtime: build and prove the snapshot (once per commit), then repoint
 * state/runtime atomically. Refuses, leaving the active runtime in place, when the snapshot does not load.
 */
export function syncRuntime(checkout: string = paths.root()): Synced {
    const commit = gitOk(checkout, ["rev-parse", "HEAD"]);
    const store = storeFor(checkout);
    mkdirSync(store, { recursive: true });
    const target = join(store, commit.slice(0, 12));
    const previous = activeRuntime(checkout);
    if (markerCommit(target) !== commit) {
        const staging = buildSnapshot(checkout, store, commit);
        rmSync(target, { recursive: true, force: true });
        renameSync(staging, target);
    }
    writeTextAtomic(paths.runtimePointer(checkout), `${target}\n`);
    prune(store, target);
    return { runtime: target, commit, previous, changed: previous !== target };
}

/** Stop using a runtime: bin/toli runs the working tree again. The snapshots stay until the next sync prunes them. */
export function removeRuntimePointer(checkout: string = paths.root()): void {
    rmSync(paths.runtimePointer(checkout), { force: true });
}

/** One line for `self status` and doctor: what bin/toli runs and what to do about it. */
export function describeRuntime(status: RuntimeStatus): string {
    const head = status.head.slice(0, 12);
    switch (status.state) {
        case "none":
            return `no installed runtime: bin/toli runs the working tree of ${status.root} (bin/toli self sync installs one)`;
        case "missing":
            return `state/runtime names ${status.runtime}, which is gone: bin/toli runs the working tree (bin/toli self sync)`;
        case "stale":
            return `installed ${status.commit?.slice(0, 12)} is behind HEAD ${head}: bin/toli self sync (${status.runtime})`;
        case "current":
            return `${head} (HEAD) installed at ${status.runtime}`;
    }
}

/** `toli self sync [--json]` | `self status [--json]`. */
export function runtimeCommand(argv: string[]): void {
    const [sub, ...rest] = argv;
    const args = new Args(rest, { booleans: ["json"] });
    args.maxPositional(0);
    if (sub === "status") {
        const status = runtimeStatus();
        if (args.bool("json")) printJson(status);
        else out(describeRuntime(status));
    } else if (sub === "sync") {
        const synced = syncRuntime();
        if (args.bool("json")) printJson(synced);
        else
            out(
                synced.changed
                    ? `runtime ${synced.commit.slice(0, 12)} installed at ${synced.runtime}; the live session runs it from the next bin/toli call`
                    : `runtime ${synced.commit.slice(0, 12)} already installed at ${synced.runtime}`,
            );
    } else throw new ToliError("usage: toli self sync | status [--json]");
}
