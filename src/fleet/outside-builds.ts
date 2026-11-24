// Heavy builds running outside the heavy-build slots (src/fleet/build-slots.ts): rustc compiling a crate that no slot
// holder started. toli's cargo shim and rustc wrapper reach only a cargo whose environment toli set, so a cargo run
// with a reset environment (`env -i`, a script that rebuilds PATH and unsets RUSTC_WRAPPER), by a process toli never
// started (the user's terminal, another harness, a lead's native subagent without the build variables) or in a docker
// container's own environment compiles at full width beside the slots. A waiter counts each such build as a busy slot
// (src/fleet/build-queue.ts), so it waits instead of piling a second build on top, and `bin/toli resources` lists them.
// A build is the outermost cargo above its compiling rustc processes (its own process when no cargo is above it). It is
// inside a slot when a slot holder (the pid in a slot's lock file, or a cargo whose rustc-wrapper holder holds a slot,
// `cargo-<pid>.held`) is among its ancestors. A rustc a compiler daemon runs (sccache's server, which starts every
// compilation its clients ask for, outside their process trees) with no cargo above it belongs to the build whose
// client asks for that very compilation (`compileKey`: crate name and cargo's metadata hash): inside a slot when that
// client is, so a build in a slot never counts a second time as a build outside the slots, and its slot never looks
// idle while the daemon compiles for it (T2244). Stopped processes (SIGSTOP) and processes in a frozen cgroup (a
// `docker pause`d container, src/fleet/stack-pause.ts) use no CPU and are never counted, or a stack a build paused
// would hold up the next build. The process table is `ps`'s; `TOLI_PROCESS_TABLE` names a file in its format instead
// (tests).
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { paths } from "../core/paths.ts";
import { pidAlive, run } from "../core/util.ts";
import { procLink } from "./disk-proc.ts";
import { procFile } from "./resources.ts";

/** A heavy build outside the slots: its outermost process, command line, directory (Linux) and crates compiling now. */
export type OutsideBuild = { pid: number; command: string; cwd: string | null; crates: string[] };

type Proc = { pid: number; ppid: number; stat: string; argv: string[] };
/** The machine's processes by pid (`processTable`). */
export type ProcessTable = Map<number, Proc>;

/** The compilers whose crate compilations make a build heavy (rustc, clippy's driver, rustdoc). */
const COMPILERS: Readonly<Record<string, true>> = { rustc: true, "clippy-driver": true, rustdoc: true };
/** cargo itself or a cargo subcommand binary (cargo-nextest, cargo-clippy, cargo-llvm-cov, ...). */
const CARGO = /^cargo(-[\w-]+)?$/;
/** The crate name cargo's target-info probe compiles nothing under. */
const PROBE_CRATE = "___";
/** How many ancestors a walk follows at most, against a pid loop in a table read while processes come and go. */
const MAX_DEPTH = 128;
/** A process state that uses the CPU or waits on the disk: running or runnable (R), uninterruptible I/O (D; U on macOS). */
const ACTIVE_STAT = /^[RDU]/;

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

/** The slot `cargoPid`'s rustc-wrapper holder holds for it (counting from 1), or null when no live holder holds one. */
export function heldCargoSlot(cargoPid: number): number | null {
    let text: string;
    try {
        text = readFileSync(heldFile(cargoPid), "utf8");
    } catch {
        return null;
    }
    const [holder = 0, slot = 0] = text.trim().split(" ").map(Number);
    return Number.isInteger(slot) && slot > 0 && pidAlive(holder) ? slot : null;
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

/** Every cargo held by a rustc-wrapper holder, by that holder's pid (the pid its slot's lock file records). */
export function heldCargosByHolder(): Map<number, number> {
    const byHolder = new Map<number, number>();
    for (const cargo of heldCargoPids()) {
        try {
            byHolder.set(Number(readFileSync(heldFile(cargo), "utf8").split(" ")[0]), cargo);
        } catch {
            // Released since: its holder no longer holds a slot.
        }
    }
    return byHolder;
}

/** The machine's processes, by pid: `ps -A` (every user's, a container's too on Linux), or `TOLI_PROCESS_TABLE`. */
export function processTable(): ProcessTable {
    const file = process.env.TOLI_PROCESS_TABLE ?? "";
    let text = "";
    if (file !== "") {
        try {
            text = readFileSync(file, "utf8");
        } catch {
            text = ""; // No table written: no processes.
        }
    } else {
        const result = run(["ps", "-A", "-ww", "-o", "pid=,ppid=,stat=,args="], { timeoutMs: 5000 });
        text = result.code === 0 ? result.stdout : "";
    }
    const table: ProcessTable = new Map();
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

/**
 * The compilation a command line asks for: its crate name and cargo's `-C metadata` hash (empty without one), the same
 * in a compiler daemon's rustc as in the client (or the rustc wrapper) that asked for it; null when it names no crate
 * or only the target-info probe's.
 */
function compileKey(argv: string[]): string | null {
    let crate: string | undefined;
    let metadata = "";
    for (const [at, word] of argv.entries()) {
        const next = argv[at + 1] ?? "";
        if (word === "--crate-name") crate = next;
        else if (word.startsWith("--crate-name=")) crate = word.slice("--crate-name=".length);
        else if ((word === "-C" || word === "--codegen") && next.startsWith("metadata="))
            metadata = next.slice("metadata=".length);
        else if (word.startsWith("-Cmetadata=")) metadata = word.slice("-Cmetadata=".length);
    }
    return crate === undefined || crate === PROBE_CRATE ? null : `${crate} ${metadata}`;
}

/** `pid` and its ancestors, nearest first. */
function lineage(table: ProcessTable, pid: number): number[] {
    const chain: number[] = [];
    let current = table.get(pid);
    while (current !== undefined && chain.length < MAX_DEPTH && !chain.includes(current.pid)) {
        chain.push(current.pid);
        current = current.ppid > 1 ? table.get(current.ppid) : undefined;
    }
    return chain;
}

/** Whether process `pid` is `ancestor` or runs below it, in `table`. */
export function descendsFrom(table: ProcessTable, pid: number, ancestor: number): boolean {
    return lineage(table, pid).includes(ancestor);
}

/** The cargo processes above `chain`'s first process (its lineage), nearest first. */
function cargosAbove(table: ProcessTable, chain: number[]): number[] {
    return chain.slice(1).filter((pid) => programIs(table.get(pid)?.argv ?? [], (name) => CARGO.test(name)));
}

/**
 * The compilations (`compileKey`) asked for by the processes whose lineage `belongs` accepts, so a compiler daemon's
 * rustc for one of them is theirs (`daemonCompiles`).
 */
function compilesAskedBy(table: ProcessTable, belongs: (chain: number[]) => boolean): Set<string> {
    const keys = new Set<string>();
    for (const proc of table.values()) {
        const key = compileKey(proc.argv);
        if (key !== null && belongs(lineage(table, proc.pid))) keys.add(key);
    }
    return keys;
}

/** Whether compiler `proc` (lineage `chain`) is a compiler daemon's run of one of the compilations `asked`. */
function daemonCompiles(table: ProcessTable, proc: Proc, chain: number[], asked: Set<string>): boolean {
    const key = compiledCrate(proc) === null ? null : compileKey(proc.argv);
    return key !== null && asked.has(key) && cargosAbove(table, chain).length === 0;
}

/**
 * Whether one of Linux process `pid`'s threads runs now (`ACTIVE_STAT`, from `/proc/<pid>/task/<tid>/stat`). `ps`
 * shows only the main thread's state, and rustc compiles on a thread of its own while its main thread sleeps on it (so
 * do a test binary's harness, mold and lld): `Sl` while it works flat out (T2050). False where there is no /proc.
 */
function threadRunning(pid: number): boolean {
    let tids: string[];
    try {
        tids = readdirSync(procFile(`${pid}/task`));
    } catch {
        return false; // Gone, not Linux, or not ours to read.
    }
    return tids.some((tid) => {
        let text: string;
        try {
            text = readFileSync(procFile(`${pid}/task/${tid}/stat`), "utf8");
        } catch {
            return false; // The thread ended meanwhile.
        }
        // `<tid> (<comm>) <state> ...`: the name may hold spaces and parentheses, the state follows the last `)`.
        return ACTIVE_STAT.test(text.slice(text.lastIndexOf(")") + 1).trimStart());
    });
}

/**
 * Whether a process below `pid` (or `pid` itself, with `withRoot`) runs now: its state (`ACTIVE_STAT`) or one of its
 * threads' (`threadRunning`), and so does a compiler daemon's rustc for a compilation one of them asks for
 * (`daemonCompiles`). A command blocked on a lock, a socket, a pipe or a sleep does not; neither does one stopped
 * (SIGSTOP).
 */
export function treeRunning(table: ProcessTable, pid: number, withRoot: boolean): boolean {
    const below = (chain: number[]): boolean => (withRoot ? chain : chain.slice(1)).includes(pid);
    const running = (proc: Proc): boolean => ACTIVE_STAT.test(proc.stat) || threadRunning(proc.pid);
    for (const proc of table.values()) if (below(lineage(table, proc.pid)) && running(proc)) return true;
    const asked = compilesAskedBy(table, below);
    if (asked.size === 0) return false;
    for (const proc of table.values()) {
        if (daemonCompiles(table, proc, lineage(table, proc.pid), asked) && running(proc)) return true;
    }
    return false;
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
 * (slot holders and held cargos) and that no compiler daemon runs for a build inside them (`daemonCompiles`), and that
 * are not `waiter`'s own ancestors (a build waiting for a slot from inside an outside build, such as its build script's
 * cargo, must never wait for the build it runs in).
 */
export function outsideBuilds(
    inside: readonly number[],
    waiter: number | null = null,
    table: ProcessTable = processTable(),
): OutsideBuild[] {
    const insideSet = new Set(inside);
    const inSlot = (chain: number[]): boolean => chain.some((pid) => insideSet.has(pid));
    const askedInSlots = compilesAskedBy(table, inSlot);
    const waiterLine = new Set(waiter === null ? [] : lineage(table, waiter));
    const builds = new Map<number, OutsideBuild>();
    for (const proc of table.values()) {
        const crate = compiledCrate(proc);
        if (crate === null || /^[TtZ]/.test(proc.stat)) continue;
        const chain = lineage(table, proc.pid);
        if (inSlot(chain) || daemonCompiles(table, proc, chain, askedInSlots)) continue;
        const root = cargosAbove(table, chain).at(-1) ?? proc.pid;
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
