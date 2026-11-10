// The shared task list (docs/sardars.md): every machine's own backlog, read over ssh and cached per machine in
// state/fleet-tasks/<machine>.json. The owner is the only writer of its tasks; a copy here is replaced only by a copy
// taken later, so overlapping refreshes never put an older list back. Fleet-wide ids are `<machine>/T<n>`.
import { existsSync } from "node:fs";
import { Args } from "../core/args.ts";
import {
    type FleetMachine,
    fleetMachine,
    loadMachine,
    otherFleetMachines,
    remoteToliCommand,
    sshArgs,
} from "../core/config.ts";
import { paths } from "../core/paths.ts";
import {
    now,
    out,
    printJson,
    readJson,
    requireName,
    run,
    runAsync,
    shellQuote,
    ToliError,
    withLock,
    writeJsonAtomic,
} from "../core/util.ts";
import { loadBacklog, type Status, type Task } from "./backlog.ts";
import { fleetId, splitFleetId } from "./delegation-report.ts";

/** One machine's task list as last read: `fetchedAt` is when that machine answered; `error` when this refresh failed. */
export type FleetCopy = { machine: string; fetchedAt: string | null; tasks: Task[]; local: boolean; error?: string };

const OPEN: readonly Status[] = ["queued", "active", "held"];
const CONNECT_SECONDS = 10;
const FETCH_CAP_MS = 30_000;

function cached(machine: string): { fetchedAt: string; tasks: Task[] } | null {
    const path = paths.fleetTasksCopy(machine);
    if (!existsSync(path)) return null;
    return readJson<{ fetchedAt: string; tasks: Task[] } | null>(path, null);
}

/** Keep `copy` as the machine's cached list unless the cached one was taken later (rule 3, newest copy wins). */
export function storeCopy(machine: string, fetchedAt: string, tasks: Task[]): boolean {
    return withLock(paths.lock(`fleet-tasks-${machine}`), () => {
        const current = cached(machine);
        if (current !== null && current.fetchedAt > fetchedAt) return false;
        writeJsonAtomic(paths.fleetTasksCopy(machine), { machine, fetchedAt, tasks });
        return true;
    });
}

function isTaskList(value: unknown): value is Task[] {
    return (
        Array.isArray(value) &&
        value.every(
            (entry: unknown) =>
                typeof entry === "object" &&
                entry !== null &&
                typeof Reflect.get(entry, "id") === "string" &&
                typeof Reflect.get(entry, "status") === "string",
        )
    );
}

async function fetchCopy(machine: FleetMachine): Promise<FleetCopy> {
    const fetchedAt = now().toISOString();
    const result = await runAsync(
        [...sshArgs(machine.ssh, CONNECT_SECONDS), remoteToliCommand(machine.root, "task list --json")],
        { timeoutMs: FETCH_CAP_MS },
    );
    const fallback = (error: string): FleetCopy => {
        const last = cached(machine.name);
        return {
            machine: machine.name,
            fetchedAt: last?.fetchedAt ?? null,
            tasks: last?.tasks ?? [],
            local: false,
            error,
        };
    };
    if (result.timedOut) return fallback(`no answer from ${machine.ssh} within ${FETCH_CAP_MS / 1000}s`);
    if (result.code !== 0)
        return fallback(
            `ssh ${machine.ssh} exited ${result.code}: ${(result.stderr || result.stdout).trim().split("\n")[0]}`,
        );
    let tasks: unknown;
    try {
        tasks = JSON.parse(result.stdout);
    } catch {
        return fallback(`bad task list from ${machine.ssh}`);
    }
    if (!isTaskList(tasks)) return fallback(`bad task list from ${machine.ssh}`);
    storeCopy(machine.name, fetchedAt, tasks);
    const kept = cached(machine.name);
    return {
        machine: machine.name,
        fetchedAt: kept?.fetchedAt ?? fetchedAt,
        tasks: kept?.tasks ?? tasks,
        local: false,
    };
}

/** This machine's tasks plus every other machine's, refreshed over ssh in parallel unless `cachedOnly`. */
export async function fleetCopies(cachedOnly: boolean): Promise<FleetCopy[]> {
    const self: FleetCopy = {
        machine: loadMachine().name,
        fetchedAt: now().toISOString(),
        tasks: loadBacklog().tasks,
        local: true,
    };
    const others = otherFleetMachines();
    const copies = cachedOnly
        ? others.map((machine): FleetCopy => {
              const last = cached(machine.name);
              return {
                  machine: machine.name,
                  fetchedAt: last?.fetchedAt ?? null,
                  tasks: last?.tasks ?? [],
                  local: false,
                  ...(last === null ? { error: "never fetched" } : {}),
              };
          })
        : await Promise.all(others.map(fetchCopy));
    return [self, ...copies];
}

/** One task of the shared list, named by its fleet id. */
export type FleetTask = Task & { fleetId: string; owner: string };

function age(fetchedAt: string): string {
    const minutes = Math.max(0, Math.round((now().getTime() - Date.parse(fetchedAt)) / 60_000));
    return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

function line(task: FleetTask): string {
    const extras: string[] = [];
    if (task.delegatedBy)
        extras.push(
            `delegated by ${task.delegatedBy.machine}${task.delegatedBy.task ? `/${task.delegatedBy.task}` : ""}`,
        );
    if (task.delegatedTo?.length) extras.push(`delegated to ${task.delegatedTo.join(", ")}`);
    if (task.status === "held" && task.question) extras.push(`question: ${task.question}`);
    if (task.answer !== undefined) extras.push(`answer: ${task.answer}`);
    if (task.agent) extras.push(`agent: ${task.agent}`);
    return `${task.fleetId}\t${task.status}\t${task.project}\t${task.title}${extras.length ? `\t(${extras.join("; ")})` : ""}`;
}

/**
 * `task list --fleet [--json] [--cached] [--status s] [--project p]`: the shared list. Without `--status` only open
 * tasks (queued, active, held) are shown; an unreachable machine shows its last copy and its age.
 */
export async function listFleet(options: {
    json: boolean;
    cachedOnly: boolean;
    status: Status | undefined;
    project: string | undefined;
}): Promise<void> {
    const copies = await fleetCopies(options.cachedOnly);
    const keep = (task: Task): boolean =>
        (options.status === undefined ? OPEN.includes(task.status) : task.status === options.status) &&
        (options.project === undefined || task.project === options.project);
    const tasks = (copy: FleetCopy): FleetTask[] =>
        copy.tasks
            .filter(keep)
            .map((task) => ({ ...task, fleetId: fleetId(copy.machine, task.id), owner: copy.machine }));
    if (options.json) {
        printJson(
            copies.map((copy) => ({
                machine: copy.machine,
                local: copy.local,
                fetchedAt: copy.fetchedAt,
                ...(copy.error === undefined ? {} : { error: copy.error }),
                tasks: tasks(copy),
            })),
        );
        return;
    }
    for (const copy of copies) {
        const shown = tasks(copy);
        const state = copy.local
            ? "this machine"
            : copy.error === undefined
              ? "live"
              : copy.fetchedAt === null
                ? `unreachable, never fetched: ${copy.error}`
                : `unreachable, copy from ${age(copy.fetchedAt)} ago: ${copy.error}`;
        out(`## ${copy.machine} (${state}): ${shown.length} task${shown.length === 1 ? "" : "s"}`);
        for (const task of shown) out(line(task));
    }
}

/** `task answer <machine>/T<n> "<answer>"` for another machine's task: the owner records it (rule 2). */
function forwardAnswer(owner: string, argv: string[]): void {
    const args = new Args(argv);
    args.maxPositional(2);
    const id = splitFleetId(args.pos(0, "id")).id;
    const reply = args.pos(1, "answer");
    const target = fleetMachine(owner);
    const self = loadMachine().name;
    const command = `task answer ${shellQuote(id)} ${shellQuote(reply)} --from ${shellQuote(self)}`;
    const result = run([...sshArgs(target.ssh), remoteToliCommand(target.root, command)], { timeoutMs: 120_000 });
    if (result.code !== 0)
        throw new ToliError(
            `${owner} did not record the answer (ssh ${target.ssh} exited ${result.code}): ${(result.stderr || result.stdout).trim()}`,
        );
    out(`${owner} recorded the answer for ${fleetId(owner, id)}:`);
    out(result.stdout.trimEnd());
}

/** Subcommands that change one task: they take its id first, and only its owner may run them. */
const TASK_WRITES: Record<string, true> = { start: true, done: true, hold: true, answer: true, drop: true };

/**
 * A task write naming a fleet id (`<machine>/T<n>`): this machine's own id becomes the bare `T<n>` in `rest`; an
 * answer for another machine's task is forwarded to its owner (returns true: handled); any other write to another
 * machine's task is refused (rule 2).
 */
export function routeToOwner(sub: string, rest: string[]): boolean {
    const first = rest[0];
    if (!TASK_WRITES[sub] || first === undefined || !first.includes("/")) return false;
    const { machine, id } = splitFleetId(first);
    if (machine === loadMachine().name) {
        rest[0] = id;
        return false;
    }
    if (sub === "answer") {
        forwardAnswer(requireName("machine", machine ?? ""), rest);
        return true;
    }
    throw new ToliError(
        `${first} is ${machine}'s task: only its owner changes it; ask its lead (\`bin/toli talk ${machine} "<words>"\`)`,
    );
}
