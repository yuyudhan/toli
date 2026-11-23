// Replies to a spawned jawan's own `talk` (docs/sardars.md "Replies to a jawan's talk"). A run cannot be messaged,
// so a `talk` a jawan run sends names its run (`- run: <id>`) and how to answer it (`bin/toli talk <machine> --run
// <id> "<reply>"`). A reply sent that way carries `- for run: <id>`, and `inbox add` here files it with the run while
// it, or a continuation of it, is alive: in the replies folder of the chain's first run, where the jawan reads it
// with `bin/toli run replies [--wait <minutes>]`. Once every run of the chain has ended, it goes to the lead's inbox.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Args } from "../core/args.ts";
import { paths } from "../core/paths.ts";
import { now, out, pidAlive, stamp, ToliError, writeTextAtomic } from "../core/util.ts";
import { ACTIVE, type JawanRun, loadRun } from "./runs.ts";

const RUN_ID = /^[A-Za-z0-9._-]+$/;
/** The line a reply to a run carries. */
const FOR_RUN_LINE = /^- for run: (\S+)$/m;
/** The shown-through marker in a replies folder: the name of the newest reply already shown. */
const SEEN_FILE = ".seen";
/** How often `run replies --wait` looks for a new reply. */
const WAIT_POLL_MS = 1000;

/** A run id as given on the command line: a name, or refused. */
export function runIdArg(id: string): string {
    if (!RUN_ID.test(id)) throw new ToliError(`invalid run id "${id}"`);
    return id;
}

/** The spawned run this process is (`TOLI_ROLE=jawan`, `TOLI_RUN_ID`), when its record is on this machine. */
export function ownRun(env: Record<string, string | undefined> = process.env): JawanRun | null {
    const id = env.TOLI_RUN_ID;
    if (env.TOLI_ROLE !== "jawan" || id === undefined || !RUN_ID.test(id) || !existsSync(paths.jawanRecord(id)))
        return null;
    return loadRun(id);
}

/** The lines a `talk` sent from `run` adds: its run and task, and how to reply to it. */
export function runTalkLines(machine: string, run: JawanRun): string[] {
    return [
        `- run: ${run.id}${run.task === null ? "" : ` (task ${run.task})`}, a jawan on ${machine}`,
        `- reply to that run: \`bin/toli talk ${machine} --run ${run.id} "<reply>"\``,
    ];
}

/** The line a reply to run `id` carries. */
export function forRunLine(id: string): string {
    return `- for run: ${id}`;
}

/** The run a message is a reply to (its `- for run: <id>` line), or null. */
function replyRunOf(body: string): string | null {
    const id = FOR_RUN_LINE.exec(body)?.[1];
    return id !== undefined && RUN_ID.test(id) ? id : null;
}

function loadRunOrNull(id: string): JawanRun | null {
    return existsSync(paths.jawanRecord(id)) ? loadRun(id) : null;
}

/** The first run of `run`'s resume chain: its replies folder is the chain's. */
function chainRoot(run: JawanRun): JawanRun {
    const seen = new Set([run.id]);
    let root = run;
    while (root.resumeOf !== undefined && !seen.has(root.resumeOf)) {
        const previous = loadRunOrNull(root.resumeOf);
        if (previous === null) break;
        seen.add(previous.id);
        root = previous;
    }
    return root;
}

/** The live run of `run`'s chain from it on: itself, or the continuation that took over; null once all ended. */
function liveRunFrom(run: JawanRun): JawanRun | null {
    const seen = new Set<string>();
    let current: JawanRun | null = run;
    while (current !== null && !seen.has(current.id)) {
        // Queued, or running under a live supervisor.
        if (ACTIVE.includes(current.status) && (current.supervisorPid === null || pidAlive(current.supervisorPid)))
            return current;
        seen.add(current.id);
        current = current.resumedBy === undefined ? null : loadRunOrNull(current.resumedBy);
    }
    return null;
}

/**
 * `inbox add` of a message from `from`: when it is a reply to a run here that (or whose continuation) is alive, file
 * it with that run and say so; null when it is no reply to a run. Otherwise the reply goes to the lead's inbox with a
 * first line saying the run it was for is gone (`inboxBody`).
 */
export function deliverRunReply(
    from: string,
    title: string,
    body: string,
): { delivered: string } | { inboxBody: string } | null {
    const id = replyRunOf(body);
    if (id === null) return null;
    const run = loadRunOrNull(id);
    const live = run === null ? null : liveRunFrom(run);
    if (run === null || live === null) {
        const why = run === null ? "which is not a run on this machine" : "which has ended";
        return {
            inboxBody: `This reply is for run ${id}, ${why}: pass it on (\`bin/toli resume ${id} --note "<reply>"\`) if the work still needs it.\n\n${body}`,
        };
    }
    const dir = join(chainRoot(live).runDir, "replies");
    mkdirSync(dir, { recursive: true });
    const at = now();
    let file = join(dir, `${stamp(at)}-${from}.md`);
    for (let bump = 1; existsSync(file); bump++) file = join(dir, `${stamp(new Date(at.getTime() + bump))}-${from}.md`);
    writeTextAtomic(file, `# ${title}\n\n- from: ${from}\n- received: ${at.toISOString()}\n\n${body.trimEnd()}\n`);
    return { delivered: `delivered to run ${live.id} (bin/toli run replies there): ${file}` };
}

/** The replies filed in `dir`, oldest first by file name. */
function replyFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((file) => file.endsWith(".md"))
        .sort();
}

function replyText(dir: string, file: string): string {
    const text = readFileSync(join(dir, file), "utf8");
    const from = /^- from: (\S+)$/m.exec(text)?.[1] ?? "?";
    const received = /^- received: (\S+)$/m.exec(text)?.[1] ?? "?";
    const words = text
        .split("\n")
        .filter((line) => !/^#\s|^- (?:from|received|reply|for run): /.test(line))
        .join("\n")
        .trim();
    return `reply from ${from} at ${received} (${join(dir, file)}):\n${words}`;
}

/**
 * `toli run replies [<id>] [--all] [--wait <minutes>]`: the replies to this run's (or `<id>`'s) talk not shown yet,
 * marking them shown; `--all` shows every one. `--wait` waits up to that many minutes for a new one.
 */
export async function repliesCommand(argv: string[]): Promise<void> {
    const args = new Args(argv, { booleans: ["all"], values: ["wait"] });
    args.maxPositional(1);
    const given = args.positional[0];
    const run = given === undefined ? ownRun() : loadRun(runIdArg(given));
    if (run === null) throw new ToliError("run replies: name the run (this is no jawan run: TOLI_RUN_ID is not set)");
    const waitText = args.str("wait");
    const waitMinutes = waitText === undefined ? 0 : Number(waitText);
    if (!Number.isFinite(waitMinutes) || waitMinutes < 0)
        throw new ToliError("--wait is a number of minutes, 0 or more");
    const dir = join(chainRoot(run).runDir, "replies");
    const deadline = Date.now() + waitMinutes * 60_000;
    for (;;) {
        const seenFile = join(dir, SEEN_FILE);
        const seen = args.bool("all") || !existsSync(seenFile) ? "" : readFileSync(seenFile, "utf8").trim();
        const fresh = replyFiles(dir).filter((file) => file > seen);
        if (fresh.length > 0) {
            for (const file of fresh) out(replyText(dir, file));
            writeFileSync(join(dir, SEEN_FILE), `${fresh.at(-1)}\n`);
            return;
        }
        if (Date.now() >= deadline) break;
        await Bun.sleep(Math.min(WAIT_POLL_MS, deadline - Date.now()));
    }
    out(waitMinutes > 0 ? `no reply for ${run.id} within ${waitText} minutes` : `no new replies for ${run.id}`);
}
