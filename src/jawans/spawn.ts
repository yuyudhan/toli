// `bin/toli spawn`: run one jawan on any harness as a detached background process, so the lead never waits.
//
// spawn validates the brief, writes the run record (state/jawans/<runId>.json, src/jawans/runs.ts) and the run dir (the
// project's data/projects/<p>/runs/<runId>/, or state/jawans/<runId>/ without a project), and either starts a detached
// supervisor (`bin/toli run supervise <runId>`, src/jawans/supervise.ts) or, with every jawan slot busy
// (capacity.maxRuns), leaves the run queued to start when one frees (src/jawans/launch.ts). It returns at once.
import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Args, parseMinutes } from "../core/args.ts";
import { loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { out, printJson, ToliError, warn } from "../core/util.ts";
import {
    defaultHarness,
    type Harness,
    harnessConfig,
    parseHarness,
    parseWork,
    requireInstalled,
    type WorkType,
} from "../harness/harness.ts";
import {
    briefTier,
    choiceText,
    type ModelChoice,
    parseOptionalTier,
    resolveModel,
    type Tier,
    usageText,
} from "../harness/models.ts";
import { findProject } from "../projects/projects.ts";
import { prepareWorkspace, workspaceBrief } from "../projects/workspace.ts";
import { loadBacklog } from "../records/backlog.ts";
import { jawanSlots, startOrQueue } from "./launch.ts";
import { activeRuns, type JawanRun, killRun, listRuns, loadRun, modelText, runLine, updateRun } from "./runs.ts";
import { superviseRun } from "./supervise.ts";

const BRIEF_HEADER = "TOLI_BRIEF v1";
const DEFAULT_MAX_MINUTES = 120;

export type SpawnOptions = {
    harness?: Harness | undefined;
    /** Required to spawn; `--dry-run` may leave it out (no brief, so no Tier: line). */
    briefPath: string | undefined;
    task?: string | undefined;
    project?: string | undefined;
    model?: string | undefined;
    /** `--tier`: the model tier, below --model and above the brief's Tier: line (src/harness/models.ts). */
    tier?: Tier | undefined;
    work?: WorkType | undefined;
    cwd?: string | undefined;
    maxMinutes?: number | undefined;
    /** Start even when every jawan slot is busy (the lead's explicit `--now`). */
    now?: boolean | undefined;
    /** Supersede the task's live run (stopped as `run kill` does) instead of refusing (`--replace`). */
    replace?: boolean | undefined;
};

function readBrief(path: string): string {
    if (!existsSync(path) || !statSync(path).isFile()) throw new ToliError(`brief file not found: ${path}`);
    const brief = readFileSync(path, "utf8");
    if ((brief.split("\n", 1)[0] ?? "").trim() !== BRIEF_HEADER)
        throw new ToliError(`the brief's first line must be "${BRIEF_HEADER}" (see docs/brief-template.md): ${path}`);
    return brief;
}

/** What a spawn resolves to; nothing is written (`spawn --dry-run` prints it). */
export type SpawnPlan = {
    harness: Harness;
    brief: string;
    task: string | null;
    project: string | null;
    work: WorkType | null;
    choice: ModelChoice;
    cwd: string;
};

/** Resolve options against the backlog, project registry and harness config; nothing is written. */
export function planSpawn(options: SpawnOptions): SpawnPlan {
    const brief = options.briefPath === undefined ? "" : readBrief(options.briefPath);
    let project = options.project ?? null;
    let work = options.work ?? null;
    let taskTier: Tier | null = null;
    const taskId = options.task ?? null;
    if (taskId !== null) {
        const task = loadBacklog().tasks.find((entry) => entry.id === taskId);
        if (!task) throw new ToliError(`unknown task "${taskId}" (see \`bin/toli task list\`)`);
        if (project !== null && project !== task.project)
            throw new ToliError(`${taskId} belongs to project ${task.project}, not ${project}`);
        project = task.project;
        work ??= task.shape;
        taskTier = task.tier ?? null;
    }
    let cwd: string;
    if (project !== null) {
        if (options.cwd !== undefined)
            throw new ToliError("--cwd cannot be combined with a project (the jawan runs in its clone)");
        findProject(project);
        cwd = paths.projectDir(project);
        if (!existsSync(cwd))
            throw new ToliError(`projects/${project} is not cloned on this machine (bin/toli project ensure)`);
    } else {
        cwd = options.cwd === undefined ? paths.root() : resolve(options.cwd);
        if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new ToliError(`--cwd is not a directory: ${cwd}`);
    }
    const harness = options.harness ?? defaultHarness(work ?? undefined);
    requireInstalled(harness);
    const choice = resolveModel(
        harness,
        { model: options.model, tier: options.tier, briefTier: briefTier(brief), taskTier, work },
        harnessConfig(),
    );
    return { harness, brief, task: taskId, project, work, choice, cwd };
}

/**
 * The task's live runs (queued, starting or running) on this machine. listRuns first records runs whose supervisor
 * died as failed, so a dead run left marked running never counts. Without `replace` a live run refuses the spawn: the
 * lead steers it instead of starting a second jawan on the same copy. With `replace` each is stopped as `run kill`
 * does; the ids are returned for the replacement's record.
 */
function supersedeLiveRuns(task: string, replace: boolean): string[] {
    const live = activeRuns().filter((run) => run.task === task);
    if (live.length === 0) return [];
    if (!replace) {
        const names = live.map((run) => `${run.id} (${run.status})`).join(", ");
        const first = live[0]?.id ?? "";
        throw new ToliError(
            `${task} already has a live jawan: ${names}. Steer it with \`write agent://${first}\`, or pass --replace to stop it and start this one`,
        );
    }
    return live.map((run) => killRun(run.id).id);
}

/**
 * Record one jawan run and return it: started detached (status `starting`, supervisor pid set) when a jawan slot is
 * free or `now` is set, otherwise `queued` until one frees. A non-scout task first gets its workspace per the
 * project's strategy (branch switched or worktree added), the jawan runs there, and the brief gains a Workspace block
 * naming the path and branch.
 */
export function spawnJawan(options: SpawnOptions): JawanRun {
    if (options.briefPath === undefined) throw new ToliError("spawn needs --brief <file>");
    const resolved = planSpawn(options);
    loadMachine();
    const replaced = resolved.task === null ? [] : supersedeLiveRuns(resolved.task, options.replace === true);
    // Ship briefs carry a goal contract (docs/brief-template.md `## Goal`); a missing one is warned about, not refused.
    if (resolved.work === "ship" && !/^## Goal\b/m.test(resolved.brief))
        warn(
            `the ship brief ${options.briefPath} has no "## Goal" section (Objective, Validate, Stop when; docs/brief-template.md); spawning anyway`,
        );
    if (resolved.task !== null && resolved.project !== null && resolved.work !== "scout") {
        const workspace = prepareWorkspace(resolved.task);
        resolved.cwd = workspace.path;
        resolved.brief = `${resolved.brief.trimEnd()}\n${workspaceBrief(resolved.project, resolved.task, workspace)}`;
    }
    const run = startOrQueue(
        {
            harness: resolved.harness,
            task: resolved.task,
            project: resolved.project,
            work: resolved.work,
            model: resolved.choice.model,
            tier: resolved.choice.tier,
            modelSource: resolved.choice.source,
            cwd: resolved.cwd,
            maxMinutes: options.maxMinutes ?? DEFAULT_MAX_MINUTES,
            baseBrief: resolved.brief,
            extra: "",
            ...(replaced.length === 0 ? {} : { replaces: replaced }),
        },
        { now: options.now === true },
    );
    for (const id of replaced)
        updateRun(id, (record) => {
            record.replacedBy = run.id;
        });
    return run;
}

/** `toli spawn --brief <file> [--harness h] [--task T<n>] [--project p] [--model m] [--tier t] [--work w] [--cwd d] [--max-time min] [--now] [--replace] [--dry-run]`. */
export function spawnCommand(argv: string[]): void {
    const args = new Args(argv, {
        booleans: ["json", "now", "replace", "dry-run"],
        values: ["harness", "brief", "task", "project", "model", "tier", "work", "cwd", "max-time"],
    });
    args.maxPositional(0);
    const briefPath = args.str("brief");
    const harnessName = args.str("harness");
    const workName = args.str("work");
    const tierName = args.str("tier");
    const options: SpawnOptions = {
        harness: harnessName === undefined ? undefined : parseHarness(harnessName),
        briefPath,
        task: args.str("task"),
        project: args.str("project"),
        model: args.str("model"),
        tier: parseOptionalTier(tierName),
        work: workName === undefined ? undefined : parseWork(workName),
        cwd: args.str("cwd"),
        maxMinutes: parseMinutes(args.str("max-time")),
        now: args.bool("now"),
        replace: args.bool("replace"),
    };
    if (args.bool("dry-run")) {
        const plan = planSpawn(options);
        const { brief: _brief, ...shown } = plan;
        if (args.bool("json")) printJson(shown);
        else
            out(
                `would spawn: ${plan.harness} ${choiceText(plan.choice)}, work ${plan.work ?? "-"}, in ${plan.cwd}${plan.task === null ? "" : ` for ${plan.task}`}`,
            );
        return;
    }
    const run = spawnJawan(options);
    if (args.bool("json")) {
        printJson(run);
        return;
    }
    if (run.replaces !== undefined) out(`replaced ${run.replaces.join(", ")} (stopped as \`bin/toli run kill\` does)`);
    if (run.status === "queued")
        out(
            `queued ${run.id}: all ${jawanSlots()} jawan slots (capacity.maxRuns) are busy; it starts when one frees (\`bin/toli runs\`). Log ${relative(paths.root(), run.logPath)}`,
        );
    else
        out(
            `spawned ${run.id}: ${modelText(run)} in ${run.cwd} (supervisor pid ${run.supervisorPid}); log ${relative(paths.root(), run.logPath)}`,
        );
    out("The outcome arrives in the inbox (and the chat) when it finishes; `bin/toli run status <id>` meanwhile.");
}

/** `toli runs [--json] [--active]`. */
export function runsCommand(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json", "active"] });
    args.maxPositional(0);
    const runs = args.bool("active") ? activeRuns() : listRuns();
    if (args.bool("json")) {
        printJson(runs);
        return;
    }
    if (runs.length === 0) {
        out(args.bool("active") ? "no active jawan runs" : "no jawan runs");
        return;
    }
    for (const run of runs) out(runLine(run));
}

/** `toli run status|log|kill <id>` and the internal `run supervise <id>`. */
export async function runCommand(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;
    switch (sub) {
        case "status": {
            const args = new Args(rest, { booleans: ["json"] });
            args.maxPositional(1);
            const id = args.pos(0, "run id");
            listRuns();
            const run = loadRun(id);
            if (args.bool("json")) printJson(run);
            else
                out(
                    [
                        runLine(run),
                        `model: ${choiceText({ model: run.model, tier: run.tier ?? null, ...(run.modelSource === undefined ? {} : { source: run.modelSource }) })}`,
                        ...(run.fallback === undefined
                            ? []
                            : [
                                  `limit fallback: ${run.fallback.from ?? "default"} -> ${run.fallback.to ?? "default"}${run.fallback.waitedMinutes > 0 ? ` after waiting ${run.fallback.waitedMinutes}m` : ""} (${run.fallback.reason})`,
                              ]),
                        ...(run.usage === undefined ? [] : [`usage: ${usageText(run.usage)}`]),
                        `command: ${run.command}`,
                        `cwd: ${run.cwd}`,
                        `pid: ${run.pid ?? "-"} (supervisor ${run.supervisorPid ?? "-"})`,
                        `exit: ${run.exitCode ?? "-"}${run.signal === null ? "" : ` signal ${run.signal}`}`,
                        ...(run.error === null ? [] : [`error: ${run.error}`]),
                        ...(run.inbox === null ? [] : [`inbox: ${relative(paths.root(), run.inbox)}`]),
                    ].join("\n"),
                );
            return;
        }
        case "log": {
            const args = new Args(rest, { values: ["lines"] });
            args.maxPositional(1);
            const run = loadRun(args.pos(0, "run id"));
            const lines = Number(args.str("lines") ?? "200");
            if (!Number.isInteger(lines) || lines < 1) throw new ToliError("--lines must be a positive whole number");
            const text = existsSync(run.logPath) ? readFileSync(run.logPath, "utf8").trimEnd() : "";
            out(text === "" ? "(no output yet)" : text.split("\n").slice(-lines).join("\n"));
            return;
        }
        case "kill": {
            const args = new Args(rest);
            args.maxPositional(1);
            const run = killRun(args.pos(0, "run id"));
            if (run.pid === null && run.supervisorPid === null)
                out(`killed ${run.id} (${run.harness}) before it started`);
            else out(`killing ${run.id} (${run.harness}); its outcome is posted to the inbox when it stops`);
            return;
        }
        case "supervise": {
            const args = new Args(rest);
            args.maxPositional(1);
            await superviseRun(args.pos(0, "run id"));
            return;
        }
        default:
            throw new ToliError("usage: toli run status|log|kill <id>");
    }
}
