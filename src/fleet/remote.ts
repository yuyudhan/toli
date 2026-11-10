// `bin/toli remote`: dispatch a prompt to another fleet machine over ssh, where `bin/toli exec` (src/fleet/exec.ts)
// runs it in headless omp, recorded as a jawan run, on the model that machine's tiers pick.
import { join } from "node:path";
import { Args, parseMinutes } from "../core/args.ts";
import { fleetMachine, loadMachine, remoteToliCommand, sshArgs } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { persona } from "../core/persona.ts";
import { now, out, requireName, run, shellQuote, stamp, writeTextAtomic } from "../core/util.ts";
import { parseWork } from "../harness/harness.ts";
import { parseOptionalTier } from "../harness/models.ts";
import { loadProjects } from "../projects/projects.ts";
import { loadBacklog } from "../records/backlog.ts";
import { noCandidateText, pickMachine } from "./pick.ts";

export const REMOTE_HEADER = "[toli remote from ";

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

/** Past an explicit `remote`/`exec` `--max-time` (omp's own limit), the run is killed this much later. */
export const KILL_MARGIN_MINUTES = 5;
/**
 * `remote` hands its `--max-time`, `--project`, `--tier` and `--work` to `exec` through these variables rather than
 * flags, so dispatching to a machine on an older toli still works: its `exec` ignores them and keeps its own limit and
 * model. The target resolves the tier or work type to a model with its own harness config.
 */
export const EXEC_MAX_MINUTES_ENV = "TOLI_EXEC_MAX_MINUTES";
export const EXEC_PROJECT_ENV = "TOLI_EXEC_PROJECT";
export const EXEC_TIER_ENV = "TOLI_EXEC_TIER";
export const EXEC_WORK_ENV = "TOLI_EXEC_WORK";
/** The task's tier, which ranks below the prompt's Tier: line (unlike `--tier`). */
export const EXEC_TASK_TIER_ENV = "TOLI_EXEC_TASK_TIER";
/** Milliseconds after which a run with an explicit omp limit of `maxMinutes` is killed; none without a limit. */
export function execKillMs(maxMinutes: number | null): number | undefined {
    return maxMinutes === null ? undefined : (maxMinutes + KILL_MARGIN_MINUTES) * 60 * 1000;
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
    const maxMinutes = parseMinutes(args.str("max-time")) ?? null;
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
                        ...(maxMinutes === null ? {} : { [EXEC_MAX_MINUTES_ENV]: String(maxMinutes) }),
                        ...(tier === null ? {} : { [EXEC_TIER_ENV]: tier }),
                        ...(taskTier === null ? {} : { [EXEC_TASK_TIER_ENV]: taskTier }),
                        ...(work === null ? {} : { [EXEC_WORK_ENV]: work }),
                    },
                ),
            ],
            {
                stdin: remotePrompt(from, target.name, prompt, projectName),
                // A minute past the target's own kill, so its exit (and output) still arrives; none without a limit.
                ...(maxMinutes === null ? {} : { timeoutMs: (execKillMs(maxMinutes) ?? 0) + 60_000 }),
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
            ...(taskId === undefined ? [] : [`- task: ${taskId.toUpperCase()}`]),
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
