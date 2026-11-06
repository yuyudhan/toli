// `bin/toli remote` (dispatch a prompt to another fleet machine over ssh) and `bin/toli exec` (the target's side:
// run it in headless omp, recorded as a jawan run, on the model this machine's tiers pick).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Args, parseMinutes } from "../core/args.ts";
import { fleetMachine, loadMachine, remoteToliCommand, sshArgs } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { persona } from "../core/persona.ts";
import {
    now,
    out,
    readStdin,
    requireName,
    run,
    runTee,
    shellQuote,
    stamp,
    type TeeResult,
    ToliError,
    warn,
    writeTextAtomic,
} from "../core/util.ts";
import { harnessConfig, headlessOmpArgs, parseWork, type WorkType } from "../harness/harness.ts";
import {
    briefTier,
    choiceText,
    hitLimit,
    limitPlan,
    limitReset,
    parseOptionalTier,
    parseUsage,
    resolveModel,
    type Tier,
    type Usage,
} from "../harness/models.ts";
import { recordRun } from "../jawans/launch.ts";
import { loadRun, updateRun } from "../jawans/runs.ts";
import { loadProjects } from "../projects/projects.ts";
import { loadBacklog } from "../records/backlog.ts";
import { ISSUED_BY_ENV, ISSUED_TASK_ENV } from "../records/push-log.ts";
import { keepDiskBeforeWork } from "./disk.ts";
import { noCandidateText, pickMachine } from "./pick.ts";
import { localStartRefusal, registerRun, removeRun } from "./resources.ts";

const REMOTE_HEADER = "[toli remote from ";

export function remotePrompt(from: string, target: string, prompt: string, project?: string): string {
    return [
        `${REMOTE_HEADER}${from} to ${target}]`,
        `This request was dispatched by ${persona().lead} on ${from}; nobody is watching this run.`,
        'Rules: commit on the current branch only (bin/toli commit <project> -m "..." -- <paths>); never push, merge, or open a PR;',
        "never ask questions; never end your turn while a subagent, background job, build or poll you started still runs, wait for it.",
        "Finish by reporting the outcome and the evidence (commands run, results, commit shas).",
        ...(project === undefined ? [] : [`Project: ${project} (clone at projects/${project}).`]),
        "",
        prompt,
    ].join("\n");
}

/** Run-record title: the request's first line, skipping the remote-dispatch header block. */
function runTitle(prompt: string): string {
    const body = prompt.startsWith(REMOTE_HEADER) ? prompt.slice(prompt.indexOf("\n\n") + 2) : prompt;
    const line =
        body
            .split("\n")
            .find((entry) => entry.trim() !== "")
            ?.trim() ?? "";
    return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

/** Default `remote`/`exec` budget in minutes; omp gets `--max-time` and the run is killed `KILL_MARGIN_MINUTES` later. */
const DEFAULT_EXEC_MAX_MINUTES = 180;
const KILL_MARGIN_MINUTES = 5;
/**
 * `remote` hands its `--max-time`, `--project`, `--tier` and `--work` to `exec` through these variables rather than
 * flags, so dispatching to a machine on an older toli still works: its `exec` ignores them and keeps its own limit and
 * model. The target resolves the tier or work type to a model with its own harness config.
 */
const EXEC_MAX_MINUTES_ENV = "TOLI_EXEC_MAX_MINUTES";
const EXEC_PROJECT_ENV = "TOLI_EXEC_PROJECT";
const EXEC_TIER_ENV = "TOLI_EXEC_TIER";
const EXEC_WORK_ENV = "TOLI_EXEC_WORK";
/** The task's tier, which ranks below the prompt's Tier: line (unlike `--tier`). */
const EXEC_TASK_TIER_ENV = "TOLI_EXEC_TASK_TIER";
/** A limit retry needs at least this much of the exec's budget left. */
const MIN_RETRY_MINUTES = 5;

/** Milliseconds after which a run with an omp budget of `maxMinutes` is killed. */
export function execKillMs(maxMinutes: number): number {
    return (maxMinutes + KILL_MARGIN_MINUTES) * 60 * 1000;
}

/** The exec's tier and work type from `remote`'s variables; empty or absent is none. */
function execRequest(): { tier: Tier | null; taskTier: Tier | null; work: WorkType | null } {
    const tier = process.env[EXEC_TIER_ENV] ?? "";
    const taskTier = process.env[EXEC_TASK_TIER_ENV] ?? "";
    const work = process.env[EXEC_WORK_ENV] ?? "";
    return {
        tier: parseOptionalTier(tier === "" ? undefined : tier, EXEC_TIER_ENV) ?? null,
        taskTier: parseOptionalTier(taskTier === "" ? undefined : taskTier, EXEC_TASK_TIER_ENV) ?? null,
        work: work === "" ? null : parseWork(work, EXEC_WORK_ENV),
    };
}

/**
 * `toli exec`: run the stdin prompt in headless omp here. It is recorded as a jawan run (state/jawans/, so `runs`,
 * `digest` and the jawan slots see it) and counted as load (state/runs/) for its lifetime; its output streams back
 * to the caller and into the run's output.log, and the run ends done or failed with omp's exit. The run carries the
 * issuing machine and task in its environment, so a `bin/toli push` in it is logged as theirs. omp gets
 * `TOLI_EXEC_MAX_MINUTES` minutes (default 180, set by `bin/toli remote --max-time`) and is killed 5 minutes later.
 * The model comes from this machine's tiers (`TOLI_EXEC_TIER`, the prompt's Tier: line, `TOLI_EXEC_WORK`); a run
 * stopped by a rate or usage limit retries once on a fallback model within what is left of its budget, never
 * waiting for a reset (the caller's ssh would time out).
 */
export async function execCommand(argv: string[]): Promise<number> {
    const args = new Args(argv, { values: ["from", "task"] });
    args.maxPositional(0);
    const prompt = readStdin();
    if (prompt.trim() === "") throw new ToliError("exec needs the prompt on stdin");
    const machine = loadMachine();
    const maxMinutes = parseMinutes(process.env[EXEC_MAX_MINUTES_ENV]) ?? DEFAULT_EXEC_MAX_MINUTES;
    const from = requireName("machine", args.str("from") ?? machine.name);
    const task = args.str("task") ?? null;
    if (task !== null) requireName("task", task);
    const projectEnv = process.env[EXEC_PROJECT_ENV];
    const project = projectEnv === undefined || projectEnv === "" ? null : requireName("project", projectEnv);
    const request = execRequest();
    const config = harnessConfig();
    const choice = resolveModel(
        "omp",
        { tier: request.tier, briefTier: briefTier(prompt), taskTier: request.taskTier, work: request.work },
        config,
    );
    const refusal = localStartRefusal();
    if (refusal.length > 0) {
        throw new ToliError(`exec: ${machine.name} is full (${refusal.join("; ")}); not starting this run here`);
    }
    keepDiskBeforeWork();
    const jawan = recordRun(
        {
            harness: "omp",
            task,
            project,
            work: request.work,
            model: choice.model,
            tier: choice.tier,
            modelSource: choice.source,
            cwd: paths.root(),
            maxMinutes,
            baseBrief: prompt,
            extra: "",
        },
        { argv: headlessOmpArgs("<brief>", paths.root(), `${maxMinutes}m`, choice.model), ownerPid: process.pid },
    );
    warn(`exec: recorded as run ${jawan.id} on ${machine.name} (from ${from}), omp ${choiceText(choice)}`);
    const runId = `exec-${stamp()}-${process.pid}`;
    registerRun({
        runId,
        pid: process.pid,
        from,
        task,
        startedAt: now().toISOString(),
        title: runTitle(prompt),
    });
    const startedMs = Date.now();
    const attempt = async (model: string | null, minutes: number): Promise<TeeResult & { output: string }> => {
        const offset = existsSync(jawan.logPath) ? statSync(jawan.logPath).size : 0;
        const result = await runTee(headlessOmpArgs(prompt, paths.root(), `${minutes}m`, model), jawan.logPath, {
            cwd: paths.root(),
            timeoutMs: execKillMs(minutes),
            env: { [ISSUED_BY_ENV]: from, [ISSUED_TASK_ENV]: task ?? undefined },
            onStart: (pid) => {
                updateRun(jawan.id, (record) => {
                    record.pid = pid;
                });
            },
        });
        return { ...result, output: readFileSync(jawan.logPath).subarray(offset).toString("utf8") };
    };
    let code = 1;
    let timedOut = false;
    let error: string | null = null;
    let usage: Usage | null = null;
    try {
        let result = await attempt(choice.model, maxMinutes);
        const left = maxMinutes - Math.ceil((Date.now() - startedMs) / 60_000);
        if (!result.timedOut && hitLimit(result.output, result.code) && loadRun(jawan.id).status !== "killed") {
            const at = now();
            const plan = limitPlan(
                { harness: "omp", model: choice.model, tier: choice.tier, work: request.work },
                limitReset(result.output, at),
                at,
                config,
            );
            const retry = plan.kind === "switch" && left >= MIN_RETRY_MINUTES;
            const reason = retry
                ? plan.reason
                : plan.kind === "switch"
                  ? `only ${left} minutes of the budget left`
                  : `exec never waits for a reset (${plan.reason})`;
            const to = plan.kind === "switch" ? plan.model : null;
            const note = `${choice.model ?? "the omp default"} hit a rate/usage limit; ${retry ? `retrying once on ${to}` : "no retry"} (${reason})`;
            warn(`exec: ${note}`);
            updateRun(jawan.id, (record) => {
                record.fallback = {
                    at: at.toISOString(),
                    from: choice.model,
                    to: retry ? to : null,
                    tier: retry && plan.kind === "switch" ? plan.tier : null,
                    waitedMinutes: 0,
                    reason,
                };
                if (retry && plan.kind === "switch") {
                    record.model = plan.model;
                    record.tier = plan.tier;
                }
            });
            if (retry && plan.kind === "switch") result = await attempt(plan.model, left);
        }
        ({ code, timedOut } = result);
        usage = parseUsage(result.output);
        return code;
    } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        throw caught;
    } finally {
        removeRun(runId);
        updateRun(jawan.id, (record) => {
            record.exitCode = code;
            record.endedAt = now().toISOString();
            if (usage !== null) record.usage = usage;
            if (record.status === "killed") return;
            record.status = code === 0 && !timedOut && error === null ? "done" : "failed";
            if (error !== null) record.error = error;
            else if (timedOut) record.error = `timed out after ${maxMinutes + KILL_MARGIN_MINUTES} minutes`;
        });
    }
}

/**
 * `toli remote <machine|auto> "<prompt>" [--project <name>] [--task T<n>] [--max-time <minutes>] [--tier t] [--work w]`.
 * The tier and work type (from the flags, else the task's tier and shape) travel to the target's `exec`, which picks
 * the model with its own harness config; a `Tier:` line in the prompt travels inside it.
 */
export async function remoteCommand(argv: string[]): Promise<number> {
    const args = new Args(argv, { values: ["project", "task", "max-time", "tier", "work"] });
    args.maxPositional(2);
    const requested = args.pos(0, "machine");
    const prompt = args.pos(1, "prompt");
    const projectName = args.str("project");
    if (projectName !== undefined) requireName("project", projectName);
    const taskId = args.str("task");
    if (taskId !== undefined) requireName("task", taskId);
    const maxMinutes = parseMinutes(args.str("max-time")) ?? DEFAULT_EXEC_MAX_MINUTES;
    const tierName = args.str("tier");
    const workName = args.str("work");
    const task = taskId === undefined ? undefined : loadBacklog().tasks.find((entry) => entry.id === taskId);
    const tier = parseOptionalTier(tierName) ?? null;
    const taskTier = task?.tier ?? null;
    const work = workName === undefined ? (task?.shape ?? null) : parseWork(workName);
    let targetName = requested;
    if (requested === "auto") {
        const pick = await pickMachine(projectName);
        if (pick.machine === null) {
            out(noCandidateText(pick));
            return 2;
        }
        if (pick.local) {
            out("local");
            return 0;
        }
        targetName = pick.machine;
    }
    const target = fleetMachine(targetName);
    const from = loadMachine().name;
    const startedAt = now();
    const sections: string[] = [];
    let code = 0;
    const url =
        projectName === undefined ? "" : (loadProjects().find((entry) => entry.name === projectName)?.url ?? "");
    if (projectName !== undefined && url !== "") {
        const ensure = run(
            [
                ...sshArgs(target.ssh, 15),
                remoteToliCommand(target.root, `project ensure ${shellQuote(projectName)} ${shellQuote(url)}`),
            ],
            {
                timeoutMs: 15 * 60 * 1000,
            },
        );
        sections.push(`project ensure (exit ${ensure.code}):\n${`${ensure.stdout}${ensure.stderr}`.trimEnd()}`);
        if (ensure.code !== 0) code = ensure.code;
    }
    if (code === 0) {
        const result = run(
            [
                ...sshArgs(target.ssh, 15),
                remoteToliCommand(
                    target.root,
                    `exec --from ${shellQuote(from)}${taskId === undefined ? "" : ` --task ${shellQuote(taskId)}`}`,
                    {
                        ...(projectName === undefined ? {} : { [EXEC_PROJECT_ENV]: projectName }),
                        [EXEC_MAX_MINUTES_ENV]: String(maxMinutes),
                        ...(tier === null ? {} : { [EXEC_TIER_ENV]: tier }),
                        ...(taskTier === null ? {} : { [EXEC_TASK_TIER_ENV]: taskTier }),
                        ...(work === null ? {} : { [EXEC_WORK_ENV]: work }),
                    },
                ),
            ],
            {
                stdin: remotePrompt(from, target.name, prompt, projectName),
                // A minute past the target's own kill, so its exit (and output) still arrives.
                timeoutMs: execKillMs(maxMinutes) + 60_000,
            },
        );
        sections.push(
            [result.stdout.trimEnd(), result.stderr.trim() ? `\n--- stderr ---\n${result.stderr.trimEnd()}` : ""].join(
                "",
            ),
        );
        code = result.code;
    }
    const output = sections.join("\n\n");
    const runsDir = projectName === undefined ? paths.remoteDir() : paths.projectRunsDir(projectName);
    const path = join(runsDir, `${stamp(startedAt)}-${target.name}.md`);
    writeTextAtomic(
        path,
        [
            `# remote ${target.name}`,
            "",
            `- from: ${from}`,
            `- to: ${target.name} (${target.ssh}:${target.root})`,
            ...(projectName === undefined ? [] : [`- project: ${projectName}`]),
            `- started: ${startedAt.toISOString()}`,
            `- finished: ${now().toISOString()}`,
            `- exit: ${code}`,
            "",
            "## Prompt",
            "",
            prompt,
            "",
            "## Output",
            "",
            output,
            "",
        ].join("\n"),
    );
    out(output);
    out(`saved ${path}`);
    return code === 0 ? 0 : 1;
}
