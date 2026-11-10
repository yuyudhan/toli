// Stopping a run's processes for good. A stall or time limit sends SIGTERM to the run's root process, every
// descendant and, when the root leads its own process group (spawned detached), every member of that group; a process
// that ignores SIGTERM (or a shell that survives it) gets SIGKILL after the grace, and the stop resolves only once none
// of them is left. Members found later (a child forked during the grace, one orphaned when its parent died) are
// added on every look, so nothing escapes by being reparented.
import { run } from "../core/util.ts";

/** After SIGTERM, how long a stopped harness (omp saving its session) gets before SIGKILL. */
export const HARNESS_STOP_GRACE_MS = 30_000;
/** How long SIGKILL'd processes get to disappear before the stop reports survivors. */
const KILL_WAIT_MS = 5_000;
const POLL_MS = 100;
const PS_TIMEOUT_MS = 20_000;

type Row = { ppid: number; pgid: number; zombie: boolean };

/** `ps -A -o pid=,ppid=,pgid=,stat=` output by pid. */
function parseRows(psOutput: string): Map<number, Row> {
    const rows = new Map<number, Row>();
    for (const line of psOutput.split("\n")) {
        const [pid, ppid, pgid, stat] = line.trim().split(/\s+/);
        if (pid === undefined || ppid === undefined || pgid === undefined || stat === undefined) continue;
        rows.set(Number(pid), { ppid: Number(ppid), pgid: Number(pgid), zombie: stat.startsWith("Z") });
    }
    return rows;
}

/**
 * The live (not zombie) processes a stop of `root` must end, from `ps -A -o pid=,ppid=,pgid=,stat=` output: `root`,
 * its descendants, the members of its process group when it leads one, and the descendants of those, plus any
 * `known` pid still alive (found by an earlier look, since orphaned).
 */
export function stopTargets(psOutput: string, root: number, known: ReadonlySet<number> = new Set()): number[] {
    const rows = parseRows(psOutput);
    const children = new Map<number, number[]>();
    const seeds = [root, ...known];
    for (const [pid, row] of rows) {
        const siblings = children.get(row.ppid);
        if (siblings === undefined) children.set(row.ppid, [pid]);
        else siblings.push(pid);
    }
    for (const [pid, row] of rows) if (row.pgid === root) seeds.push(pid);
    const found = new Set<number>();
    const stack = seeds.filter((pid) => rows.has(pid));
    while (stack.length > 0) {
        const pid = stack.pop() as number;
        if (found.has(pid)) continue;
        found.add(pid);
        stack.push(...(children.get(pid) ?? []));
    }
    return [...found].filter((pid) => rows.get(pid)?.zombie === false);
}

/** One look: the live targets, added to `known`; null when `ps` failed. */
function look(root: number, known: Set<number>): number[] | null {
    const ps = run(["ps", "-A", "-o", "pid=,ppid=,pgid=,stat="], { timeoutMs: PS_TIMEOUT_MS });
    if (ps.code !== 0) return null;
    const targets = stopTargets(ps.stdout, root, known);
    for (const pid of targets) known.add(pid);
    return targets;
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

/** Look until no target is left (true) or `ms` passed (false), signalling newly found ones with `signal`. */
async function waitGone(root: number, known: Set<number>, ms: number, signal: NodeJS.Signals): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
        const targets = look(root, known);
        if (targets?.length === 0) return true;
        if (Date.now() >= deadline) return false;
        if (targets !== null) signalAll(targets, signal);
        await Bun.sleep(POLL_MS);
    }
}

/**
 * Stop `root` and everything it started: SIGTERM, then SIGKILL to whatever is left after `graceMs`. Resolves to the
 * pids still alive after that (empty once all are gone).
 */
export async function stopTree(root: number, graceMs: number): Promise<number[]> {
    const known = new Set<number>();
    signalAll(look(root, known) ?? [root], "SIGTERM");
    if (await waitGone(root, known, graceMs, "SIGTERM")) return [];
    signalAll(look(root, known) ?? [...known], "SIGKILL");
    if (await waitGone(root, known, KILL_WAIT_MS, "SIGKILL")) return [];
    return look(root, known) ?? [...known];
}
