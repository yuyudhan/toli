// The builds running on this machine right now, for the disk keeper (src/fleet/disk.ts): a target a live build
// compiles into is never deleted, at any step. A live build is a running cargo or rustc (where it works, the
// CARGO_TARGET_DIR in its environment, and the paths in its arguments), a held heavy-build slot (where its holder said
// it builds, build-queue.ts), or a running gate (`gate run`, `push --gate`, the pre-push hook: its checkout,
// gate-record.ts): a gate whose `just` recipe builds into a target elsewhere, or that sits between two cargo runs,
// still holds its slot and its record.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { platform, run } from "../core/util.ts";
import { runningGates } from "../forge/gate-record.ts";
import { busySlots } from "./build-queue.ts";
import { type ProcBuild, procBuilds } from "./disk-proc.ts";
import { real, within } from "./disk-scan.ts";

/**
 * One live build: who it is (for the keeper's lines), where it works, the target dir it was told to use, and the
 * absolute paths among its arguments (`--target-dir`, `--manifest-path`, rustc's `--out-dir`).
 */
export type LiveBuild = { label: string; cwd: string | null; targetDir: string | null; args: readonly string[] };

/** Every live build: the running cargo and rustc processes, every held heavy-build slot, then every running gate. */
export function liveBuilds(): LiveBuild[] {
    const running = platform() === "linux" ? procBuilds() : psBuilds();
    const builds: LiveBuild[] = running.map((build) => ({
        label: `${build.name} (pid ${build.pid})`,
        cwd: build.cwd,
        targetDir: targetDirOf(build),
        args: pathArgs(build.args, build.cwd),
    }));
    for (const slot of busySlots())
        builds.push({
            label: `heavy-build slot ${slot.slot} (pid ${slot.pid})`,
            cwd: slot.cwd,
            targetDir: slot.targetDir,
            args: [],
        });
    for (const gate of runningGates())
        builds.push({ label: `gate of ${gate.project} (pid ${gate.pid})`, cwd: gate.dir, targetDir: null, args: [] });
    return builds;
}

/** A process's CARGO_TARGET_DIR as cargo reads it (relative to its working directory); null when unset or unknown. */
function targetDirOf(build: ProcBuild): string | null {
    if (build.targetDir === null || isAbsolute(build.targetDir)) return build.targetDir;
    return build.cwd === null ? null : resolve(build.cwd, build.targetDir);
}

/**
 * The paths among a build's arguments, absolute: each argument, or the value after `=` of one like `--out-dir=<dir>` or
 * rustc's `-L dependency=<dir>`, that is a path (absolute, or relative with a separator when the working directory is
 * known). `NAME=value` words, the environment `ps -E` appends on macOS, are not arguments.
 */
function pathArgs(args: readonly string[], cwd: string | null): string[] {
    const found: string[] = [];
    for (const arg of args) {
        if (/^[A-Z_][A-Z0-9_]*=/.test(arg)) continue;
        const value = arg.slice(arg.indexOf("=") + 1);
        if (isAbsolute(value)) found.push(value);
        else if (cwd !== null && !value.startsWith("-") && value.includes("/")) found.push(resolve(cwd, value));
    }
    return found;
}

/**
 * Why a live build uses `target`, naming it, or null when none does. A build told a CARGO_TARGET_DIR uses that folder
 * only; any other builds into the target of the workspace it works in (the folder holding `target`), or above it, as
 * `just` and a gate run cargo from a checkout's top. Either way an argument naming a path under `target`, or the
 * workspace's Cargo.toml (`--manifest-path` from elsewhere), uses it too.
 */
export function liveBuildUse(target: string, builds: readonly LiveBuild[]): string | null {
    const dir = real(target);
    const workspace = dirname(dir);
    const manifest = join(workspace, "Cargo.toml");
    const roots = new Set(["/", real(homedir())]);
    for (const build of builds) {
        const arg = build.args.find((path) => within(real(path), dir) || real(path) === manifest);
        if (arg !== undefined) return `${build.label} builds with ${arg}`;
        if (build.targetDir !== null) {
            if (within(real(build.targetDir), dir))
                return `${build.label} builds into it (CARGO_TARGET_DIR ${build.targetDir})`;
            continue;
        }
        if (build.cwd === null) continue;
        const cwd = real(build.cwd);
        if (within(cwd, workspace) || (!roots.has(cwd) && within(workspace, cwd)))
            return `${build.label} builds in ${cwd}`;
    }
    return null;
}

/** Each of `targets` still on disk that a live build uses, with why (the disk keeper's `left in use`). */
export function targetsInUse(targets: readonly string[]): { path: string; reason: string }[] {
    const live = liveBuilds();
    return targets.flatMap((path) => {
        const reason = existsSync(path) ? liveBuildUse(path, live) : null;
        return reason === null ? [] : [{ path, reason }];
    });
}

/**
 * macOS: this account's cargo and rustc processes from `ps -E` (arguments, then the environment), their working
 * directories from lsof. A CARGO_TARGET_DIR holding a space reads only up to it.
 */
function psBuilds(): ProcBuild[] {
    const listed = run(["ps", "-axww", "-E", "-o", "pid=,uid=,args="], { timeoutMs: 30_000 });
    if (listed.code !== 0) return [];
    const uid = String(process.getuid?.() ?? -1);
    const me = String(process.pid);
    const builds: ProcBuild[] = [];
    for (const line of listed.stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)(.*)$/.exec(line);
        const [, pid = "", owner = "", program = "", rest = ""] = match ?? [];
        const name = basename(program);
        if (match === null || owner !== uid || pid === me || !(name.startsWith("cargo") || name === "rustc")) continue;
        const targetDir = /(?:^|\s)CARGO_TARGET_DIR=(\S+)/.exec(rest)?.[1] ?? null;
        builds.push({ pid, name, cwd: null, targetDir, args: rest.split(/\s+/).filter(Boolean) });
    }
    if (builds.length === 0) return builds;
    const pids = builds.map((build) => build.pid).join(",");
    const cwds = run(["lsof", "-a", "-d", "cwd", "-w", "-Fpn", "-p", pids], { timeoutMs: 60_000 });
    let pid = "";
    for (const line of cwds.stdout.split("\n")) {
        if (line.startsWith("p")) pid = line.slice(1);
        else if (line.startsWith("n")) {
            const build = builds.find((candidate) => candidate.pid === pid);
            if (build !== undefined) build.cwd = line.slice(1);
        }
    }
    return builds;
}
