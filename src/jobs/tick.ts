import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { Args } from "../core/args.ts";
import { loadMachine, type Machine, pullsItsMessages } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { tryPidLock } from "../core/pid-lock.ts";
import { now, out, pidAlive, readJson, ToliError } from "../core/util.ts";
import { alertLowBattery } from "../fleet/battery.ts";
import { resumeDevStacksWhenIdle } from "../fleet/build-slots.ts";
import { onOutboxDelivered } from "../fleet/delegate.ts";
import { keepDiskBeforeWork } from "../fleet/disk-before-work.ts";
import { jobsPause } from "../fleet/dispatch-pause.ts";
import { idleSessionText, sessionPresence } from "../fleet/idle-session.ts";
import { runDueFleetCheck } from "../fleet/oversight.ts";
import type { RunRecord } from "../fleet/resources.ts";
import { keepSccache } from "../fleet/sccache-keep.ts";
import { alertSessionMemory } from "../fleet/session-memory.ts";
import { alertSilentSession } from "../fleet/silent-alert.ts";
import { stopOrphanedGates } from "../forge/gate-owner.ts";
import { choiceText } from "../harness/models.ts";
import { runHook } from "../helpers/local.ts";
import { reportUnpostedRuns } from "../jawans/adopt.ts";
import { drainQueue } from "../jawans/supervise.ts";
import { hasIdentity } from "../peer/identity.ts";
import { syncIntroductions } from "../peer/introducer.ts";
import { pullPeers } from "../peer/pull-peers.ts";
import { pullLine } from "../peer/transport-command.ts";
import { startDueCatchUpScan } from "../projects/catch-up.ts";
import { loadBacklog } from "../records/backlog.ts";
import { weeklyPruneReport } from "../records/prune.ts";
import { raiseHolds } from "../records/raise-holds.ts";
import { redispatchDeadRuns } from "../records/redispatch.ts";
import { surfaceStaleTasks } from "../records/stale.ts";
import { holdInboxWords } from "../records/word-holds.ts";
import { startDueUpdateCheck } from "../release/update-check.ts";
import { jobMaxMinutes, runHeadless } from "./headless.ts";
import {
    type BegunRun,
    beginJob,
    dueJobs,
    findJob,
    finishJob,
    jobSubcommands,
    loadJobState,
    STALE_RUN_MS,
} from "./jobs.ts";
import { jobModel, limitPauseFor, noticePause } from "./limit-pause.ts";
import { dryRun as envDryRun } from "./os-scheduler.ts";
import { deliverOutbox } from "./outbox.ts";
import { pullFleet, pullText } from "./pull.ts";
import { retryThenAlert } from "./pull-peer-retry.ts";
import { Reach } from "./reach.ts";

function log(line: string): void {
    mkdirSync(paths.logsDir(), { recursive: true });
    appendFileSync(paths.tickLog(), `${now().toISOString()} ${line}\n`);
}

/** One step of the tick: its notes go to the log; a failure is logged as `<failed>: <error>`, never stopping it. */
function logStep(failed: string, run: () => readonly string[] | string | null | undefined): void {
    try {
        const notes = run();
        for (const note of typeof notes === "string" ? [notes] : (notes ?? [])) if (note) log(note);
    } catch (error) {
        log(`${failed}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** While the tick waits on its job runs, it moves the fleet's messages this often (see keepExchanging). */
const EXCHANGE_EVERY_MS = 60_000;

/**
 * One pass of the fleet's messages: a machine that takes no inbound ssh first pulls what the others queued for it
 * (src/jobs/pull.ts), from all of them at once, then the outbox goes out. Both share one Reach (src/jobs/reach.ts), so
 * a host that failed is tried once per pass and a host that is down is backed off across ticks. A pass that finds
 * another still running (an overlapping cron tick) leaves this round to it.
 */
async function exchangeMessages(machine: Machine): Promise<void> {
    const lock = paths.lock("messages");
    if (!tryPidLock(lock)) {
        log("messages: the previous pass is still running; this one is skipped");
        return;
    }
    try {
        const reach = new Reach({ backoff: true });
        try {
            if (pullsItsMessages()) {
                const pulled = await pullFleet(reach);
                if (pulled === null || pulled.pulled > 0 || pulled.errors.length > 0) log(pullText(pulled));
                for (const error of pulled?.errors ?? []) log(`pull: ${error}`);
            }
            // Every machine pulls from its paired peers over HTTPS, relayed items included: a peer holds what it has
            // for a machine it thinks pull-only, and a relay holds what it carries for every recipient, listener or
            // not, until that recipient pulls (T2775).
            if (hasIdentity())
                for (const report of await pullPeers())
                    if (report.applied > 0 || report.relayed !== undefined || report.error !== undefined)
                        log(`peer pull from ${pullLine(report)}`);
        } catch (error) {
            log(`pull failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        // An introducer keeps its introductions current before its outbox goes out: boxes added to the fleet since,
        // a subject's rotated key, pins about to expire (src/peer/introducer.ts; nothing when it introduced nobody).
        if (hasIdentity())
            try {
                for (const line of syncIntroductions()) log(`introduce: ${line}`);
            } catch (error) {
                log(`introduce --sync failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        const outbox = deliverOutbox(machine, onOutboxDelivered, reach);
        if (outbox.delivered > 0) log(`outbox: delivered ${outbox.delivered}`);
        for (const error of outbox.errors) log(`outbox: pending ${error}`);
        // A peer that only pulls is tried over HTTPS too, and only then are the waiting alerts posted.
        for (const note of retryThenAlert(reach)) log(`outbox: ${note}`);
    } finally {
        rmSync(lock, { force: true });
    }
}

/**
 * Wait for `work`, moving the fleet's messages every minute meanwhile. launchd and systemd start no tick while one
 * still runs, so without this a tick waiting on a long job run would hold every pull and delivery until it ended.
 */
async function keepExchanging(machine: Machine, work: Promise<void>): Promise<void> {
    let done = false;
    const finished = work.finally(() => {
        done = true;
    });
    while (!done) {
        const { promise: wait, resolve: wake } = Promise.withResolvers<void>();
        const timer = setTimeout(wake, EXCHANGE_EVERY_MS);
        await Promise.race([finished, wait]);
        clearTimeout(timer);
        if (!done) await exchangeMessages(machine);
    }
    await finished;
}

/**
 * Record runs stuck in "running" past the stale limit as failed so their schedule resumes. A headless run whose omp
 * is still alive (its load record names a live pid) is not stale: its deadline (maxMinutes) or a stall stops it.
 */
function failStaleRuns(): string[] {
    const cutoff = now().getTime() - STALE_RUN_MS;
    const stale = Object.entries(loadJobState()).filter(([, state]) => {
        if (!state.running || new Date(state.running.startedAt).getTime() >= cutoff) return false;
        const load = readJson<RunRecord | null>(paths.runRecord(state.running.runId), null);
        return load === null || !pidAlive(load.pid);
    });
    const notes: string[] = [];
    for (const [name, state] of stale) {
        const running = state.running;
        if (!running) continue;
        try {
            const body = `Run ${running.runId} (via ${running.via}) started ${running.startedAt} and never reported a result within 3h; marked failed by the ticker.`;
            notes.push(
                `job ${name} ${running.runId}: stale, marked failed (${finishJob(name, running.runId, body, "failed")})`,
            );
        } catch (error) {
            notes.push(
                `job ${name}: could not mark stale run failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
    return notes;
}

/**
 * Claim and run every job due on this machine, each in its own headless omp, and wait for all of them.
 * Claiming goes through beginJob's lock, so a job another runner already claimed is skipped, never run twice. A job
 * whose model is paused by a rate/usage limit is skipped, its window kept for one run after the reset. While a disk
 * hold or a fleet reboot's dispatch pause holds new jobs (src/fleet/dispatch-pause.ts) none starts; each stays due
 * until the pause lifts.
 */
async function runDueJobs(origin: string): Promise<void> {
    const at = now();
    const machine = loadMachine();
    const due = dueJobs(at, machine);
    const pause = jobsPause();
    if (pause !== null) {
        if (due.length > 0) log(`due jobs not started: ${due.map((job) => job.name).join(", ")}: ${pause.text}`);
        return;
    }
    const runs = due.map(async (job) => {
        const pause = limitPauseFor(job, at);
        if (pause !== null) {
            const notice = noticePause(machine, job.name, pause);
            if (notice !== null) log(notice);
            return;
        }
        let begun: BegunRun;
        try {
            begun = beginJob(job.name, "headless");
        } catch (error) {
            // Another runner claimed it between our due check and begin.
            log(`job ${job.name}: not started: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        log(`job ${job.name} ${begun.runId}: started headless (${origin})`);
        try {
            log(await runHeadless(job, begun));
        } catch (error) {
            log(`job ${job.name} ${begun.runId}: run error: ${error instanceof Error ? error.message : String(error)}`);
        }
    });
    await Promise.all(runs);
}

export async function tick(): Promise<void> {
    const machine = loadMachine();
    try {
        const report = weeklyPruneReport(machine);
        if (report) log(report);
    } catch (error) {
        log(`prune report failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
        // Detached: the tick never waits on the network.
        const started = startDueUpdateCheck();
        if (started) log(started);
    } catch (error) {
        log(`update check failed to start: ${error instanceof Error ? error.message : String(error)}`);
    }
    await exchangeMessages(machine);
    for (const note of failStaleRuns()) log(note);
    // Low disk never stops work: under the floor the tick starts the disk keeper detached (src/fleet/disk.ts) and goes
    // on, so a keeper slowed by a starved disk never holds up a tick. The queue drain below leaves the disk to it.
    const disk = keepDiskBeforeWork("detached");
    if (disk) log(disk);
    // sccache at its cap can wedge its server and freeze every build on it: trim it and restart an idle server.
    try {
        const sccache = keepSccache(envDryRun());
        if (sccache) log(sccache);
    } catch (error) {
        log(`sccache check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // A dev stack a killed build holder left paused (src/fleet/stack-pause.ts) is unpaused once no build holds a slot.
    try {
        resumeDevStacksWhenIdle();
    } catch (error) {
        log(`dev stacks not resumed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Queued jawan runs start as slots free; the finishing run's supervisor does this too, this catches the rest.
    logStep("queued jawan runs not started", () => drainQueue({ diskKept: true }));
    // Every jawan reports to this machine's lead: a run that ended without posting its outcome is posted now.
    logStep("unreported jawan runs not posted", reportUnpostedRuns);
    // A gate whose jawans all ended is stopped by the last one's supervisor; this catches a run whose supervisor died.
    try {
        for (const note of await stopOrphanedGates()) log(note);
    } catch (error) {
        log(`orphaned gates not stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Oversight never pauses: dead jawans re-dispatched once (records/redispatch.ts), stale tasks posted, fleet check.
    logStep("dead runs not re-dispatched", () => redispatchDeadRuns(loadBacklog().tasks));
    logStep("stale task check failed", () => surfaceStaleTasks(loadBacklog().tasks));
    // A question another machine asked for the user's word goes into the Needs-you queue (records/word-holds.ts).
    logStep("questions for the user's word not held", holdInboxWords);
    // A project whose main carries a new vX.Y.Z tag gets one catch-up jawan here (src/projects/catch-up.ts); the scan
    // fetches, so it runs detached and the tick never waits on the network.
    logStep("release catch-up scan not started", () => startDueCatchUpScan());
    // A worker's own holds go to its coordinator's Needs-you queue, where the user is (records/raise-holds.ts).
    logStep("holds not raised to the coordinator", raiseHolds);
    // An interactive Sardar that takes no wake leaves the inbox unread: the coordinator hears of it (silent-alert.ts).
    logStep("silent session check failed", alertSilentSession);
    // A lead session past lead.sessionMemoryGB is told once to stow and restart; toli never stops it (session-memory.ts).
    logStep("session memory check failed", alertSessionMemory);
    // A machine the others depend on, low on battery and discharging, alerts every 15 min until plugged in (battery.ts).
    logStep("battery check failed", alertLowBattery);
    try {
        const fleet = await runDueFleetCheck();
        if (fleet) log(fleet);
    } catch (error) {
        log(`fleet check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // A live session that has left its wakes unread past lead.idleSessionMinutes no longer keeps the due jobs.
    const presence = sessionPresence();
    if (presence !== null && presence.idle === null) {
        log(`live session pid ${presence.session.pid}: due jobs left to it`);
        return;
    }
    if (presence?.idle) log(`interactive session ${idleSessionText(presence.idle)}: due jobs run headless`);
    await keepExchanging(machine, runDueJobs("ticker"));
}

/** `toli job run <name>`: run a job once, now, headless, regardless of its schedule. */
async function runNow(argv: string[]): Promise<void> {
    const args = new Args(argv);
    args.maxPositional(1);
    const name = args.pos(0, "name");
    const job = findJob(name);
    const maxMinutes = jobMaxMinutes(job);
    const begun = beginJob(name, "headless");
    out(
        `job ${name} ${begun.runId}: running headless omp ${choiceText(jobModel(job))} (${maxMinutes === null ? "no deadline" : `deadline ${maxMinutes} min`}; stopped sooner if it stalls)`,
    );
    const summary = await runHeadless(job, begun);
    log(summary);
    out(summary);
    const result = loadJobState()[name]?.lastResult;
    if (result) out(result);
}

export async function jobCommand(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;
    switch (sub) {
        case "add":
            return jobSubcommands.add(rest);
        case "list":
            return jobSubcommands.list(rest);
        case "pause":
            return jobSubcommands.setEnabled(rest, false);
        case "resume":
            return jobSubcommands.setEnabled(rest, true);
        case "remove":
            return jobSubcommands.remove(rest);
        case "due":
            return jobSubcommands.due(rest);
        case "begin":
            return jobSubcommands.begin(rest);
        case "finish":
            return jobSubcommands.finish(rest);
        case "results":
            return jobSubcommands.results(rest);
        case "ack":
            return jobSubcommands.ack(rest);
        case "run":
            return runNow(rest);
        case "run-due":
            // The live session's extension starts this in the background; the OS ticker defers to it.
            new Args(rest).maxPositional(0);
            return runDueJobs("session");
        case "tick":
            new Args(rest).maxPositional(0);
            runHook("pre-tick");
            try {
                return await tick();
            } finally {
                runHook("post-tick");
            }
        default:
            throw new ToliError(
                "usage: toli job add|list|pause|resume|remove|due|begin|finish|run|run-due|tick|results|ack",
            );
    }
}
