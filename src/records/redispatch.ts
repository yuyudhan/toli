// Re-dispatching a task whose jawan died (docs/fleet.md "Active tasks with no live run"): a reboot, an OOM killer or a
// dead lead session ends a jawan without a report, and its task stays active with no live run until a lead acts. The
// tick re-dispatches such a task once, with the same brief and the answers recorded since: a spawn run is continued
// (its omp session resumed, src/jawans/continue.ts), a native subagent that died with its lead session gets a spawn run
// of the task's brief. A task whose re-dispatched jawan dies too is held with a question, never re-dispatched again.
// Only deaths are re-dispatched: a run that ended on its own (done, failed on its harness, killed by `run kill`) and a
// subagent that stopped reporting stay with the lead, as before.
import { join } from "node:path";
import { paths } from "../core/paths.ts";
import { now, readJson, withLock, writeJsonAtomic } from "../core/util.ts";
import { machineDispatch } from "../fleet/dispatch.ts";
import { currentFull } from "../fleet/full.ts";
import { continueRun } from "../jawans/continue.ts";
import { diedWithoutOutcome } from "../jawans/death.ts";
import { type JawanRun, listRuns } from "../jawans/runs.ts";
import { spawnJawan } from "../jawans/spawn.ts";
import { loadBacklog, type Task, updateTask } from "./backlog.ts";
import { briefPath, findStaleTasks, latestOfChain, type StaleAnswer, type StaleTask } from "./stale.ts";

/** One task the tick re-dispatched: the jawan that died, the run that replaced it, and when. */
type Redispatched = { from: string; run: string; at: string };
type RedispatchState = { tasks: Record<string, Redispatched> };

/** How a stale task's jawan died, and its spawn run when it was one; null when it did not die. */
type Death = { how: string; run: JawanRun | null };

const STARTED_BY = "toli, once, because the run died (a second death holds the task)";

/** How `task`'s jawan died, or null when it ended otherwise (or still works through a later run of its chain). */
function deathOf(task: StaleTask, runs: JawanRun[]): Death | null {
    if (task.reason === "session")
        return { how: `its agent ${task.agent ?? "?"} died with its lead session ${task.session ?? "?"}`, run: null };
    if (task.reason !== "ended" || task.agent === null || !task.agent.startsWith("j-")) return null;
    const named = runs.find((run) => run.id === task.agent);
    if (named === undefined) return null;
    const run = latestOfChain(named, runs);
    if (run.status !== "failed" || !diedWithoutOutcome(run.error)) return null;
    return { how: `died: ${run.error}`, run };
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

/** Re-dispatch `task`: continue its dead spawn run, or spawn its brief for a subagent. Null when it has no brief. */
function redispatch(task: StaleTask, death: Death): JawanRun | null {
    if (death.run !== null) {
        const answers = answersText(task.answers);
        return continueRun(death.run, {
            reason: "died",
            stopped: death.how,
            cap: null,
            startedBy: STARTED_BY,
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
 * re-dispatched once; one whose re-dispatch died too, or could not start, is held. Nothing happens on a machine marked
 * full or whose jawans run only as the interactive Sardar's subagents (`lead.dispatch` "subagents"); those tasks
 * stay with the lead through the stale-task wake. Returns the log lines.
 */
export function redispatchDeadRuns(tasks: Task[], at: Date = now()): string[] {
    if (currentFull() !== null || machineDispatch() === "subagents") return [];
    const stale = findStaleTasks(tasks, at);
    const runs = listRuns();
    const dead = stale
        .map((task) => ({ task, death: deathOf(task, runs) }))
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
        const lines: string[] = [];
        for (const { task, death } of dead) {
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
