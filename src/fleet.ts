import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Args } from "./args.ts";
import {
    fleetMachine,
    hasMachine,
    loadMachine,
    type Machine,
    otherFleetMachines,
    remoteToliCommand,
    sshArgs,
} from "./config.ts";
import { git } from "./git.ts";
import { runHook, seedLocal } from "./helper-local.ts";
import { paths } from "./paths.ts";
import { persona } from "./persona.ts";
import { noCandidateText, pickMachine } from "./pick.ts";
import { loadProjects } from "./projects.ts";
import { registerRun, removeRun } from "./resources.ts";
import { headlessOmpArgs } from "./tick.ts";
import {
    now,
    out,
    readStdin,
    requireName,
    run,
    runInherit,
    shellQuote,
    stamp,
    ToliError,
    warn,
    writeJsonAtomic,
    writeTextAtomic,
} from "./util.ts";

export function initCommand(argv: string[]): void {
    const args = new Args(argv, { values: ["name", "role", "coordinator-ssh", "coordinator-root"] });
    args.maxPositional(0);
    const name = requireName("machine", args.str("name"));
    const role = args.str("role");
    if (role !== "coordinator" && role !== "worker") throw new ToliError("--role must be coordinator or worker");
    const coordinatorSsh = args.str("coordinator-ssh");
    const coordinatorRoot = args.str("coordinator-root");
    const machine: Machine = { name, role };
    // Re-running init keeps hand-tuned capacity thresholds.
    const capacity = hasMachine() ? loadMachine().capacity : undefined;
    if (capacity !== undefined) machine.capacity = capacity;
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

function syncLocal(): void {
    const root = paths.root();
    const dirty = git(root, ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty.code !== 0) throw new ToliError(`git status failed in ${root}: ${dirty.stderr.trim()}`);
    if (dirty.stdout.trim() !== "")
        throw new ToliError(`refusing to sync: ${root} has uncommitted changes:\n${dirty.stdout.trimEnd()}`);
    const pull = git(root, ["pull", "--ff-only"]);
    if (pull.code !== 0)
        throw new ToliError(`git pull --ff-only failed (not a fast-forward?): ${(pull.stderr || pull.stdout).trim()}`);
    out(`${loadMachine().name}: ${pull.stdout.trim() || "up to date"}`);
}

export function syncCommand(argv: string[]): number {
    const args = new Args(argv, { booleans: ["all"] });
    args.maxPositional(0);
    syncLocal();
    if (!args.bool("all")) return 0;
    let failures = 0;
    for (const machine of otherFleetMachines()) {
        const result = run([...sshArgs(machine.ssh, 15), remoteToliCommand(machine.root, "sync")], {
            timeoutMs: 120_000,
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
        "never ask questions. Finish by reporting the outcome and the evidence (commands run, results, commit shas).",
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

const EXEC_MAX_TIME = "60m";
const EXEC_KILL_MS = 65 * 60 * 1000;

/** `toli exec`: run the stdin prompt in headless omp here, counted as load via a run record for its lifetime. */
export async function execCommand(argv: string[]): Promise<number> {
    const args = new Args(argv, { values: ["from", "task"] });
    args.maxPositional(0);
    const prompt = readStdin();
    if (prompt.trim() === "") throw new ToliError("exec needs the prompt on stdin");
    const machine = loadMachine();
    const from = requireName("machine", args.str("from") ?? machine.name);
    const runId = `exec-${stamp()}-${process.pid}`;
    registerRun({
        runId,
        pid: process.pid,
        from,
        task: args.str("task") ?? null,
        startedAt: now().toISOString(),
        title: runTitle(prompt),
    });
    try {
        return await runInherit(headlessOmpArgs(prompt, EXEC_MAX_TIME), { cwd: paths.root(), timeoutMs: EXEC_KILL_MS });
    } finally {
        removeRun(runId);
    }
}

/** `toli remote <machine|auto> "<prompt>" [--project <name>]`. */
export async function remoteCommand(argv: string[]): Promise<number> {
    const args = new Args(argv, { values: ["project"] });
    args.maxPositional(2);
    const requested = args.pos(0, "machine");
    const prompt = args.pos(1, "prompt");
    const projectName = args.str("project");
    if (projectName !== undefined) requireName("project", projectName);
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
            [...sshArgs(target.ssh, 15), remoteToliCommand(target.root, `exec --from ${shellQuote(from)}`)],
            {
                stdin: remotePrompt(from, target.name, prompt, projectName),
                timeoutMs: EXEC_KILL_MS + 60_000,
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
