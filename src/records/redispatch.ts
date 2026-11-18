// Re-dispatching a task whose jawan stopped for good (docs/fleet.md "Oversight"): a reboot, an OOM killer or a dead
// lead session ends a jawan without a report, and its task stays active with no live run until a lead acts. The tick
// re-dispatches such a task once, with the same brief and the answers recorded since: a spawn run is continued (its
// omp session resumed, src/jawans/continue.ts), a native subagent that died with its lead session gets a spawn run of
// the task's brief. A task whose re-dispatched jawan dies too is held with a question, never re-dispatched again. On a
// machine with no agent activity for oversight.idleMachineMinutes (src/records/idle-machine.ts), a subagent that
// stopped reporting counts as dead too. A run stopped on a rate/usage limit is resumed after a back-off (30 minutes,
// doubling per limit stop in a row, at most 4 hours), as often as it takes, never held. A run that ended on its own
// (done, failed on its harness, killed by `run kill`) stays with the lead, as before.
import { join } from "node:path";
import { paths } from "../core/paths.ts";
import { now, readJson, withLock, writeJsonAtomic } from "../core/util.ts";
import { machineDispatch } from "../fleet/dispatch.ts";
import { currentFull } from "../fleet/full.ts";
import { continueRun } from "../jawans/continue.ts";
import { diedWithoutOutcome, LIMIT_STOP } from "../jawans/death.ts";
import { type JawanRun, listRuns } from "../jawans/runs.ts";
import { spawnJawan } from "../jawans/spawn.ts";
import { loadBacklog, type Task, updateTask } from "./backlog.ts";
import { watchIdleMachine } from "./idle-machine.ts";
import { briefPath, findStaleTasks, latestOfChain, type StaleAnswer, type StaleTask } from "./stale.ts";

/** One task the tick re-dispatched: the jawan that died, the run that replaced it, and when. */
type Redispatched = { from: string; run: string; at: string };
type RedispatchState = { tasks: Record<string, Redispatched> };

/**
 * How a stale task's jawan stopped, and its spawn run when it was one; null when it did not stop for good.
 * `backoffMinutes`: a rate/usage-limit stop, resumed after that back-off and never counted against the once.
 */
type Death = { how: string; run: JawanRun | null; backoffMinutes?: number };

const STARTED_BY = "toli, once, because the run died (a second death holds the task)";
/** The first back-off after a rate/usage-limit stop, and the most it doubles to. */
const LIMIT_BACKOFF_MINUTES = 30;
const LIMIT_BACKOFF_MAX_MINUTES = 240;

/** The resume reason of a run continued after a rate/usage limit (src/jawans/continue.ts). */
const LIMIT_RESUME = "rate/usage limit";

/** The back-off before resuming `run` after a limit stop: doubled for each limit continuation that led to it. */
function limitBackoff(run: JawanRun, runs: JawanRun[]): number {
    let streak = 0;
    for (let link: JawanRun | undefined = run; link?.resumeReason === LIMIT_RESUME; streak++)
        link = runs.find((entry) => entry.id === link?.resumeOf);
    return Math.min(LIMIT_BACKOFF_MAX_MINUTES, LIMIT_BACKOFF_MINUTES * 2 ** streak);
}

/**
 * How `task`'s jawan stopped for good, or null when it ended otherwise, still works through a later run of its chain,
 * or waits out a limit back-off. `idleMinutes`: how long this machine has shown no agent activity, when over the limit.
 */
function deathOf(task: StaleTask, runs: JawanRun[], at: Date, idleMinutes: number | null): Death | null {
    if (task.reason === "session")
        return { how: `its agent ${task.agent ?? "?"} died with its lead session ${task.session ?? "?"}`, run: null };
    if (task.reason === "silent" && idleMinutes !== null)
        return {
            how: `its agent ${task.agent ?? "?"} stopped reporting, and this machine shows no agent activity for ${idleMinutes} min`,
            run: null,
        };
    if (task.reason !== "ended" || task.agent === null || !task.agent.startsWith("j-")) return null;
    const named = runs.find((run) => run.id === task.agent);
    if (named === undefined) return null;
    const run = latestOfChain(named, runs);
    if (run.status !== "failed") return null;
    if (diedWithoutOutcome(run.error)) return { how: `died: ${run.error}`, run };
    if (run.error !== LIMIT_STOP || run.endedAt === null) return null;
    const backoffMinutes = limitBackoff(run, runs);
    if (at.getTime() - Date.parse(run.endedAt) < backoffMinutes * 60_000) return null;
    return { how: LIMIT_STOP, run, backoffMinutes };
}

/** The answers recorded since the jawan died, as lines for its successor. */
function answersText(answers: StaleAnswer[]): string {
    if (answers.length === 0) return "";
    return [
        "Answers recorded since it stopped (they may settle what it was waiting on):",
        ...answers.map((answer) => `- ${answer.id} (${answer.at}): ${JSON.stringify(answer.answer)}`),
    ].join("\n");
}

/** The section a fresh spawn run of a dead subagent's brief gets. */
function redispatchSection(task: StaleTask, death: Death): string {
    const answers = answersText(task.answers);
    return [
        "",
        "## RE-DISPATCHED (toli, once)",
        "",
        `The previous jawan on ${task.id} stopped before writing its report: ${death.how}. toli re-dispatched this brief once.`,
        "- Its edits may be uncommitted in the working tree: start with `git status` and `git diff`, keep the finished work, and do not redo or revert it.",
        ...(answers === "" ? [] : ["", answers]),
        "",
    ].join("\n");
}

/** Re-dispatch `task`: continue its stopped spawn run, or spawn its brief for a subagent. Null when it has no brief. */
function redispatch(task: StaleTask, death: Death): JawanRun | null {
    if (death.run !== null) {
        const answers = answersText(task.answers);
        const limited = death.backoffMinutes !== undefined;
        return continueRun(death.run, {
            reason: limited ? LIMIT_RESUME : "died",
            stopped: death.how,
            cap: null,
            startedBy: limited ? `toli after a ${death.backoffMinutes}-minute back-off` : STARTED_BY,
            now: false,
            note: answers === "" ? undefined : answers,
        });
    }
    const brief = briefPath(task.project, task.id);
    if (brief === null) return null;
    const run = spawnJawan({
        briefPath: join(paths.root(), brief),
        task: task.id,
        extra: redispatchSection(task, death),
    });
    updateTask(task.id, (entry) => {
        entry.notes.push(`${death.how}; re-dispatched by toli as ${run.id} (${STARTED_BY})`);
    });
    return run;
}

/** Hold `id` on the user's word: its re-dispatch died too, or could not start. */
function hold(id: string, question: string): void {
    updateTask(id, (entry) => {
        if (entry.status !== "active") return;
        entry.status = "held";
        entry.question = question;
        entry.heldAt = now().toISOString();
        delete entry.options;
        delete entry.recommend;
        delete entry.waitingOn;
        delete entry.answer;
    });
}

/**
 * The tick's re-dispatch: every stale active task among `tasks` (this machine's backlog) whose jawan died is
 * re-dispatched once; one whose re-dispatch died too, or could not start, is held. A rate/usage-limit stop is resumed
 * once its back-off is over, every time. On a machine with waiting work and no agent activity for
 * oversight.idleMachineMinutes (watchIdleMachine, which also alerts when no lead session lives) a subagent that
 * stopped reporting is dead too. Nothing is re-dispatched on a machine marked full or whose jawans run only as the
 * interactive Sardar's subagents (`lead.dispatch` "subagents"); those tasks stay with the lead through the stale-task
 * wake. Returns the log lines.
 */
export function redispatchDeadRuns(tasks: Task[], at: Date = now()): string[] {
    const idle = watchIdleMachine(tasks, at);
    if (currentFull() !== null || machineDispatch() === "subagents") return idle.lines;
    const stale = findStaleTasks(tasks, at);
    const runs = listRuns();
    const dead = stale
        .map((task) => ({ task, death: deathOf(task, runs, at, idle.idleMinutes) }))
        .filter((entry): entry is { task: StaleTask; death: Death } => entry.death !== null);
    return withLock(paths.lock("redispatch"), () => {
        const state = readJson<RedispatchState>(paths.redispatchState(), { tasks: {} });
        const open = new Set(
            loadBacklog()
                .tasks.filter((task) => task.status === "active" || task.status === "held")
                .map((task) => task.id),
        );
        const kept: Record<string, Redispatched> = {};
        for (const [id, entry] of Object.entries(state.tasks)) if (open.has(id)) kept[id] = entry;
        const lines = [...idle.lines];
        for (const { task, death } of dead) {
            if (death.backoffMinutes !== undefined) {
                try {
                    const run = redispatch(task, death);
                    lines.push(
                        `${task.id}: resumed as ${run?.id} (${run?.status}) after a ${death.backoffMinutes}-minute back-off from a rate/usage limit`,
                    );
                } catch (error) {
                    lines.push(
                        `${task.id}: not resumed after its rate/usage limit: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
                continue;
            }
            const before = kept[task.id];
            if (before !== undefined) {
                hold(
                    task.id,
                    `${task.id}'s jawan ${death.how}, after toli had re-dispatched it once (${before.from} -> ${before.run}): re-dispatch it again (bin/toli spawn --task ${task.id} --brief <file>), finish it by hand, or drop it?`,
                );
                lines.push(`${task.id}: held, its re-dispatched jawan died too`);
                continue;
            }
            let run: JawanRun | null;
            try {
                run = redispatch(task, death);
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                hold(
                    task.id,
                    `${task.id}'s jawan ${death.how}, and toli could not re-dispatch it (${reason}): re-dispatch it (bin/toli spawn --task ${task.id} --brief <file>), finish it by hand, or drop it?`,
                );
                lines.push(`${task.id}: held, re-dispatch failed: ${reason}`);
                continue;
            }
            // A subagent's task with no brief file stays with the lead (the stale-task wake names it).
            if (run === null) continue;
            kept[task.id] = { from: death.run?.id ?? task.agent ?? "", run: run.id, at: at.toISOString() };
            lines.push(`${task.id}: re-dispatched as ${run.id} (${run.status}): its jawan ${death.how}`);
        }
        writeJsonAtomic(paths.redispatchState(), { tasks: kept });
        return lines;
    });
}
