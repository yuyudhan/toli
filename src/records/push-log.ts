// The push log: data/pushes.jsonl on the machine whose clone pushed, one JSON line per push. A push carried out here
// on another machine's behalf (a jawan there running `bin/toli push` over ssh, or a raw `git push` followed by
// `bin/toli push-log add`) otherwise leaves only an `update by push` reflog entry, and jawans here would read it as
// an unexplained push. `bin/toli digest` lists the recent ones.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Args } from "../core/args.ts";
import { hasMachine, loadMachine } from "../core/config.ts";
import { currentBranch, git, gitOk } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { now, out, printJson, requireName, ToliError } from "../core/util.ts";
import { projectCloneDir } from "../projects/projects.ts";

/**
 * Set by `bin/toli exec` for the headless run it starts: the machine that issued the run and its task there, so a
 * push in that run is attributed without the prompt having to spell out `--by`/`--for`.
 */
export const ISSUED_BY_ENV = "TOLI_ISSUED_BY";
export const ISSUED_TASK_ENV = "TOLI_ISSUED_TASK";

export type PushRecord = {
    /** When the push was recorded (ISO). */
    at: string;
    /** The machine whose clone pushed (where this log lives). */
    machine: string;
    project: string;
    branch: string;
    /** origin's branch tip before the push; null for a new branch. */
    old: string | null;
    /** origin's branch tip after the push. */
    new: string;
    /** The machine that asked for the push (this machine for a local push). */
    by: string;
    /** The task on the issuing machine the push carries out, if any. */
    task: string | null;
    /** The owner's word for this push, quoted verbatim, if given. */
    word: string | null;
};

export type PushAttribution = { by: string; task: string | null; word: string | null };

const RECENT_DAYS = 7;
const RECENT_LIMIT = 5;
const SHORT_SHA = 9;

function machineName(): string {
    return hasMachine() ? loadMachine().name : "(unnamed)";
}

/**
 * `--by`/`--for`/`--word`. `--by` defaults to the exec environment's issuing machine, else this machine; `--for` to
 * the exec environment's task, else `localTask` (this machine's `--task`), else none.
 */
export function pushAttribution(args: Args, localTask?: string): PushAttribution {
    const by = args.str("by") || process.env[ISSUED_BY_ENV] || undefined;
    const task = args.str("for") || process.env[ISSUED_TASK_ENV] || localTask || undefined;
    const word = args.str("word")?.trim() ?? "";
    return {
        by: by === undefined ? machineName() : requireName("machine", by),
        task: task === undefined ? null : requireName("task", task),
        word: word === "" ? null : word,
    };
}

export function appendPush(entry: Omit<PushRecord, "at" | "machine">): PushRecord {
    const record: PushRecord = { at: now().toISOString(), machine: machineName(), ...entry };
    const file = paths.pushLog();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`);
    return record;
}

function isPushRecord(value: unknown): value is PushRecord {
    if (typeof value !== "object" || value === null) return false;
    const entry = value as Record<string, unknown>;
    const text = (key: string): boolean => typeof entry[key] === "string";
    const nullableText = (key: string): boolean => entry[key] === null || text(key);
    return (
        ["at", "machine", "project", "branch", "new", "by"].every(text) && ["old", "task", "word"].every(nullableText)
    );
}

/** Every logged push, oldest first. A line that is not a push record (a torn write) is skipped, never fatal. */
export function listPushes(): PushRecord[] {
    const file = paths.pushLog();
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .flatMap((line) => {
            try {
                const parsed: unknown = JSON.parse(line);
                return isPushRecord(parsed) ? [parsed] : [];
            } catch {
                return [];
            }
        });
}

/** Pushes of the last week, newest first, at most five: the digest's "recent pushes". */
export function recentPushes(at: Date = now()): PushRecord[] {
    const since = at.getTime() - RECENT_DAYS * 24 * 60 * 60 * 1000;
    return listPushes()
        .filter((entry) => new Date(entry.at).getTime() >= since)
        .reverse()
        .slice(0, RECENT_LIMIT);
}

export function pushLine(entry: PushRecord): string {
    const range = `${entry.old === null ? "(new)" : entry.old.slice(0, SHORT_SHA)}..${entry.new.slice(0, SHORT_SHA)}`;
    const issued = entry.by === entry.machine ? `by ${entry.by}` : `for ${entry.by}`;
    const task = entry.task === null ? "" : ` ${entry.task}`;
    const word = entry.word === null ? "" : `, word: "${entry.word}"`;
    return `${entry.at} ${entry.project} ${entry.branch} ${range} ${issued}${task}${word}`;
}

/** Resolve `rev` to a full commit sha in `dir`, or null when it does not name a commit. */
function commitSha(dir: string, rev: string): string | null {
    const result = git(dir, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
    return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * `push-log add <project> [--branch <b>] [--old <sha>] [--new <sha>] [--by <machine>] [--for <task>] [--word "..."]`:
 * record a push made with raw git. The branch defaults to the clone's current one; `--new` to origin's tracking ref
 * (what the push just set), `--old` to that ref's previous reflog entry (none: a new branch).
 */
function add(argv: string[]): void {
    const args = new Args(argv, { values: ["branch", "old", "new", "by", "for", "word"] });
    args.maxPositional(1);
    const project = args.pos(0, "project");
    const dir = projectCloneDir(project);
    const branch = args.str("branch") ?? currentBranch(dir);
    if (branch === null) throw new ToliError(`${dir} is on a detached HEAD: pass --branch <branch>`);
    gitOk(dir, ["check-ref-format", "--branch", branch]);
    const tracking = `refs/remotes/origin/${branch}`;
    const resolve = (flag: string, fallback: string): string | null => {
        const given = args.str(flag);
        const sha = commitSha(dir, given ?? fallback);
        if (given !== undefined && sha === null) throw new ToliError(`--${flag} ${given} is not a commit in ${dir}`);
        return sha;
    };
    const after = resolve("new", tracking);
    if (after === null) throw new ToliError(`origin/${branch} is not known in ${dir}: pass --new <sha>`);
    const old = resolve("old", `${tracking}@{1}`);
    const record = appendPush({ project, branch, old, new: after, ...pushAttribution(args) });
    out(`push log: ${pushLine(record)}`);
}

function list(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const pushes = listPushes();
    if (args.bool("json")) {
        printJson(pushes);
        return;
    }
    if (pushes.length === 0) {
        out("push log: empty");
        return;
    }
    for (const entry of pushes) out(pushLine(entry));
}

export function pushLogCommand(argv: string[]): void {
    const [sub, ...rest] = argv;
    switch (sub) {
        case "add":
            add(rest);
            break;
        case "list":
            list(rest);
            break;
        default:
            throw new ToliError("usage: toli push-log add|list");
    }
}
