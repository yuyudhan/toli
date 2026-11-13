// `bin/toli lead`: this machine's lead (docs/sardars.md). One long-lived omp conversation in state/lead/sessions/,
// served by a service (launchd agent, systemd user service or a per-minute crontab line) that runs one headless turn
// per batch of wake items while no interactive lead session is open, and `lead attach` to open it in a terminal.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { Args } from "../core/args.ts";
import { hasMachine, loadMachine } from "../core/config.ts";
import { adoptLoginEnv } from "../core/login-env.ts";
import { codeRoot, paths } from "../core/paths.ts";
import { persona } from "../core/persona.ts";
import { now, out, printJson, readJson, ToliError, withLock, writeJsonAtomic, writeTextAtomic } from "../core/util.ts";
import { leadGuidance } from "../harness/guidance.ts";
import { headlessOmpFlags } from "../harness/omp-args.ts";
import { liveSession } from "../harness/session.ts";
import { sessionFile } from "../jawans/launch.ts";
import { receivingNow } from "../peer/receiving.ts";
import { ensureListener } from "../peer/supervise.ts";
import { takeWake, wakeMessage } from "../records/wake.ts";
import { runtimeSuperseded } from "../release/runtime.ts";
import { type LeadDispatch, machineDispatch } from "./dispatch.ts";
import { currentFull, fullCommand, fullText, LEAD_TURN_ENV } from "./full.ts";
import { installLeadService, leadStatus, printStatus, uninstallLeadService } from "./lead-service.ts";
import { attachPidLocked, type LeadAttach, type LeadState, leadLock, readLeadState, turnPid } from "./lead-state.ts";
import { balancePass } from "./queues.ts";

/** How often the service makes a pass; `TOLI_LEAD_POLL_MS` overrides for tests. */
const POLL_MS = 15_000;
/**
 * How often the service checks the peer listener, on its own timer so a pass busy with a long headless turn never
 * keeps a dead or replaced listener down; `TOLI_LEAD_LISTENER_MS` overrides for tests.
 */
const LISTENER_POLL_MS = 5_000;
/** How often `lead attach` looks again while a headless turn is still running. */
const ATTACH_POLL_MS = 2_000;

function machineName(): string {
    return hasMachine() ? loadMachine().name : "(unnamed)";
}

/** One timestamped line in logs/lead.log (the service's own stdout and stderr go there too). */
function logLine(line: string): void {
    mkdirSync(paths.logsDir(), { recursive: true });
    appendFileSync(paths.leadLog(), `${now().toISOString()} ${line}\n`);
}

/**
 * The prompt of one headless turn: who and where the lead is, the per-turn lead guidance, the rules that differ when
 * nobody is watching (no questions, no waiting, dispatch only through `bin/toli spawn`, or under `lead.dispatch:
 * "subagents"` no dispatch at all, the work left unacknowledged for the interactive Sardar), and the wake items.
 */
export function headlessPrompt(machine: string, wake: string, dispatch: LeadDispatch): string {
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
        "",
        wake,
    ].join("\n");
}

type Claim = { wake: string; resume: string | null; turn: number; dispatch: LeadDispatch };

/**
 * Claim the next headless turn, or null when there is nothing to do: an interactive session is open (it takes the
 * wakes itself), a turn is already running, or no wake items and no pending text. The wake is taken here, under the
 * lead lock, so two passes never take the same items; the combined text is written to pending.md before the turn so
 * a turn that fails, or a service that dies mid-turn, leaves it for the next pass. Under `lead.dispatch:
 * "subagents"` the take moves only the headless marks, so the interactive session is still woken by what this turn
 * leaves unacknowledged.
 */
function claimTurn(): Claim | null {
    return withLock(leadLock(), () => {
        if (liveSession() !== null || attachPidLocked() !== null) return null;
        const state = readLeadState();
        if (turnPid(state) !== null) return null;
        // A peer's batch is being applied: wait until it is all in, so it wakes this lead once.
        if (receivingNow()) return null;
        const dispatch = machineDispatch();
        const pendingPath = paths.leadPending();
        const pending = existsSync(pendingPath) ? readFileSync(pendingPath, "utf8").trim() : "";
        const fresh = wakeMessage(takeWake(dispatch === "subagents" ? "headless" : "session"));
        const wake = [pending, fresh].filter((text) => text !== "").join("\n\n");
        if (wake === "") return null;
        writeTextAtomic(pendingPath, `${wake}\n`);
        writeJsonAtomic(paths.leadState(), { ...state, pid: process.pid, ompPid: null } satisfies LeadState);
        return { wake, resume: sessionFile(paths.leadSessionsDir()), turn: state.turns + 1, dispatch };
    });
}

function recordOmpPid(pid: number): void {
    withLock(leadLock(), () => {
        writeJsonAtomic(paths.leadState(), { ...readLeadState(), ompPid: pid } satisfies LeadState);
    });
}

/** Run the claimed turn with its output appended to logs/lead.log; resolves to omp's exit code. */
async function runTurn(claim: Claim): Promise<number> {
    const root = paths.root();
    const sessions = paths.leadSessionsDir();
    mkdirSync(sessions, { recursive: true });
    mkdirSync(paths.logsDir(), { recursive: true });
    const argv = [
        ...headlessOmpFlags(root, root, null, { dir: sessions, resume: claim.resume ?? undefined }),
        headlessPrompt(machineName(), claim.wake, claim.dispatch),
    ];
    const logFd = openSync(paths.leadLog(), "a");
    try {
        writeSync(
            logFd,
            `\n=== ${now().toISOString()} lead turn ${claim.turn}${claim.resume === null ? " (new conversation)" : ""} ===\n`,
        );
        const program = argv[0] ?? "omp";
        const resolved = Bun.which(program, { PATH: process.env.PATH ?? "" });
        if (resolved === null) {
            writeSync(logFd, `${program}: command not found\n`);
            return 127;
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
        const code = await proc.exited;
        writeSync(logFd, `=== ${now().toISOString()} lead turn ${claim.turn} exited ${code} ===\n`);
        return code;
    } finally {
        closeSync(logFd);
    }
}

/** Close the turn record; a successful turn consumed the pending text, a failed one leaves it for the next pass. */
function finishTurn(code: number): void {
    withLock(leadLock(), () => {
        const state = readLeadState();
        writeJsonAtomic(paths.leadState(), {
            lastTurnAt: now().toISOString(),
            lastExit: code,
            turns: state.turns + 1,
            sessionFile: sessionFile(paths.leadSessionsDir()),
            pid: null,
            ompPid: null,
        } satisfies LeadState);
        if (code === 0) rmSync(paths.leadPending(), { force: true });
    });
}

/** One headless turn when one is due; returns the log line for it, or null when the pass had nothing to do. */
async function headlessPass(): Promise<string | null> {
    const claim = claimTurn();
    if (claim === null) return null;
    let code = 1;
    try {
        code = await runTurn(claim);
    } finally {
        finishTurn(code);
    }
    return code === 0
        ? `lead turn ${claim.turn} done`
        : `lead turn ${claim.turn} exited ${code}; its wake stays in ${paths.leadPending()} for the next pass`;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** One service pass: a headless turn when due, then queue balancing. A failing step is logged, never thrown. */
async function leadPass(): Promise<void> {
    try {
        const line = await headlessPass();
        if (line !== null) logLine(line);
    } catch (error) {
        logLine(`lead turn failed: ${errorText(error)}`);
    }
    try {
        const line = await balancePass();
        if (line !== null) logLine(line);
    } catch (error) {
        logLine(`queue balancing failed: ${errorText(error)}`);
    }
}

function intervalMs(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0)
        throw new ToliError(`${name} must be a positive integer (got "${raw}")`);
    return value;
}

/** One listener check (src/peer/server.ts ensureListener); a failure is logged, never thrown. */
async function listenerPass(): Promise<void> {
    try {
        const line = await ensureListener();
        if (line !== null) logLine(line);
    } catch (error) {
        logLine(`peer listener not started: ${errorText(error)}`);
    }
}

/** Check the listener now, then every `interval` ms (never two checks at once); returns the stop function. */
async function superviseListener(interval: number): Promise<() => void> {
    await listenerPass();
    let checking = false;
    const timer = setInterval(() => {
        if (checking) return;
        checking = true;
        void listenerPass().finally(() => {
            checking = false;
        });
    }, interval);
    return () => clearInterval(timer);
}

/**
 * `lead run [--once]`: the service loop, one pass every poll interval; `--once` makes one pass (the crontab form).
 * The loop imported its code once, so after a pass that saw `self sync` install a newer runtime it exits cleanly and
 * the service manager (launchd KeepAlive, systemd Restart=always) starts it again on that runtime. The long-running
 * form keeps the peer listener up on its own timer, between and during passes.
 */
async function serve(once: boolean): Promise<number> {
    const interval = intervalMs("TOLI_LEAD_POLL_MS", POLL_MS);
    if (once) {
        await leadPass();
        return 0;
    }
    const listenerInterval = intervalMs("TOLI_LEAD_LISTENER_MS", LISTENER_POLL_MS);
    out(`${now().toISOString()} lead service started on ${codeRoot()}`);
    const stopSupervising = await superviseListener(listenerInterval);
    try {
        for (;;) {
            await leadPass();
            if (runtimeSuperseded()) {
                logLine("a newer runtime is installed: exiting so the service restarts on it");
                return 0;
            }
            await Bun.sleep(interval);
        }
    } finally {
        stopSupervising();
    }
}

type AttachStep = { kind: "attached" } | { kind: "busy" } | { kind: "open"; pid: number };

/** Under the lead lock: refuse a second interactive lead, wait out a headless turn, else write the attach marker. */
function tryAttach(): AttachStep {
    return withLock(leadLock(), () => {
        const open = liveSession()?.pid ?? attachPidLocked();
        if (open !== null) return { kind: "open", pid: open };
        if (turnPid(readLeadState()) !== null) return { kind: "busy" };
        writeJsonAtomic(paths.leadAttach(), { pid: process.pid, startedAt: now().toISOString() } satisfies LeadAttach);
        return { kind: "attached" };
    });
}

/**
 * `lead attach`: open this machine's lead conversation in this terminal. Waits for a headless turn to finish, refuses
 * when an interactive lead is already open elsewhere, and holds the attach marker while omp runs so the service
 * leaves the wakes to this session.
 */
export async function attachLead(): Promise<number> {
    let told = false;
    for (;;) {
        const step = tryAttach();
        if (step.kind === "attached") break;
        if (step.kind === "open") {
            out(
                `the lead is already open in a terminal (pid ${step.pid}); send it words with bin/toli talk ${machineName()} "<words>"`,
            );
            return 1;
        }
        if (!told) {
            out("waiting for the lead's headless turn to finish");
            told = true;
        }
        await Bun.sleep(ATTACH_POLL_MS);
    }
    try {
        const sessions = paths.leadSessionsDir();
        mkdirSync(sessions, { recursive: true });
        const resume = sessionFile(sessions);
        const omp = Bun.which("omp", { PATH: process.env.PATH ?? "" });
        if (omp === null) throw new ToliError("omp not found on PATH");
        const proc = Bun.spawn([omp, "--session-dir", sessions, ...(resume === null ? [] : ["--resume", resume])], {
            cwd: paths.root(),
            env: process.env,
            stdio: ["inherit", "inherit", "inherit"],
        });
        return await proc.exited;
    } finally {
        withLock(leadLock(), () => {
            if (readJson<LeadAttach | null>(paths.leadAttach(), null)?.pid === process.pid)
                rmSync(paths.leadAttach(), { force: true });
        });
    }
}

const USAGE =
    "usage: toli lead install|uninstall|status [--json]|run [--once]|attach|full [--reason ...] [--until 2h] [--clear|--status]";

export async function leadCommand(argv: string[]): Promise<number> {
    const [sub, ...rest] = argv;
    if (sub === "full") {
        fullCommand(rest);
        return 0;
    }
    const args = new Args(rest, { booleans: ["json", "once"] });
    args.maxPositional(0);
    switch (sub) {
        case "install":
            installLeadService();
            return 0;
        case "uninstall":
            uninstallLeadService();
            return 0;
        case "status": {
            const status = leadStatus();
            if (args.bool("json")) printJson(status);
            else printStatus(status);
            return 0;
        }
        case "run":
            return await serve(args.bool("once"));
        case "attach":
            return await attachLead();
        default:
            throw new ToliError(USAGE);
    }
}
