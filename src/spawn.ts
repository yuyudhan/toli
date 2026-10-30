// `bin/toli spawn`: run one jawan on any harness as a detached background process, so the lead never waits.
//
// spawn validates the brief, writes the run record (state/jawans/<runId>.json, src/runs.ts) and the run dir (the
// project's data/projects/<p>/runs/<runId>/, or state/jawans/<runId>/ without a project), starts a detached
// supervisor (`bin/toli run supervise <runId>`, src/supervise.ts) and returns at once.
import { spawn as spawnChild } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Args } from "./args.ts";
import { loadBacklog, updateTask } from "./backlog.ts";
import { loadMachine } from "./config.ts";
import {
    defaultHarness,
    type Harness,
    harnessConfig,
    headlessCommand,
    parseHarness,
    requireInstalled,
    WORK_TYPES,
    type WorkType,
} from "./harness.ts";
import { paths } from "./paths.ts";
import { findProject } from "./projects.ts";
import { activeRuns, type JawanRun, killRun, listRuns, loadRun, runLine, updateRun } from "./runs.ts";
import { superviseRun } from "./supervise.ts";
import { now, out, printJson, ToliError, writeJsonAtomic } from "./util.ts";
import { prepareWorkspace, workspaceBrief } from "./workspace.ts";

const BRIEF_HEADER = "TOLI_BRIEF v1";
const DEFAULT_MAX_MINUTES = 120;
/** This checkout's CLI (not paths.toliBin(): TOLI_ROOT may point the data elsewhere, as in tests). */
const TOLI_SCRIPT = resolve(import.meta.dir, "..", "bin", "toli");

function newRunId(at: Date): string {
    const compact = at.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    return `j-${compact}-${crypto.randomUUID().slice(0, 4)}`;
}

export type SpawnOptions = {
    harness?: Harness | undefined;
    briefPath: string;
    task?: string | undefined;
    project?: string | undefined;
    model?: string | undefined;
    work?: WorkType | undefined;
    cwd?: string | undefined;
    maxMinutes?: number | undefined;
};

function readBrief(path: string): string {
    if (!existsSync(path) || !statSync(path).isFile()) throw new ToliError(`brief file not found: ${path}`);
    const brief = readFileSync(path, "utf8");
    if ((brief.split("\n", 1)[0] ?? "").trim() !== BRIEF_HEADER)
        throw new ToliError(`the brief's first line must be "${BRIEF_HEADER}" (see docs/brief-template.md): ${path}`);
    return brief;
}

/** Resolve options against the backlog, project registry and harness config; nothing is written. */
function plan(options: SpawnOptions): {
    harness: Harness;
    brief: string;
    task: string | null;
    project: string | null;
    work: WorkType | null;
    model: string | null;
    cwd: string;
} {
    const brief = readBrief(options.briefPath);
    let project = options.project ?? null;
    let work = options.work ?? null;
    const taskId = options.task ?? null;
    if (taskId !== null) {
        const task = loadBacklog().tasks.find((entry) => entry.id === taskId);
        if (!task) throw new ToliError(`unknown task "${taskId}" (see \`bin/toli task list\`)`);
        if (project !== null && project !== task.project)
            throw new ToliError(`${taskId} belongs to project ${task.project}, not ${project}`);
        project = task.project;
        work ??= task.shape;
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
    const model = options.model ?? harnessConfig().models?.[harness] ?? null;
    return { harness, brief, task: taskId, project, work, model, cwd };
}

/**
 * Start one jawan run detached and return its record (status `starting`, supervisor pid set). A non-scout task first
 * gets its workspace per the project's strategy (branch switched or worktree added), the jawan runs there, and the
 * brief gains a Workspace block naming the path and branch.
 */
export function spawnJawan(options: SpawnOptions): JawanRun {
    const resolved = plan(options);
    loadMachine();
    if (resolved.task !== null && resolved.project !== null && resolved.work !== "scout") {
        const workspace = prepareWorkspace(resolved.task);
        resolved.cwd = workspace.path;
        resolved.brief = `${resolved.brief.trimEnd()}\n${workspaceBrief(resolved.project, resolved.task, workspace)}`;
    }
    const maxMinutes = options.maxMinutes ?? DEFAULT_MAX_MINUTES;
    const startedAt = now();
    const id = newRunId(startedAt);
    const runDir =
        resolved.project === null ? join(paths.jawansDir(), id) : join(paths.projectRunsDir(resolved.project), id);
    mkdirSync(runDir, { recursive: true });
    const briefPath = join(runDir, "brief.md");
    writeFileSync(briefPath, resolved.brief);
    const command = headlessCommand(resolved.harness, {
        brief: resolved.brief,
        cwd: resolved.cwd,
        root: paths.root(),
        model: resolved.model ?? undefined,
        maxMinutes,
    });
    const run: JawanRun = {
        id,
        harness: resolved.harness,
        task: resolved.task,
        project: resolved.project,
        work: resolved.work,
        model: resolved.model,
        cwd: resolved.cwd,
        runDir,
        briefPath,
        logPath: join(runDir, "output.log"),
        command: [
            ...command.argv.map((word) => (word === resolved.brief ? "<brief>" : word)),
            ...(command.stdin === null ? [] : ["< brief"]),
        ].join(" "),
        maxMinutes,
        status: "starting",
        supervisorPid: null,
        pid: null,
        exitCode: null,
        signal: null,
        startedAt: startedAt.toISOString(),
        endedAt: null,
        inbox: null,
        error: null,
    };
    mkdirSync(paths.jawansDir(), { recursive: true });
    writeJsonAtomic(paths.jawanRecord(id), run);
    const supervisorLog = openSync(join(runDir, "supervisor.log"), "a");
    try {
        const supervisor = spawnChild(process.execPath, [TOLI_SCRIPT, "run", "supervise", id], {
            cwd: paths.root(),
            detached: true,
            stdio: ["ignore", supervisorLog, supervisorLog],
        });
        supervisor.unref();
        if (supervisor.pid === undefined) throw new ToliError(`could not start the supervisor for ${id}`);
        const pid = supervisor.pid;
        const task = resolved.task;
        // The task names its jawan, so the digest can flag active tasks nobody is working on.
        if (task !== null)
            updateTask(task, (entry) => {
                if (entry.status === "queued" || entry.status === "active") {
                    entry.status = "active";
                    entry.startedAt ??= startedAt.toISOString();
                    entry.agent = id;
                }
            });
        return updateRun(id, (record) => {
            record.supervisorPid = pid;
        });
    } finally {
        closeSync(supervisorLog);
    }
}

function parseWork(value: string | undefined): WorkType | undefined {
    if (value === undefined) return undefined;
    if (!(WORK_TYPES as readonly string[]).includes(value))
        throw new ToliError(`--work must be one of ${WORK_TYPES.join(", ")}`);
    return value as WorkType;
}

function parseMinutes(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const minutes = Number(value);
    if (!Number.isInteger(minutes) || minutes < 1) throw new ToliError("--max-time must be a whole number of minutes");
    return minutes;
}

/** `toli spawn --brief <file> [--harness h] [--task T<n>] [--project p] [--model m] [--work w] [--cwd d] [--max-time min]`. */
export function spawnCommand(argv: string[]): void {
    const args = new Args(argv, {
        booleans: ["json"],
        values: ["harness", "brief", "task", "project", "model", "work", "cwd", "max-time"],
    });
    args.maxPositional(0);
    const briefPath = args.str("brief");
    if (briefPath === undefined) throw new ToliError("spawn needs --brief <file>");
    const harnessName = args.str("harness");
    const run = spawnJawan({
        harness: harnessName === undefined ? undefined : parseHarness(harnessName),
        briefPath,
        task: args.str("task"),
        project: args.str("project"),
        model: args.str("model"),
        work: parseWork(args.str("work")),
        cwd: args.str("cwd"),
        maxMinutes: parseMinutes(args.str("max-time")),
    });
    if (args.bool("json")) {
        printJson(run);
        return;
    }
    out(
        `spawned ${run.id}: ${run.harness} in ${run.cwd} (supervisor pid ${run.supervisorPid}); log ${relative(paths.root(), run.logPath)}`,
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
            out(`killing ${run.id} (${run.harness}); its outcome is posted to the inbox when it stops`);
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
