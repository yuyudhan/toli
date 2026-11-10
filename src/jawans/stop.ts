// Stopping a run's processes for good. A stall or time limit sends SIGTERM to the run's root process, every
// descendant and, when the root leads its own process group (spawned detached), every member of that group; a process
// that ignores SIGTERM (or a shell that survives it) gets SIGKILL after the grace, and the stop resolves only once none
// of them is left.
//
// Only processes that descend from the run are ever signalled. A process is known by its pid and start time, so a pid
// the system hands to an unrelated process once the run's one is gone is never taken for it: the root counts only if
// it started by the time it was spawned, a process found by an earlier look only while its start time still matches,
// and the root's process group only while the root or a matching earlier member still is in it (a group id cannot be
// reused while the group has members). Children of those are found through their parent pid on every look, so a
// child forked during the grace is stopped too, and one orphaned since an earlier look is still known by identity.
import { run } from "../core/util.ts";
import { parseCpuTime } from "./progress.ts";

/** After SIGTERM, how long a stopped harness (omp saving its session) gets before SIGKILL. */
export const HARNESS_STOP_GRACE_MS = 30_000;
/** How long SIGKILL'd processes get to disappear before the stop reports survivors. */
const KILL_WAIT_MS = 5_000;
const POLL_MS = 100;
const PS_TIMEOUT_MS = 20_000;
/** Start times come from `ps` elapsed time in whole seconds: two readings of one process differ by under this. */
const SAME_START_MS = 2_000;

/** The run's root process: its pid and when it was spawned (taken right after spawn returned). */
export type StopRoot = { pid: number; spawnedAtMs: number };

/** Live processes a stop targets: pid to start time (ms since the epoch). */
export type Identities = Map<number, number>;

type Row = { ppid: number; pgid: number; zombie: boolean; startMs: number };

/** `ps -A -o pid=,ppid=,pgid=,stat=,etime=` output taken at `nowMs`, by pid. */
function parseRows(psOutput: string, nowMs: number): Map<number, Row> {
    const rows = new Map<number, Row>();
    for (const line of psOutput.split("\n")) {
        const [pid, ppid, pgid, stat, etime] = line.trim().split(/\s+/);
        if (pid === undefined || ppid === undefined || pgid === undefined || stat === undefined) continue;
        const elapsed = parseCpuTime(etime ?? "");
        if (elapsed === null) continue;
        rows.set(Number(pid), {
            ppid: Number(ppid),
            pgid: Number(pgid),
            zombie: stat.startsWith("Z"),
            startMs: nowMs - elapsed * 1000,
        });
    }
    return rows;
}

/**
 * The live (not zombie) processes a stop of `root` must end, from `ps -A -o pid=,ppid=,pgid=,stat=,etime=` output
 * taken at `nowMs`: the root (if it is still the spawned one), every process of `known` whose start time still
 * matches, the root's process group while it provably is the run's, and every descendant of those.
 */
export function stopTargets(psOutput: string, nowMs: number, root: StopRoot, known: Identities): Identities {
    const rows = parseRows(psOutput, nowMs);
    const same = (pid: number, startMs: number): boolean => {
        const row = rows.get(pid);
        return row !== undefined && Math.abs(row.startMs - startMs) < SAME_START_MS;
    };
    const seeds: number[] = [];
    const rootRow = rows.get(root.pid);
    const rootIsRun = rootRow !== undefined && rootRow.startMs < root.spawnedAtMs + SAME_START_MS;
    if (rootIsRun) seeds.push(root.pid);
    for (const [pid, startMs] of known) if (same(pid, startMs)) seeds.push(pid);
    const groupIsRun = rootIsRun || seeds.some((pid) => rows.get(pid)?.pgid === root.pid);
    const children = new Map<number, number[]>();
    for (const [pid, row] of rows) {
        if (groupIsRun && row.pgid === root.pid) seeds.push(pid);
        const siblings = children.get(row.ppid);
        if (siblings === undefined) children.set(row.ppid, [pid]);
        else siblings.push(pid);
    }
    const found: Identities = new Map();
    const stack = seeds;
    while (stack.length > 0) {
        const pid = stack.pop() as number;
        const row = rows.get(pid);
        if (row === undefined || found.has(pid)) continue;
        found.set(pid, row.startMs);
        stack.push(...(children.get(pid) ?? []));
    }
    for (const [pid] of found) if (rows.get(pid)?.zombie) found.delete(pid);
    return found;
}

/** One look: the live targets' pids, their identities added to `known`; null when `ps` failed. */
function look(root: StopRoot, known: Identities): number[] | null {
    const ps = run(["ps", "-A", "-o", "pid=,ppid=,pgid=,stat=,etime="], { timeoutMs: PS_TIMEOUT_MS });
    if (ps.code !== 0) return null;
    const targets = stopTargets(ps.stdout, Date.now(), root, known);
    for (const [pid, startMs] of targets) known.set(pid, startMs);
    return [...targets.keys()];
}

function signalAll(pids: number[], signal: NodeJS.Signals): void {
    for (const pid of pids) {
        try {
            process.kill(pid, signal);
        } catch {
            // Gone since the look.
        }
    }
}

/** Look until no target is left (true) or `ms` passed (false), signalling every target found with `signal`. */
async function waitGone(root: StopRoot, known: Identities, ms: number, signal: NodeJS.Signals): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
        const targets = look(root, known);
        if (targets?.length === 0) return true;
        if (Date.now() >= deadline) return false;
        // A failed look signals nothing: a pid not just seen as the run's may belong to someone else by now.
        if (targets !== null) signalAll(targets, signal);
        await Bun.sleep(POLL_MS);
    }
}

/**
 * Stop `root` and everything it started: SIGTERM, then SIGKILL to whatever is left after `graceMs`. Call it while the
 * root has not been reaped. Resolves to the pids still alive after that (empty once all are gone; the last known ones
 * when `ps` kept failing).
 */
export async function stopTree(root: StopRoot, graceMs: number): Promise<number[]> {
    const known: Identities = new Map();
    // Without `ps`, only the root (not reaped yet, so still the run's) can be signalled safely.
    signalAll(look(root, known) ?? [root.pid], "SIGTERM");
    if (await waitGone(root, known, graceMs, "SIGTERM")) return [];
    if (await waitGone(root, known, KILL_WAIT_MS, "SIGKILL")) return [];
    return look(root, known) ?? [...known.keys()];
}
