// `bin/toli spawn`: run one jawan on any harness as a detached background process, so the lead never waits.
//
// spawn validates the brief, writes the run record (state/jawans/<runId>.json, src/jawans/runs.ts) and the run dir (the
// project's data/projects/<p>/runs/<runId>/, or state/jawans/<runId>/ without a project), and either starts a detached
// supervisor (`bin/toli run supervise <runId>`, src/jawans/supervise.ts) or, with every jawan slot busy
// (capacity.maxRuns) or the model API host not resolving (src/jawans/network.ts), leaves the run queued to start when
// it can (src/jawans/launch.ts). It returns at once.
import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Args, parseMinutes } from "../core/args.ts";
import { loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { out, printJson, ToliError, warn } from "../core/util.ts";
import { currentDiskHold, diskHoldText } from "../fleet/disk-hold.ts";
import { refuseHeadlessDispatch } from "../fleet/dispatch.ts";
import { refuseHeadlessSpawnWhenFull } from "../fleet/full.ts";
import { agentName } from "../harness/agents.ts";
import { defaultHarness, type Harness, harnessConfig, parseHarness, requireInstalled } from "../harness/harness.ts";
import { usageText } from "../harness/limit-output.ts";
import { modelCatalog } from "../harness/model-catalog.ts";
import {
    briefTier,
    briefWork,
    choiceText,
    type ModelChoice,
    parseOptionalTier,
    parseWork,
    resolveModel,
    type Tier,
    type WorkType,
} from "../harness/models.ts";
import { findProject, isLiveStack } from "../projects/projects.ts";
import { plannedWorkspacePath, prepareWorkspace } from "../projects/workspace.ts";
import { workspaceBrief } from "../projects/workspace-brief.ts";
import { loadBacklog } from "../records/backlog.ts";
import { continueRun } from "./continue.ts";
import { jawanSlots, startOrQueue, stopRun, stopRunLocked } from "./launch.ts";
import { heldHost } from "./network.ts";
import { briefStallMinutes } from "./progress.ts";
import {
    ACTIVE,
    activeRuns,
    type JawanRun,
    listRuns,
    loadRun,
    modelText,
    runLine,
    runLines,
    updateRun,
} from "./runs.ts";
import { superviseRun } from "./supervise.ts";
import { refuseOwnedTag } from "./tag-owner.ts";

const BRIEF_HEADER = "TOLI_BRIEF v1";

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
    /** Queue ahead of the runs queued without it, behind earlier `--first` ones (`--first`); nothing running stops. */
    first?: boolean | undefined;
    /** Supersede the task's live run (stopped as `run kill` does) instead of refusing (`--replace`). */
    replace?: boolean | undefined;
    /** A section added after the brief (and its Workspace block): toli's re-dispatch of a dead run's task. */
    extra?: string | undefined;
    /** The release tag a release catch-up run merges (src/projects/catch-up.ts); it then owns that tag on its clone. */
    catchUp?: string | undefined;
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
    let work = options.work ?? briefWork(brief);
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
    // A malformed Stall: line fails here, before a workspace or run is created (recordRun applies it).
    briefStallMinutes(brief);
    requireInstalled(harness);
    const choice = resolveModel(
        harness,
        { model: options.model, tier: options.tier, briefTier: briefTier(brief), taskTier, work },
        harnessConfig(),
        modelCatalog(harness),
    );
    return { harness, brief, task: taskId, project, work, choice, cwd };
}

/**
 * The task's live runs (queued, starting or running) on this machine, for `replace` to stop once nothing else refuses
 * the spawn. listRuns first records runs whose supervisor died as failed, so a dead run left marked running never
 * counts. Without `replace` a live run refuses the spawn: the lead steers it instead of starting a second jawan on the
 * same copy.
 */
function liveRunsToReplace(task: string, replace: boolean): JawanRun[] {
    const live = activeRuns().filter((run) => run.task === task);
    if (live.length > 0 && !replace) {
        const names = live.map((run) => `${run.id} (${run.status})`).join(", ");
        const first = live[0]?.id ?? "";
        throw new ToliError(
            `${task} already has a live jawan: ${names}. Steer it with \`write agent://${first}\`, or pass --replace to stop it and start this one`,
        );
    }
    return live;
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
    const superseded = resolved.task === null ? [] : liveRunsToReplace(resolved.task, options.replace === true);
    // A non-scout task run works in its task's workspace, prepared below.
    const own = resolved.project !== null && resolved.work !== "scout" ? resolved.task : null;
    // One merge run per release tag and clone (src/jawans/tag-owner.ts): asked where the run will work before its
    // workspace is prepared (a refused spawn never switched the shared clone), and again under the slots lock.
    const where = own === null ? resolved.cwd : plannedWorkspacePath(own);
    const claim = { project: resolved.project, cwd: where, brief: resolved.brief, catchUp: options.catchUp };
    refuseOwnedTag(claim);
    // Ship briefs carry a goal contract (docs/brief-template.md `## Goal`); a missing one is warned about, not refused.
    if (resolved.work === "ship" && !/^## Goal\b/m.test(resolved.brief))
        warn(
            `the ship brief ${options.briefPath} has no "## Goal" section (Objective, Validate, Stop when; docs/brief-template.md); spawning anyway`,
        );
    // A live-stack project's code brief carries the live-stack rules (docs/brief-template.md `## Live stack`).
    if (resolved.work !== "scout" && isLiveStack(resolved.project) && !/^## Live stack\b/m.test(resolved.brief))
        warn(
            `${resolved.project} runs in live-stack mode but the brief ${options.briefPath} has no "## Live stack" section (docs/brief-template.md); spawning anyway`,
        );
    if (own !== null && resolved.project !== null) {
        const workspace = prepareWorkspace(own);
        resolved.cwd = workspace.path;
        resolved.brief = `${resolved.brief.trimEnd()}\n${workspaceBrief(resolved.project, own, workspace)}`;
    }
    // `--replace`: the live runs still active are stopped as `run kill` does, under the same lock and only once the
    // claim held there, so a refused spawn never left the task without its jawan; their ids go on the new record.
    const guard = (): { replaces?: string[] } => {
        refuseOwnedTag({ ...claim, cwd: resolved.cwd });
        const live = superseded.filter((entry) => ACTIVE.includes(loadRun(entry.id).status));
        return live.length === 0 ? {} : { replaces: live.map((entry) => stopRunLocked(entry.id).id) };
    };
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
            maxMinutes: options.maxMinutes ?? null,
            baseBrief: resolved.brief,
            extra: options.extra ?? "",
            ...(options.first === true ? { first: true } : {}),
            ...(options.catchUp === undefined ? {} : { catchUp: options.catchUp }),
        },
        { now: options.now === true, guard },
    );
    for (const id of run.replaces ?? [])
        updateRun(id, (record) => {
            record.replacedBy = run.id;
        });
    return run;
}

/** `toli spawn --brief <file> [--harness h] [--task T<n>] [--project p] [--model m] [--tier t] [--work w] [--cwd d] [--max-time min] [--now] [--first] [--replace] [--dry-run]`. */
export function spawnCommand(argv: string[]): void {
    const args = new Args(argv, {
        booleans: ["json", "now", "first", "replace", "dry-run"],
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
        first: args.bool("first"),
        replace: args.bool("replace"),
    };
    if (args.bool("dry-run")) {
        const plan = planSpawn(options);
        const { brief: _brief, ...shown } = plan;
        if (args.bool("json")) printJson(shown);
        else
            out(
                `would spawn: ${plan.harness} ${choiceText(plan.choice)}, work ${plan.work === null ? "-" : `${plan.work} (omp subagent: ${agentName(plan.work)})`}, in ${plan.cwd}${plan.task === null ? "" : ` for ${plan.task}`}`,
            );
        return;
    }
    refuseHeadlessSpawnWhenFull("spawn");
    refuseHeadlessDispatch("spawn");
    const run = spawnJawan(options);
    if (args.bool("json")) {
        printJson(run);
        return;
    }
    if (run.replaces !== undefined) out(`replaced ${run.replaces.join(", ")} (stopped as \`bin/toli run kill\` does)`);
    if (run.status === "queued") {
        const hold = currentDiskHold();
        const host = heldHost();
        const why =
            hold !== null
                ? `${diskHoldText(hold)}; it starts once the disk keeper lifts the pause (\`spawn --now\` starts it anyway)`
                : host !== null
                  ? `the model API host ${host} does not resolve; it starts once it does (\`spawn --now\` starts it anyway)`
                  : `all ${jawanSlots()} jawan slots (capacity.maxRuns) are busy; it starts when one frees`;
        const first = run.first === true ? "; --first: it starts ahead of the runs queued without it" : "";
        out(`queued ${run.id}: ${why}${first} (\`bin/toli runs\`). Log ${relative(paths.root(), run.logPath)}`);
    } else
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
    for (const line of runLines(runs)) out(line);
}

/**
 * `toli resume <run> [--note "<text>"] [--max-time <minutes>] [--now] [--json]`: the lead continues a finished run.
 * An omp run's session is resumed (`omp --resume`) with a short continue prompt plus the note; other harnesses get a
 * fresh run of the brief with a RESUME section. Refuses a run that is still active or already continued.
 */
export function resumeCommand(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json", "now"], values: ["note", "max-time"] });
    args.maxPositional(1);
    refuseHeadlessSpawnWhenFull("resume");
    refuseHeadlessDispatch("resume");
    listRuns();
    const run = loadRun(args.pos(0, "run id"));
    if (ACTIVE.includes(run.status)) throw new ToliError(`refusing: ${run.id} is still ${run.status}`);
    if (run.resumedBy !== undefined) {
        const next = loadRun(run.resumedBy);
        throw new ToliError(
            `refusing: ${run.id} was already continued by ${next.id} (${next.status}); resume that run instead`,
        );
    }
    const maxTime = args.str("max-time");
    const next = continueRun(run, {
        reason: "lead",
        stopped: `ended ${run.status}${run.error === null ? "" : ` (${run.error})`}`,
        cap: null,
        now: args.bool("now"),
        note: args.str("note"),
        ...(maxTime === undefined ? {} : { maxMinutes: parseMinutes(maxTime) ?? null }),
    });
    if (args.bool("json")) {
        printJson(next);
        return;
    }
    const how = next.resumeSession === undefined ? "as a fresh run with a RESUME section" : "in the same session";
    out(
        `${next.status === "queued" ? "queued" : "resumed"} ${run.id} ${how} as ${next.id}; log ${relative(paths.root(), next.logPath)}`,
    );
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
            const run = stopRun(args.pos(0, "run id"));
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
