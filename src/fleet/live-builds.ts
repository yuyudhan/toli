// The builds running on this machine right now, for the disk keeper (src/fleet/disk.ts): a target a live build
// compiles into is never deleted while free disk is over the emergency level, and under it goes only after every
// idle target, with the build it breaks named in logs/disk.log. A live build is a running cargo or rustc (where it
// works, and the CARGO_TARGET_DIR in its environment) or a held heavy-build slot (where its holder said it builds,
// build-queue.ts): a gate whose `just` recipe builds into a target elsewhere, or that sits between two cargo runs,
// still holds its slot.
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { platform, run } from "../core/util.ts";
import { busySlots } from "./build-queue.ts";
import { type ProcBuild, procBuilds } from "./disk-proc.ts";
import { real, within } from "./disk-scan.ts";

/** One live build: who it is (for the keeper's lines), where it works, and the target dir it was told to use. */
export type LiveBuild = { label: string; cwd: string | null; targetDir: string | null };

/** Every live build: the running cargo and rustc processes, then every held heavy-build slot. */
export function liveBuilds(): LiveBuild[] {
    const running = platform() === "linux" ? procBuilds() : psBuilds();
    const builds: LiveBuild[] = running.map((build) => ({
        label: `${build.name} (pid ${build.pid})`,
        cwd: build.cwd,
        targetDir: targetDirOf(build),
    }));
    for (const slot of busySlots())
        builds.push({
            label: `heavy-build slot ${slot.slot} (pid ${slot.pid})`,
            cwd: slot.cwd,
            targetDir: slot.targetDir,
        });
    return builds;
}

/** A process's CARGO_TARGET_DIR as cargo reads it (relative to its working directory); null when unset or unknown. */
function targetDirOf(build: ProcBuild): string | null {
    if (build.targetDir === null || isAbsolute(build.targetDir)) return build.targetDir;
    return build.cwd === null ? null : resolve(build.cwd, build.targetDir);
}

/**
 * Why a live build uses `target`, naming it, or null when none does. A build told a CARGO_TARGET_DIR uses that folder
 * only; any other builds into the target of the workspace it works in (the folder holding `target`), or above it, as
 * `just` and a gate run cargo from a checkout's top.
 */
export function liveBuildUse(target: string, builds: LiveBuild[]): string | null {
    const dir = real(target);
    const workspace = dirname(dir);
    const roots = new Set(["/", real(homedir())]);
    for (const build of builds) {
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
        builds.push({ pid, name, cwd: null, targetDir });
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
