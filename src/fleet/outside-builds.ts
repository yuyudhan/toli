// Heavy builds running outside the heavy-build slots (src/fleet/build-slots.ts): rustc compiling a crate that no slot
// holder started. toli's cargo shim and rustc wrapper reach only a cargo whose environment toli set, so a cargo run
// with a reset environment (`env -i`, a script that rebuilds PATH and unsets RUSTC_WRAPPER), by a process toli never
// started (the user's terminal, another harness, a lead's native subagent without the build variables) or in a docker
// container's own environment compiles at full width beside the slots. A waiter counts each such build as a busy slot
// (src/fleet/build-queue.ts), so it waits instead of piling a second build on top, and `bin/toli resources` lists them.
// A build is the outermost cargo above its compiling rustc processes (its own process when no cargo is above it). It is
// inside a slot when a slot holder (the pid in a slot's lock file, or a cargo whose rustc-wrapper holder holds a slot,
// `cargo-<pid>.held`) is among its ancestors. Stopped processes (SIGSTOP) and processes in a frozen cgroup (a `docker
// pause`d container, src/fleet/stack-pause.ts) use no CPU and are never counted, or a stack a build paused would hold
// up the next build. The process table is `ps`'s; `TOLI_PROCESS_TABLE` names a file in its format instead (tests).
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { paths } from "../core/paths.ts";
import { pidAlive, run } from "../core/util.ts";
import { procLink } from "./disk-proc.ts";
import { procFile } from "./resources.ts";

/** A heavy build outside the slots: its outermost process, command line, directory (Linux) and crates compiling now. */
export type OutsideBuild = { pid: number; command: string; cwd: string | null; crates: string[] };

type Proc = { pid: number; ppid: number; stat: string; argv: string[] };

/** The compilers whose crate compilations make a build heavy (rustc, clippy's driver, rustdoc). */
const COMPILERS: Readonly<Record<string, true>> = { rustc: true, "clippy-driver": true, rustdoc: true };
/** cargo itself or a cargo subcommand binary (cargo-nextest, cargo-clippy, cargo-llvm-cov, ...). */
const CARGO = /^cargo(-[\w-]+)?$/;
/** The crate name cargo's target-info probe compiles nothing under. */
const PROBE_CRATE = "___";
/** How many ancestors a walk follows at most, against a pid loop in a table read while processes come and go. */
const MAX_DEPTH = 128;

/** Where a cargo's slot holder says it holds the slot: `<holder pid> <slot>` (read by bin/shims/toli-rustc-wrapper). */
export const heldFile = (cargoPid: number): string => join(paths.buildSlotsDir(), `cargo-${cargoPid}.held`);
const HELD = /^cargo-(\d+)\.held$/;

/** Whether `cargoPid`'s slot holder is alive and says it holds the slot. */
export function holderHolds(cargoPid: number): boolean {
    let text: string;
    try {
        text = readFileSync(heldFile(cargoPid), "utf8");
    } catch {
        return false;
    }
    return pidAlive(Number(text.split(" ")[0]));
}

/** Every cargo whose rustc-wrapper holder holds a slot for it now (src/fleet/cargo-slot.ts). */
export function heldCargoPids(): number[] {
    let names: string[];
    try {
        names = readdirSync(paths.buildSlotsDir());
    } catch {
        return [];
    }
    return names.flatMap((name) => {
        const match = HELD.exec(name);
        const pid = match === null ? 0 : Number(match[1]);
        return pid > 0 && holderHolds(pid) ? [pid] : [];
    });
}

/** The machine's processes, by pid: `ps -A` (every user's, a container's too on Linux), or `TOLI_PROCESS_TABLE`. */
export function processTable(): Map<number, Proc> {
    const file = process.env.TOLI_PROCESS_TABLE;
    let text = "";
    if (file !== undefined) {
        try {
            text = readFileSync(file, "utf8");
        } catch {
            text = ""; // No table written: no processes.
        }
    } else {
        const result = run(["ps", "-A", "-ww", "-o", "pid=,ppid=,stat=,args="], { timeoutMs: 5000 });
        text = result.code === 0 ? result.stdout : "";
    }
    const table = new Map<number, Proc>();
    for (const line of text.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (match === null) continue;
        const pid = Number(match[1]);
        table.set(pid, {
            pid,
            ppid: Number(match[2]),
            stat: match[3] as string,
            argv: (match[4] as string).split(/\s+/),
        });
    }
    return table;
}

/** Whether a command line's program, or the script an interpreter or wrapper runs (its second word), passes `test`. */
function programIs(argv: string[], test: (name: string) => boolean): boolean {
    return argv.slice(0, 2).some((word) => test(basename(word)));
}

/** The crate a compiler process compiles, or null for any other process and for cargo's target-info probe. */
function compiledCrate(proc: Proc): string | null {
    if (!programIs(proc.argv, (name) => Object.hasOwn(COMPILERS, name))) return null;
    const at = proc.argv.indexOf("--crate-name");
    const crate = at < 0 ? undefined : proc.argv[at + 1];
    return crate === undefined || crate === PROBE_CRATE ? null : crate;
}

/** `pid` and its ancestors, nearest first. */
function lineage(table: Map<number, Proc>, pid: number): number[] {
    const chain: number[] = [];
    let current = table.get(pid);
    while (current !== undefined && chain.length < MAX_DEPTH && !chain.includes(current.pid)) {
        chain.push(current.pid);
        current = current.ppid > 1 ? table.get(current.ppid) : undefined;
    }
    return chain;
}

/** Whether a process's cgroup is frozen (Linux: cgroup v2 `cgroup.events`, or v1's freezer), as `docker pause` does. */
function frozen(pid: number): boolean {
    let text: string;
    try {
        text = readFileSync(procFile(`${pid}/cgroup`), "utf8");
    } catch {
        return false; // Gone, not Linux, or not ours to read.
    }
    const root = process.env.TOLI_CGROUP_DIR ?? "/sys/fs/cgroup";
    for (const line of text.split("\n")) {
        const [, controllers, ...rest] = line.split(":");
        if (controllers === undefined) continue;
        const path = rest.join(":");
        try {
            if (controllers === "" && /^frozen 1$/m.test(readFileSync(join(root, path, "cgroup.events"), "utf8")))
                return true;
            if (
                controllers.split(",").includes("freezer") &&
                readFileSync(join(root, "freezer", path, "freezer.state"), "utf8").trim() === "FROZEN"
            )
                return true;
        } catch {
            // No such cgroup file: not frozen through it.
        }
    }
    return false;
}

/**
 * The heavy builds running now outside every slot: those with a compiling rustc whose lineage holds none of `inside`
 * (slot holders and held cargos), and that are not `waiter`'s own ancestors (a build waiting for a slot from inside an
 * outside build, such as its build script's cargo, must never wait for the build it runs in).
 */
export function outsideBuilds(inside: readonly number[], waiter: number | null = null): OutsideBuild[] {
    const table = processTable();
    const insideSet = new Set(inside);
    const waiterLine = new Set(waiter === null ? [] : lineage(table, waiter));
    const builds = new Map<number, OutsideBuild>();
    for (const proc of table.values()) {
        const crate = compiledCrate(proc);
        if (crate === null || /^[TtZ]/.test(proc.stat)) continue;
        const chain = lineage(table, proc.pid);
        if (chain.some((pid) => insideSet.has(pid))) continue;
        const cargos = chain
            .slice(1)
            .filter((pid) => programIs(table.get(pid)?.argv ?? [], (name) => CARGO.test(name)));
        const root = cargos.at(-1) ?? proc.pid;
        if (waiterLine.has(root) || frozen(proc.pid)) continue;
        const build = builds.get(root) ?? {
            pid: root,
            command: (table.get(root)?.argv ?? []).join(" "),
            cwd: procLink(String(root), "cwd"),
            crates: [],
        };
        if (!build.crates.includes(crate)) build.crates.push(crate);
        builds.set(root, build);
    }
    return [...builds.values()].sort((a, b) => a.pid - b.pid);
}

/** One line naming an outside build for a waiter's message and `bin/toli resources`. */
export function outsideBuildText(build: OutsideBuild): string {
    const where = build.cwd === null ? "" : ` in ${build.cwd}`;
    return `pid ${build.pid} \`${build.command}\`${where} compiling ${build.crates.join(", ")}`;
}
