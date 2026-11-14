// Who uses a cargo target right now, for the disk keeper's wipes (src/fleet/cargo-lock.ts): the process table with
// what each process runs and where, the build tools among them, and the cargo processes in a target's workspace.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, sep } from "node:path";
import { pidAlive, platform, run } from "../core/util.ts";
import { buildTool, configuredBuildTools } from "./build-tools.ts";
import { procCargoCwds, procLink } from "./disk-proc.ts";
import { allOpenFiles, type HeldFile, real, within } from "./disk-scan.ts";
import { type LiveBuild, liveBuilds } from "./live-builds.ts";
import { procFile } from "./resources.ts";

/**
 * One other process: its command line, the executable and mapped files it runs, and its working directory.
 * `uninspected`: one of this user's processes whose files could not be read (lsof left it out while it was exec'ing,
 * or the process is not dumpable); the keeper counts it as using a target only when its command line could run from it.
 */
export type ProcessUse = { pid: string; args: string; files: string[]; cwd: string | null; uninspected?: true };

/**
 * Rechecks of one of this user's processes lsof left out, `RECHECK_MS` apart (about 2 s in all), before it counts as
 * uninspected: a process caught mid-exec on a loaded machine becomes readable once its exec completes.
 */
const RECHECKS = 40;
const RECHECK_MS = 50;

/** Parse lsof `-Fpfn` output into the table's entries; returns the pids it reported. */
function readLsof(stdout: string, table: Map<string, ProcessUse>): Set<string> {
    const seen = new Set<string>();
    let current: ProcessUse | undefined;
    let fd = "";
    for (const line of stdout.split("\n")) {
        const value = line.slice(1);
        if (line.startsWith("p")) {
            current = table.get(value);
            seen.add(value);
        } else if (line.startsWith("f")) fd = value;
        else if (line.startsWith("n") && current !== undefined) {
            if (fd === "cwd") current.cwd = value;
            else current.files.push(value);
        }
    }
    return seen;
}

/**
 * Every process but this one (`ps`), with what it runs and where; null when the table cannot be read. A process of
 * this user that cannot be inspected is kept as `uninspected`, never as one that uses nothing: lsof silently leaves out
 * a process caught mid-exec (a test binary cargo just started), and under load that is common.
 */
function processTable(): ProcessUse[] | null {
    const listed = run(["ps", "-axww", "-o", "pid=,uid=,stat=,args="], { timeoutMs: 30_000 });
    if (listed.code !== 0) return null;
    const me = String(process.pid);
    const uid = String(process.getuid?.() ?? -1);
    const table = new Map<string, ProcessUse>();
    const mine: string[] = [];
    for (const line of listed.stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        const pid = match?.[1];
        if (pid === undefined || pid === me) continue;
        table.set(pid, { pid, args: match?.[4] ?? "", files: [], cwd: null });
        // Zombies hold no files; other users' processes are not ours to read.
        if (match?.[2] === uid && !(match?.[3] ?? "").startsWith("Z")) mine.push(pid);
    }
    if (platform() === "linux") {
        for (const entry of table.values()) {
            const exe = procLink(entry.pid, "exe");
            if (exe !== null) entry.files.push(exe);
            entry.cwd = procLink(entry.pid, "cwd");
        }
        for (const pid of mine) {
            const entry = table.get(pid);
            if (entry !== undefined && entry.files.length === 0 && existsSync(procFile(pid))) entry.uninspected = true;
        }
        return [...table.values()];
    }
    // macOS: the executable and every mapped file (`txt`) plus the working directory of each process, in one pass.
    const files = run(["lsof", "-a", "-d", "cwd,txt", "-w", "-Fpfn"], { timeoutMs: 60_000 });
    if (files.stdout === "" && files.code !== 0) return null;
    const seen = readLsof(files.stdout, table);
    for (const pid of mine) {
        if (seen.has(pid)) continue;
        const entry = table.get(pid);
        if (entry === undefined) continue;
        let inspected = false;
        for (let attempt = 0; attempt < RECHECKS && !inspected; attempt++) {
            if (attempt > 0) Bun.sleepSync(RECHECK_MS);
            const one = run(["lsof", "-a", "-p", pid, "-d", "cwd,txt", "-w", "-Fpfn"], { timeoutMs: 10_000 });
            inspected = readLsof(one.stdout, table).has(pid) || !pidAlive(Number(pid));
        }
        if (inspected) continue;
        entry.uninspected = true;
        // lsof still cannot read it, but ps shows what it exec'd: its program path tells which target it runs from.
        const args = run(["ps", "-o", "args=", "-p", pid], { timeoutMs: 10_000 }).stdout.trim();
        if (args !== "") entry.args = args;
        const program = args.split(/\s+/)[0] ?? "";
        if (program.startsWith("/")) entry.files.push(real(program));
    }
    return [...table.values()];
}

/**
 * Whether a process that could not be inspected may run from a target: its program is a relative path (it runs from a
 * working directory nobody could see), or its command line names the target or its workspace. Any other process, such
 * as a service manager that is not dumpable, says nothing about the target; a build tool among them is already kept
 * by targetUse because its working directory cannot be seen.
 */
function mayRunFrom(entry: ProcessUse, places: string[]): boolean {
    const program = entry.args.trim().split(/\s+/)[0] ?? "";
    if (program.includes(sep) && !program.startsWith(sep)) return true;
    return places.some((place) => entry.args.includes(place));
}

/**
 * Why a process uses `target` right now, or null when none does: one runs an executable or maps a file under it (a
 * test binary cargo started after releasing its locks), works inside the workspace that owns it (the folder holding
 * `target/`), or is a build tool running in, above or on that workspace. An unreadable process table is a reason too,
 * and so is a process that could not be inspected whose command line could run from the target (mayRunFrom).
 */
export function targetUse(
    target: string,
    processes: () => ProcessUse[] | null = processTable,
    buildTools: () => string[] = configuredBuildTools,
): string | null {
    const dir = real(target);
    const workspaces = [...new Set([dirname(dir), dirname(target)])];
    const table = processes();
    if (table === null) return "cannot read the process table to see who uses it";
    const extra = buildTools();
    const roots = new Set(["/", real(homedir())]);
    for (const entry of table) {
        const file = entry.files.find((path) => within(path, dir));
        if (file !== undefined) return `process ${entry.pid} runs ${file}`;
        const cwd = entry.cwd;
        if (cwd !== null && workspaces.some((workspace) => within(cwd, workspace)))
            return `process ${entry.pid} runs in ${cwd}`;
        const tool = buildTool(entry.args, extra);
        if (tool === null) continue;
        if (cwd === null) return `${tool} (pid ${entry.pid}) runs where it cannot be seen`;
        const above = !roots.has(cwd) && workspaces.some((workspace) => within(workspace, cwd));
        if (above || workspaces.some((workspace) => entry.args.includes(workspace)))
            return `${tool} (pid ${entry.pid}) builds in ${workspaces[0]}`;
    }
    // Only when nothing seen uses it: a process that could not be inspected might be running from it.
    const places = [...new Set([dir, target, ...workspaces])];
    const unseen = table.find((entry) => entry.uninspected === true && mayRunFrom(entry, places));
    return unseen === undefined ? null : `process ${unseen.pid} could not be inspected and may run from it`;
}

/** The working directory of every cargo process (`cargo`, `cargo-clippy`, `cargo-nextest`, ...; `lsof -c cargo`). */
function cargoCwds(): { pid: string; cwd: string }[] {
    if (platform() === "linux") return procCargoCwds();
    const listed = run(["lsof", "-a", "-d", "cwd", "-c", "cargo", "-w", "-Fpn"], { timeoutMs: 60_000 });
    const cwds: { pid: string; cwd: string }[] = [];
    let pid = "";
    for (const line of listed.stdout.split("\n")) {
        if (line.startsWith("p")) pid = line.slice(1);
        else if (line.startsWith("n")) cwds.push({ pid, cwd: line.slice(1) });
    }
    return cwds;
}

/**
 * A cargo process whose working directory lies in `workspace`, as `cargo (pid N) runs in <dir>`, or null. `cargo test`
 * drops its build lock once compiling is done and then runs the test binaries one by one; between two of them nothing
 * in the target is open, yet cargo is about to start the next.
 */
export function cargoRunsIn(
    workspace: string,
    cargos: () => { pid: string; cwd: string }[] = cargoCwds,
): string | null {
    const found = cargos().find((cargo) => within(cargo.cwd, workspace));
    return found === undefined ? null : `cargo (pid ${found.pid}) runs in ${found.cwd}`;
}

/** What a target wipe asks the machine about who uses the target; the live machine unless a caller injects its own. */
export type UseProbes = {
    /** Every process but this one with what it runs and where; null when the table cannot be read. */
    processes: () => ProcessUse[] | null;
    /** Every file a process other than this one holds open, runs or maps. */
    openFiles: () => HeldFile[];
    /** The working directory of every cargo process. */
    cargos: () => { pid: string; cwd: string }[];
    /** The machine's own build tools (capacity.diskBuildTools), beside the generic ones. */
    buildTools: () => string[];
    /** The running builds: cargo and rustc processes and held heavy-build slots (live-builds.ts). */
    builds: () => LiveBuild[];
};

export const LIVE_PROBES: UseProbes = {
    processes: processTable,
    openFiles: allOpenFiles,
    cargos: cargoCwds,
    buildTools: configuredBuildTools,
    builds: liveBuilds,
};
