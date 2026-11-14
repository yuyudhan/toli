// One start of a run's harness and the supervisor's guard while it runs (src/jawans/supervise.ts). On Linux the
// harness gets its own systemd scope, apart from its supervisor's (src/jawans/scope.ts), so an OOM kill of the jawan
// leaves the supervisor to record it; the supervisor outlives the termination signals a logout or service stop sends
// while the harness runs, noting each in the run record for the tick should it die anyway (src/jawans/death.ts).
import { spawn as spawnChild } from "node:child_process";
import { existsSync, fstatSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../core/paths.ts";
import { now, ToliError, warn } from "../core/util.ts";
import { DEFAULT_STALL_MINUTES } from "../fleet/resources.ts";
import { headlessCommand } from "../harness/harness.ts";
import { watchBrowsers } from "./browsers.ts";
import { stallText, watchStall } from "./progress.ts";
import { loadRun, updateRun } from "./runs.ts";
import { type Argv, type HarnessScoped, inJawanScope } from "./scope.ts";
import { HARNESS_STOP_GRACE_MS, stopTree } from "./stop.ts";

/** Grace after the harness's own time limit before the supervisor kills the process group. */
export const KILL_GRACE_MINUTES = 10;

export type ChildExit = { code: number | null; signal: string | null; error: string | null };

export type Attempt = { exit: ChildExit; timedOut: boolean; stalled: boolean; elapsedMs: number; output: string };
/**
 * Run the harness once for the run as recorded now (its model, its brief or resume prompt, its session) and wait for
 * it. The process group is killed when the run stalls (no progress for its stallMinutes, src/jawans/progress.ts) or,
 * only with an explicit `--max-time`, `KILL_GRACE_MINUTES` past that limit. `output` is this attempt's part of the log.
 * On Linux the harness runs in its own systemd scope, `attempt` naming it (src/jawans/scope.ts); when systemd-run
 * cannot make the scope the harness never ran, and it starts once more without one.
 */
export async function runAttempt(
    id: string,
    env: NodeJS.ProcessEnv,
    logFd: number,
    minuteMs: number,
    attempt: number,
): Promise<Attempt> {
    const startedFile = join(loadRun(id).runDir, `scope-${attempt}.started`);
    rmSync(startedFile, { force: true });
    const scoped = await harnessOnce(id, env, logFd, minuteMs, (argv) => inJawanScope(id, attempt, argv, startedFile));
    if (scoped.scope === null) return scoped.result;
    const ran = existsSync(startedFile);
    rmSync(startedFile, { force: true });
    const { exit, timedOut, stalled } = scoped.result;
    if (ran || exit.signal !== null || timedOut || stalled || loadRun(id).status === "killed") return scoped.result;
    writeSync(
        logFd,
        `\n[toli] systemd-run could not start ${scoped.scope} (exit ${exit.code ?? "-"}); running the harness without its own scope\n`,
    );
    return (await harnessOnce(id, env, logFd, minuteMs, () => null)).result;
}

/** One start of the harness, wrapped by `wrap` (null: unwrapped), and the scope unit it ran in. */
async function harnessOnce(
    id: string,
    env: NodeJS.ProcessEnv,
    logFd: number,
    minuteMs: number,
    wrap: (argv: Argv) => HarnessScoped | null,
): Promise<{ result: Attempt; scope: string | null }> {
    const run = loadRun(id);
    const command = headlessCommand(run.harness, {
        brief: readFileSync(run.briefPath, "utf8"),
        briefPath: run.briefPath,
        cwd: run.cwd,
        root: paths.root(),
        model: run.model ?? undefined,
        maxMinutes: run.maxMinutes,
        ...(run.sessionDir === undefined ? {} : { session: { dir: run.sessionDir, resume: run.resumeSession } }),
    });
    const [program, ...programArgs] = command.argv;
    if (program === undefined) throw new ToliError("empty harness command");
    const scoped = wrap([program, ...programArgs]);
    const [spawned, ...spawnedArgs] = scoped?.argv ?? [program, ...programArgs];
    const offset = fstatSync(logFd).size;
    const launchedAt = Date.now();
    const child = spawnChild(spawned, spawnedArgs, {
        cwd: run.cwd,
        detached: true,
        env: { ...env, ...scoped?.env },
        stdio: [command.stdin === null ? "ignore" : "pipe", logFd, logFd],
    });
    const spawnedAtMs = Date.now();
    const { promise: exited, resolve: done } = Promise.withResolvers<ChildExit>();
    child.once("error", (error) => done({ code: null, signal: null, error: error.message }));
    child.once("exit", (code, signal) => done({ code, signal, error: null }));
    if (command.stdin !== null) {
        // A harness that exits before reading all of its brief closes the pipe: note it rather than crash on EPIPE.
        child.stdin?.once("error", (error) => {
            writeSync(logFd, `\n[toli] the harness did not read its whole brief: ${error.message}\n`);
        });
        child.stdin?.end(command.stdin);
    }
    const childPid = child.pid ?? null;
    if (childPid !== null)
        updateRun(id, (record) => {
            if (record.status === "starting") record.status = "running";
            record.pid = childPid;
        });
    const browsers = childPid === null ? null : watchBrowsers({ pid: childPid, spawnedAtMs }, id, minuteMs);
    let timedOut = false;
    let stalled = false;
    const stopping: Promise<number[]>[] = [];
    const stop = (): void => {
        // A reaped harness's pid may already be someone else's: only a live (or unreaped) one is stopped.
        if (childPid === null || stopping.length > 0 || child.exitCode !== null || child.signalCode !== null) return;
        stopping.push(stopTree({ pid: childPid, spawnedAtMs }, HARNESS_STOP_GRACE_MS));
    };
    const timer =
        run.maxMinutes === null
            ? undefined
            : setTimeout(
                  () => {
                      timedOut = true;
                      stop();
                  },
                  (run.maxMinutes + KILL_GRACE_MINUTES) * minuteMs,
              );
    const stopWatch = watchStall(
        () => ({ pid: childPid, logPath: run.logPath, sessionDir: run.sessionDir ?? null, cwd: run.cwd }),
        run.stallMinutes ?? DEFAULT_STALL_MINUTES,
        minuteMs,
        () => {
            stalled = true;
            writeSync(logFd, `\n[toli] ${stallText(run.stallMinutes ?? DEFAULT_STALL_MINUTES)}: stopping the run\n`);
            stop();
        },
    );
    const exit = await exited;
    clearTimeout(timer);
    stopWatch();
    // A harness that exits on SIGTERM can leave children that ignore it: the attempt ends once all of them are gone.
    const survivors = (await Promise.all(stopping)).flat();
    if (survivors.length > 0) writeSync(logFd, `\n[toli] pid ${survivors.join(", ")} outlived SIGKILL\n`);
    await browsers?.finish(logFd);
    const elapsedMs = Date.now() - launchedAt;
    const output = existsSync(run.logPath) ? readFileSync(run.logPath).subarray(offset).toString("utf8") : "";
    return { result: { exit, timedOut, stalled, elapsedMs, output }, scope: scoped?.unit ?? null };
}

/** The signals that stop a process unless it handles them: what a logout, a service stop or a `kill` sends. */
const OUTLIVED_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGHUP", "SIGINT"];

/**
 * Have the supervisor of run `id` outlive the termination signals while it waits for its harness, so it still records
 * the outcome (the harness gets the same signal from a logout or a service stop and ends). Each one caught is noted in
 * the run record, where the tick finds it should the supervisor be SIGKILL'd before the harness ends
 * (src/jawans/death.ts). Returns the function that removes the handlers.
 */
export function outliveSignals(id: string): () => void {
    const handlers = OUTLIVED_SIGNALS.map((signal) => {
        const handler = (): void => {
            const at = now().toISOString();
            warn(`${id}: the supervisor got ${signal} at ${at}; it waits for the harness to record the outcome`);
            try {
                updateRun(id, (record) => {
                    record.supervisorSignal = { signal, at };
                });
            } catch (error) {
                warn(`${id}: noting ${signal} failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        };
        process.on(signal, handler);
        return [signal, handler] as const;
    });
    return () => {
        for (const [signal, handler] of handlers) process.off(signal, handler);
    };
}
