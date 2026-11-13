// One headless turn of this machine's lead (src/fleet/lead.ts, docs/sardars.md): its prompt, the omp run with its
// output in logs/lead.log, and the fresh conversation that replaces one omp can no longer resume.
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { hasMachine, loadMachine } from "../core/config.ts";
import { adoptLoginEnv } from "../core/login-env.ts";
import { paths } from "../core/paths.ts";
import { persona } from "../core/persona.ts";
import { now, withLock, writeJsonAtomic } from "../core/util.ts";
import { leadGuidance } from "../harness/guidance.ts";
import { harnessConfig } from "../harness/harness.ts";
import { resolveModel } from "../harness/models.ts";
import { headlessOmpFlags } from "../harness/omp-args.ts";
import type { LeadDispatch } from "./dispatch.ts";
import { currentFull, fullText, LEAD_TURN_ENV } from "./full.ts";
import type { IdleSession } from "./idle-session.ts";
import { type LeadState, leadLock, readLeadState } from "./lead-state.ts";

/** What omp prints when a resumed conversation's model is no longer available; the group is that model. */
const MODEL_RESTORE_FAILURE = /Could not restore model (\S+?)[.,;:]?(?:\s|$)/;

export function machineName(): string {
    return hasMachine() ? loadMachine().name : "(unnamed)";
}

/** One timestamped line in logs/lead.log (the service's own stdout and stderr go there too). */
export function logLine(line: string): void {
    mkdirSync(paths.logsDir(), { recursive: true });
    appendFileSync(paths.leadLog(), `${now().toISOString()} ${line}\n`);
}

/**
 * The prompt of one headless turn: who and where the lead is, the per-turn lead guidance, the rules that differ when
 * nobody is watching (no questions, no waiting, dispatch only through `bin/toli spawn`, or under `lead.dispatch:
 * "subagents"` no dispatch at all, the work left unacknowledged for the interactive Sardar), the idle interactive
 * session this turn stands in for, if any, and the wake items.
 */
export function headlessPrompt(
    machine: string,
    wake: string,
    dispatch: LeadDispatch,
    idle: IdleSession | null = null,
): string {
    const user = persona().user;
    const full = currentFull();
    const subagents = dispatch === "subagents";
    return [
        `[toli lead ${machine}] headless turn`,
        "",
        leadGuidance(),
        "",
        "[toli] Headless rules for this turn:",
        `- You are this machine's lead between conversations. Nobody reads this reply live; ${user} reads it when he attaches (\`bin/toli lead attach\`), so keep it to what happened and what waits on him.`,
        subagents
            ? '- Start no jawan in this turn: on this machine jawans run only as the interactive Sardar\'s own subagents (config/machine.json `lead.dispatch: "subagents"`), so `bin/toli spawn`, `bin/toli resume` and queued-run starts refuse here. Never use native or harness subagents either. Leave each item that needs a jawan to the interactive Sardar and say what waits.'
            : "- Dispatch jawans ONLY with `bin/toli spawn --task T<n> --brief <file>`: it returns at once and the result arrives as a later wake. Never use native or harness subagents, and never wait for or poll a jawan.",
        ...(full === null
            ? []
            : [
                  `- This machine is ${fullText(full)}: start no jawan here (\`bin/toli spawn\` refuses in this turn). Delegate each task to the shortest queue with \`bin/toli delegate <machine> "<title>" --brief <file>\` (\`bin/toli fleet queues\`).`,
              ]),
        `- Never ask questions: a decision for ${user} is \`bin/toli task hold <id> --question "..."\` (the Needs-you queue).`,
        '- Work for another machine goes by `bin/toli delegate <machine> "<title>" --brief <file>`, never `bin/toli remote`. Reply to another machine\'s lead with `bin/toli talk <machine> "<words>"`.',
        `- A delegated task's question (\`<machine>/T<n> held\`) is yours to answer: \`bin/toli task answer <machine>/T<n> "<answer>"\`. Only one that needs ${user} (push, merge, release, money, security, destructive, taste) goes to \`bin/toli task escalate <machine>/T<n>\`.`,
        subagents
            ? "- Acknowledge only what you settled. Each ack command is a watermark that covers every older item of its stream, so run it `--through` the stamp of the last item before the first one you leave (`bin/toli inbox ack --through <stamp>` / `bin/toli job ack --through <stamp>`), and none for a stream whose first item you leave. What stays unacknowledged stays unread and wakes the interactive Sardar's next session."
            : "- After handling the items, run every ack command the wake text below ends with (`bin/toli inbox ack --through <stamp>` / `bin/toli job ack --through <stamp>`): each covers exactly the items it showed, and anything newer stays unread and wakes the next turn.",
        ...(idle === null
            ? []
            : [
                  `- The interactive session (pid ${idle.pid}) has left wakes unread since ${idle.unreadSince} (over ${idle.minutes} min), so this headless turn handles them, including any that session was already shown. It is ${user}'s session: never stop or kill it.`,
              ]),
        "",
        wake,
    ].join("\n");
}

export type Claim = {
    wake: string;
    resume: string | null;
    turn: number;
    dispatch: LeadDispatch;
    idle: IdleSession | null;
};

function recordOmpPid(pid: number): void {
    withLock(leadLock(), () => {
        writeJsonAtomic(paths.leadState(), { ...readLeadState(), ompPid: pid } satisfies LeadState);
    });
}

/**
 * Run omp once for the claimed turn, resuming `resume` (a new conversation when null, on the configured omp model),
 * with its output appended to logs/lead.log; resolves to omp's exit code and what it wrote.
 */
async function runOmp(claim: Claim, resume: string | null): Promise<{ code: number; output: string }> {
    const root = paths.root();
    const sessions = paths.leadSessionsDir();
    mkdirSync(sessions, { recursive: true });
    mkdirSync(paths.logsDir(), { recursive: true });
    const model = resume === null ? resolveModel("omp", {}, harnessConfig()).model : null;
    const argv = [
        ...headlessOmpFlags(root, root, null, { dir: sessions, resume: resume ?? undefined }),
        ...(model === null ? [] : ["--model", model]),
        headlessPrompt(machineName(), claim.wake, claim.dispatch, claim.idle),
    ];
    const logFd = openSync(paths.leadLog(), "a");
    let start = 0;
    let code = 1;
    try {
        writeSync(
            logFd,
            `\n=== ${now().toISOString()} lead turn ${claim.turn}${resume === null ? " (new conversation)" : ""} ===\n`,
        );
        start = fstatSync(logFd).size;
        const program = argv[0] ?? "omp";
        const resolved = Bun.which(program, { PATH: process.env.PATH ?? "" });
        if (resolved === null) {
            writeSync(logFd, `${program}: command not found\n`);
            return { code: 127, output: "" };
        }
        // The service starts toli with PATH alone; omp needs the login profile's provider keys.
        adoptLoginEnv();
        const proc = Bun.spawn([resolved, ...argv.slice(1)], {
            cwd: root,
            env: { ...process.env, [LEAD_TURN_ENV]: "headless" },
            stdin: "ignore",
            stdout: logFd,
            stderr: logFd,
        });
        recordOmpPid(proc.pid);
        code = await proc.exited;
        writeSync(logFd, `=== ${now().toISOString()} lead turn ${claim.turn} exited ${code} ===\n`);
    } finally {
        closeSync(logFd);
    }
    return { code, output: await Bun.file(paths.leadLog()).slice(start).text() };
}

/**
 * Run the claimed turn; resolves to omp's exit code. A conversation omp cannot resume because the model it is pinned
 * to is gone (`SessionModelRestoreError`) would fail every turn, so it is moved to state/lead/sessions/retired/ and the
 * same wake runs at once in a fresh conversation on the configured model.
 */
export async function runTurn(claim: Claim): Promise<number> {
    const first = await runOmp(claim, claim.resume);
    if (first.code === 0 || claim.resume === null) return first.code;
    const pinned = MODEL_RESTORE_FAILURE.exec(first.output)?.[1];
    if (pinned === undefined) return first.code;
    const retired = join(paths.leadSessionsDir(), "retired");
    mkdirSync(retired, { recursive: true });
    renameSync(claim.resume, join(retired, basename(claim.resume)));
    const model = resolveModel("omp", {}, harnessConfig()).model ?? "omp's default model";
    logLine(
        `lead turn ${claim.turn}: ${claim.resume} is pinned to ${pinned}, which omp cannot restore; retired to ${retired}, starting a fresh lead conversation on ${model} with the pending wake`,
    );
    return (await runOmp(claim, null)).code;
}
