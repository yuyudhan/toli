import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Args, parseMinutes } from "../core/args.ts";
import {
    fleetMachine,
    loadMachine,
    type Machine,
    machineSettings,
    otherFleetMachines,
    remoteToliCommand,
    sshArgs,
} from "../core/config.ts";
import { currentBranch, git } from "../core/git.ts";
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
    ToliError,
    warn,
    writeJsonAtomic,
    writeTextAtomic,
} from "../core/util.ts";
import { headlessOmpArgs } from "../harness/harness.ts";
import { runHook, seedLocal } from "../helpers/local.ts";
import { recordRun } from "../jawans/launch.ts";
import { updateRun } from "../jawans/runs.ts";
import { loadProjects } from "../projects/projects.ts";
import { ISSUED_BY_ENV, ISSUED_TASK_ENV } from "../records/push-log.ts";
import { activeRuntime, syncRuntime } from "../release/runtime.ts";
import { upgradeCommand } from "../release/upgrade.ts";
import { keepDiskBeforeWork } from "./disk.ts";
import { noCandidateText, pickMachine } from "./pick.ts";
import { registerRun, removeRun } from "./resources.ts";

export function initCommand(argv: string[]): void {
    const args = new Args(argv, { values: ["name", "role", "coordinator-ssh", "coordinator-root"] });
    args.maxPositional(0);
    const name = requireName("machine", args.str("name"));
    const role = args.str("role");
    if (role !== "coordinator" && role !== "worker") throw new ToliError("--role must be coordinator or worker");
    const coordinatorSsh = args.str("coordinator-ssh");
    const coordinatorRoot = args.str("coordinator-root");
    // Re-running init (e.g. setup resuming half-done) keeps every other setting: capacity, harness, retention.
    const machine: Machine = { ...machineSettings(), name, role };
    delete machine.coordinator;
    if (role === "worker") {
        if (!coordinatorSsh || !coordinatorRoot)
            throw new ToliError("a worker needs --coordinator-ssh <host> --coordinator-root <path>");
        machine.coordinator = { ssh: coordinatorSsh, root: coordinatorRoot };
    } else if (coordinatorSsh || coordinatorRoot) {
        throw new ToliError("--coordinator-ssh/--coordinator-root apply to workers only");
    }
    for (const dir of ["config", "data", "state", "logs", "projects"])
        mkdirSync(join(paths.root(), dir), { recursive: true });
    writeJsonAtomic(paths.machine(), machine);
    if (!existsSync(paths.fleet())) writeJsonAtomic(paths.fleet(), { machines: [] });
    seedLocal();
    out(
        `initialized ${name} as ${role}${machine.coordinator ? ` (coordinator ${machine.coordinator.ssh}:${machine.coordinator.root})` : ""}`,
    );
    runHook("post-init");
}

/**
 * Bring this checkout up to date. A development clone (on a branch) pulls fast-forward; a release install (detached
 * HEAD, at a vX.Y.Z tag) follows release tags, so it upgrades to the latest one instead (`bin/toli upgrade`).
 */
async function syncLocal(): Promise<number> {
    const root = paths.root();
    const name = loadMachine().name;
    if (currentBranch(root) === null) {
        out(`${name}: release install (detached HEAD): bin/toli upgrade`);
        return await upgradeCommand([]);
    }
    const dirty = git(root, ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty.code !== 0) throw new ToliError(`git status failed in ${root}: ${dirty.stderr.trim()}`);
    if (dirty.stdout.trim() !== "")
        throw new ToliError(`refusing to sync: ${root} has uncommitted changes:\n${dirty.stdout.trimEnd()}`);
    const pull = git(root, ["pull", "--ff-only"]);
    if (pull.code !== 0)
        throw new ToliError(`git pull --ff-only failed (not a fast-forward?): ${(pull.stderr || pull.stdout).trim()}`);
    out(`${name}: ${pull.stdout.trim() || "up to date"}`);
    // The live session runs the installed runtime (src/release/runtime.ts): move it to the pulled code.
    if (activeRuntime(root) !== null) {
        try {
            out(`${name}: runtime ${syncRuntime(root).commit.slice(0, 12)}`);
        } catch (error) {
            warn(
                `toli: pulled, but the runtime stays on the previous commit: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
    return 0;
}

export async function syncCommand(argv: string[]): Promise<number> {
    const args = new Args(argv, { booleans: ["all"] });
    args.maxPositional(0);
    const local = await syncLocal();
    if (local !== 0 || !args.bool("all")) return local;
    let failures = 0;
    for (const machine of otherFleetMachines()) {
        // A release install's sync is an upgrade (fetch, migrate, harness sync, runtime snapshot): allow it time.
        const result = run([...sshArgs(machine.ssh, 15), remoteToliCommand(machine.root, "sync")], {
            timeoutMs: 300_000,
        });
        if (result.code === 0) {
            out(result.stdout.trimEnd() || `${machine.name}: synced`);
        } else {
            failures += 1;
            warn(`${machine.name}: sync failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`);
        }
    }
    return failures === 0 ? 0 : 1;
}

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
 * `remote` hands its `--max-time` and `--project` to `exec` through these variables rather than flags, so dispatching
 * to a machine on an older toli still works: its `exec` ignores them and keeps its own limit.
 */
const EXEC_MAX_MINUTES_ENV = "TOLI_EXEC_MAX_MINUTES";
const EXEC_PROJECT_ENV = "TOLI_EXEC_PROJECT";

/** Milliseconds after which a run with an omp budget of `maxMinutes` is killed. */
export function execKillMs(maxMinutes: number): number {
    return (maxMinutes + KILL_MARGIN_MINUTES) * 60 * 1000;
}

/**
 * `toli exec`: run the stdin prompt in headless omp here. It is recorded as a jawan run (state/jawans/, so `runs`,
 * `digest` and the jawan slots see it) and counted as load (state/runs/) for its lifetime; its output streams back
 * to the caller and into the run's output.log, and the run ends done or failed with omp's exit. The run carries the
 * issuing machine and task in its environment, so a `bin/toli push` in it is logged as theirs. omp gets
 * `TOLI_EXEC_MAX_MINUTES` minutes (default 180, set by `bin/toli remote --max-time`) and is killed 5 minutes later.
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
    keepDiskBeforeWork();
    const maxTime = `${maxMinutes}m`;
    const jawan = recordRun(
        {
            harness: "omp",
            task,
            project,
            work: null,
            model: null,
            cwd: paths.root(),
            maxMinutes,
            baseBrief: prompt,
            extra: "",
        },
        { argv: headlessOmpArgs("<brief>", paths.root(), maxTime), ownerPid: process.pid },
    );
    warn(`exec: recorded as run ${jawan.id} on ${machine.name} (from ${from})`);
    const runId = `exec-${stamp()}-${process.pid}`;
    registerRun({
        runId,
        pid: process.pid,
        from,
        task,
        startedAt: now().toISOString(),
        title: runTitle(prompt),
    });
    let code = 1;
    let timedOut = false;
    let error: string | null = null;
    try {
        ({ code, timedOut } = await runTee(headlessOmpArgs(prompt, paths.root(), maxTime), jawan.logPath, {
            cwd: paths.root(),
            timeoutMs: execKillMs(maxMinutes),
            env: { [ISSUED_BY_ENV]: from, [ISSUED_TASK_ENV]: task ?? undefined },
            onStart: (pid) => {
                updateRun(jawan.id, (record) => {
                    record.pid = pid;
                });
            },
        }));
        return code;
    } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        throw caught;
    } finally {
        removeRun(runId);
        updateRun(jawan.id, (record) => {
            record.exitCode = code;
            record.endedAt = now().toISOString();
            if (record.status === "killed") return;
            record.status = code === 0 && !timedOut && error === null ? "done" : "failed";
            if (error !== null) record.error = error;
            else if (timedOut) record.error = `timed out after ${maxMinutes + KILL_MARGIN_MINUTES} minutes`;
        });
    }
}

/** `toli remote <machine|auto> "<prompt>" [--project <name>] [--task T<n>] [--max-time <minutes>]`. */
export async function remoteCommand(argv: string[]): Promise<number> {
    const args = new Args(argv, { values: ["project", "task", "max-time"] });
    args.maxPositional(2);
    const requested = args.pos(0, "machine");
    const prompt = args.pos(1, "prompt");
    const projectName = args.str("project");
    if (projectName !== undefined) requireName("project", projectName);
    const taskId = args.str("task");
    if (taskId !== undefined) requireName("task", taskId);
    const maxMinutes = parseMinutes(args.str("max-time")) ?? DEFAULT_EXEC_MAX_MINUTES;
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
