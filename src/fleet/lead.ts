// `bin/toli lead`: this machine's lead (docs/sardars.md). One long-lived omp conversation in state/lead/sessions/,
// served by a service (launchd agent, systemd user service or a per-minute crontab line) that runs one headless turn
// per batch of wake items while no interactive lead session is open (or the open one has left its wakes unread past
// `lead.idleSessionMinutes`), and `lead attach` to open it in a terminal.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { Args } from "../core/args.ts";
import { codeRoot, paths } from "../core/paths.ts";
import { now, out, printJson, readJson, ToliError, withLock, writeJsonAtomic, writeTextAtomic } from "../core/util.ts";
import { liveSession } from "../harness/session.ts";
import { sessionFile } from "../jawans/launch.ts";
import { receivingNow } from "../peer/receiving.ts";
import { ensureListener } from "../peer/supervise.ts";
import { takeWake, wakeMessage } from "../records/wake.ts";
import { runtimeSuperseded } from "../release/runtime.ts";
import { machineDispatch } from "./dispatch.ts";
import { fullCommand } from "./full.ts";
import { idleSessionText, sessionPresence } from "./idle-session.ts";
import { installLeadService, leadStatus, printStatus, uninstallLeadService } from "./lead-service.ts";
import { attachPidLocked, type LeadAttach, type LeadState, leadLock, readLeadState, turnPid } from "./lead-state.ts";
import { type Claim, logLine, machineName, runTurn } from "./lead-turn.ts";
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

/**
 * Claim the next headless turn, or null when there is nothing to do: an interactive session is open and reading its
 * wakes (it takes them itself), a `lead attach` is open, a turn is already running, or no wake items and no pending
 * text. An interactive session that has left a wake unread past `lead.idleSessionMinutes` (src/fleet/idle-session.ts)
 * does not hold the turn back: the take then also covers what that session was shown but never acknowledged. The wake
 * is taken here, under the lead lock, so two passes never take the same items; the combined text is written to
 * pending.md before the turn so a turn that fails, or a service that dies mid-turn, leaves it for the next pass. Under
 * `lead.dispatch: "subagents"` the take moves only the headless marks, so the interactive session is still woken by
 * what this turn leaves unacknowledged.
 */
function claimTurn(): Claim | null {
    return withLock(leadLock(), () => {
        const presence = sessionPresence();
        if ((presence !== null && presence.idle === null) || attachPidLocked() !== null) return null;
        const state = readLeadState();
        if (turnPid(state) !== null) return null;
        // A peer's batch is being applied: wait until it is all in, so it wakes this lead once.
        if (receivingNow()) return null;
        const dispatch = machineDispatch();
        const idle = presence?.idle ?? null;
        const pendingPath = paths.leadPending();
        const pending = existsSync(pendingPath) ? readFileSync(pendingPath, "utf8").trim() : "";
        const reader = idle !== null ? "takeover" : dispatch === "subagents" ? "headless" : "session";
        const fresh = wakeMessage(takeWake(reader));
        const wake = [pending, fresh].filter((text) => text !== "").join("\n\n");
        if (wake === "") return null;
        writeTextAtomic(pendingPath, `${wake}\n`);
        writeJsonAtomic(paths.leadState(), { ...state, pid: process.pid, ompPid: null } satisfies LeadState);
        return { wake, resume: sessionFile(paths.leadSessionsDir()), turn: state.turns + 1, dispatch, idle };
    });
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
    if (claim.idle !== null)
        logLine(
            `lead turn ${claim.turn}: interactive session ${idleSessionText(claim.idle)}; this headless turn takes its wakes`,
        );
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
