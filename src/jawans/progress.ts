// Stall detection for agent runs. A run has no wall-clock limit by default; it counts as stuck only when it shows no
// progress for capacity.stallMinutes (default 30): its output log did not grow, its harness session (where omp writes
// every message and tool call) did not change, the files of its working tree did not change, and its process tree
// burned almost no CPU. A long build or test a run waits on keeps it alive through its CPU use.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { run } from "../core/util.ts";

/** CPU seconds a run's process tree must burn since the last progress to count as progress by itself. */
export const CPU_PROGRESS_SECONDS = 10;
/** Deepest directory level under a session dir that is checked for changes (subagent sessions sit below it). */
const SESSION_DEPTH = 4;
const PROBE_TIMEOUT_MS = 20_000;

export type ProgressSources = {
    /** Root of the run's process tree; null before it started. */
    pid: number | null;
    /** The run's output log; null when its output is only captured in memory (scheduled jobs). */
    logPath: string | null;
    /** The harness's session directory, when toli knows it (omp's `--session-dir`). */
    sessionDir: string | null;
    cwd: string;
};

/** One look at a run: `marks` changes whenever output, session or files change; CPU is summed over its tree. */
export type Probe = { marks: string; cpuSeconds: number };

/** `ps` TIME: `[[dd-]hh:]mm:ss[.cc]` (Linux, macOS); null when unparseable. */
export function parseCpuTime(text: string): number | null {
    const match = /^(?:(\d+)-)?(\d+(?:\.\d+)?(?::\d+(?:\.\d+)?){0,2})$/.exec(text.trim());
    if (!match) return null;
    const days = Number(match[1] ?? "0");
    const parts = (match[2] ?? "").split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return null;
    const seconds = parts.reduce((total, part) => total * 60 + part, 0);
    return days * 86_400 + seconds;
}

/** CPU seconds used by `root` and every live descendant, from `ps -A -o pid=,ppid=,time=` output. */
export function treeCpuSeconds(psOutput: string, root: number): number {
    const children = new Map<number, number[]>();
    const cpu = new Map<number, number>();
    for (const line of psOutput.split("\n")) {
        const [pid, ppid, time] = line.trim().split(/\s+/);
        const seconds = parseCpuTime(time ?? "");
        if (pid === undefined || ppid === undefined || seconds === null) continue;
        cpu.set(Number(pid), seconds);
        const siblings = children.get(Number(ppid)) ?? [];
        siblings.push(Number(pid));
        children.set(Number(ppid), siblings);
    }
    let total = 0;
    const seen = new Set<number>();
    const stack = [root];
    while (stack.length > 0) {
        const pid = stack.pop() as number;
        if (seen.has(pid)) continue;
        seen.add(pid);
        total += cpu.get(pid) ?? 0;
        stack.push(...(children.get(pid) ?? []));
    }
    return total;
}

/** Total size and newest mtime of the files under `dir`, as one string; empty when it does not exist. */
function dirMark(dir: string, depth = 0): string {
    if (!existsSync(dir)) return "";
    let size = 0;
    let newest = 0;
    const walk = (path: string, level: number): void => {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
            const full = join(path, entry.name);
            if (entry.isDirectory()) {
                if (level < SESSION_DEPTH) walk(full, level + 1);
                continue;
            }
            try {
                const stat = statSync(full);
                size += stat.size;
                newest = Math.max(newest, stat.mtimeMs);
            } catch {
                // Removed between the listing and the stat: the next probe sees the change.
            }
        }
    };
    walk(dir, depth);
    return `${size}:${newest}`;
}

/** The working tree's state: HEAD plus `git status`, hashed; empty outside a git repository. */
function treeMark(cwd: string): string {
    const status = run(["git", "-C", cwd, "status", "--porcelain=v1", "-z"], { timeoutMs: PROBE_TIMEOUT_MS });
    if (status.code !== 0) return "";
    const head = run(["git", "-C", cwd, "rev-parse", "-q", "--verify", "HEAD"], { timeoutMs: PROBE_TIMEOUT_MS });
    return Bun.hash(`${head.stdout}\0${status.stdout}`).toString(16);
}

/** Look at the run's output, session, working tree and CPU now. */
export function probeProgress(sources: ProgressSources): Probe {
    const logSize = sources.logPath !== null && existsSync(sources.logPath) ? statSync(sources.logPath).size : 0;
    const session = sources.sessionDir === null ? "" : dirMark(sources.sessionDir);
    let cpuSeconds = 0;
    if (sources.pid !== null) {
        const ps = run(["ps", "-A", "-o", "pid=,ppid=,time="], { timeoutMs: PROBE_TIMEOUT_MS });
        if (ps.code === 0) cpuSeconds = treeCpuSeconds(ps.stdout, sources.pid);
    }
    return { marks: `${logSize}|${session}|${treeMark(sources.cwd)}`, cpuSeconds };
}

/** Decides from successive probes when a run has made no progress for `stallMs`. */
export class StallWatch {
    private marks: string | null = null;
    private cpuAtProgress = 0;
    private lastProgressMs: number;

    constructor(
        private readonly stallMs: number,
        startMs: number,
    ) {
        this.lastProgressMs = startMs;
    }

    /** Feed one probe taken at `atMs`; true once nothing moved for the stall time. */
    observe(probe: Probe, atMs: number): boolean {
        const cpuMoved =
            probe.cpuSeconds - this.cpuAtProgress >= CPU_PROGRESS_SECONDS || probe.cpuSeconds < this.cpuAtProgress;
        if (this.marks === null || probe.marks !== this.marks || cpuMoved) {
            this.marks = probe.marks;
            this.cpuAtProgress = probe.cpuSeconds;
            this.lastProgressMs = atMs;
            return false;
        }
        return atMs - this.lastProgressMs >= this.stallMs;
    }
}

/** How often a stall watch probes: a quarter of the stall time, between 50 ms and a minute. */
export function probeIntervalMs(stallMs: number): number {
    return Math.min(60_000, Math.max(50, Math.floor(stallMs / 4)));
}

/**
 * Probe `sources()` until stopped; calls `onStall` once when the run made no progress for `stallMs`. Returns the stop
 * function. `sources` is read on every probe, so a pid learned after the start is picked up.
 */
export function watchStall(sources: () => ProgressSources, stallMs: number, onStall: () => void): () => void {
    const watch = new StallWatch(stallMs, Date.now());
    let fired = false;
    const timer = setInterval(() => {
        if (fired) return;
        if (watch.observe(probeProgress(sources()), Date.now())) {
            fired = true;
            clearInterval(timer);
            onStall();
        }
    }, probeIntervalMs(stallMs));
    return () => clearInterval(timer);
}

/** The words a stalled run's record and inbox item use. */
export function stallText(stallMinutes: number): string {
    return `no progress for ${stallMinutes} minutes (no output, session activity, file change or CPU use)`;
}
