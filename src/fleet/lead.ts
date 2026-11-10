// `bin/toli lead`: this machine's lead (docs/sardars.md). One long-lived omp conversation in state/lead/sessions/,
// served by a service (launchd agent, systemd user service or a per-minute crontab line) that runs one headless turn
// per batch of wake items while no interactive lead session is open, and `lead attach` to open it in a terminal.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Args } from "../core/args.ts";
import { hasMachine, loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { persona } from "../core/persona.ts";
import {
    now,
    out,
    pidAlive,
    printJson,
    readJson,
    run,
    shellQuote,
    ToliError,
    withLock,
    writeJsonAtomic,
    writeTextAtomic,
} from "../core/util.ts";
import { leadGuidance } from "../harness/guidance.ts";
import { headlessOmpFlags } from "../harness/omp-args.ts";
import { liveSession } from "../harness/session.ts";
import { sessionFile } from "../jawans/launch.ts";
import {
    bunPath,
    dryRun,
    guiDomain,
    launchAgentsDir,
    launchctlLoaded,
    loadLaunchAgent,
    mustRun,
    osScheduler,
    readCrontab,
    renderLaunchdPlist,
    type Scheduler,
    schedulePath,
    systemctl,
    systemdEnv,
    systemdPath,
    systemdUserDir,
    systemdWord,
    unloadLaunchAgent,
    writeCrontab,
} from "../jobs/os-scheduler.ts";
import { takeWake, wakeMessage } from "../records/wake.ts";
import { balancePass } from "./queues.ts";

export const LEAD_LABEL = "com.toli.lead";
export const LEAD_CRON_TAG = "# toli lead";
/** The lead's systemd user service: `toli-lead.service`. */
export const LEAD_UNIT = "toli-lead.service";

/** How often the service makes a pass; `TOLI_LEAD_POLL_MS` overrides for tests. */
const POLL_MS = 15_000;
/** How often `lead attach` looks again while a headless turn is still running. */
const ATTACH_POLL_MS = 2_000;

/**
 * The lead's turn record. `pid` is the process running the current turn and `ompPid` the omp it started; both are
 * null between turns. Either being alive means a turn is in progress (an omp left running by a crashed service
 * still counts, so no second turn or attach writes into the same conversation).
 */
export type LeadState = {
    lastTurnAt: string | null;
    lastExit: number | null;
    turns: number;
    sessionFile: string | null;
    pid: number | null;
    ompPid: number | null;
};

/** Written by `lead attach` while its interactive omp runs; the service leaves the conversation alone meanwhile. */
export type LeadAttach = { pid: number; startedAt: string };

const EMPTY_STATE: LeadState = {
    lastTurnAt: null,
    lastExit: null,
    turns: 0,
    sessionFile: null,
    pid: null,
    ompPid: null,
};

function readLeadState(): LeadState {
    return { ...EMPTY_STATE, ...readJson<Partial<LeadState>>(paths.leadState(), {}) };
}

/** The pid of a headless turn in progress, or null. */
function turnPid(state: LeadState): number | null {
    if (state.pid !== null && pidAlive(state.pid)) return state.pid;
    if (state.ompPid !== null && pidAlive(state.ompPid)) return state.ompPid;
    return null;
}

function leadLock(): string {
    return paths.lock("lead");
}

/** The attach marker's pid when that process is alive; a dead marker is removed. The caller holds the lead lock. */
function attachPidLocked(): number | null {
    const path = paths.leadAttach();
    if (!existsSync(path)) return null;
    const marker = readJson<LeadAttach | null>(path, null);
    if (marker !== null && pidAlive(marker.pid)) return marker.pid;
    rmSync(path, { force: true });
    return null;
}

/** The interactive lead session this machine has open, if any: the extension-registered session, else `lead attach`. */
export function interactiveLeadPid(): number | null {
    const session = liveSession();
    if (session !== null) return session.pid;
    return withLock(leadLock(), attachPidLocked);
}

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
 * nobody is watching (no questions, no waiting, dispatch only through `bin/toli spawn`), and the wake items.
 */
export function headlessPrompt(machine: string, wake: string): string {
    const user = persona().user;
    return [
        `[toli lead ${machine}] headless turn`,
        "",
        leadGuidance(),
        "",
        "[toli] Headless rules for this turn:",
        `- You are this machine's lead between conversations. Nobody reads this reply live; ${user} reads it when he attaches (\`bin/toli lead attach\`), so keep it to what happened and what waits on him.`,
        "- Dispatch jawans ONLY with `bin/toli spawn --task T<n> --brief <file>`: it returns at once and the result arrives as a later wake. Never use native or harness subagents, and never wait for or poll a jawan.",
        `- Never ask questions: a decision for ${user} is \`bin/toli task hold <id> --question "..."\` (the Needs-you queue).`,
        '- Work for another machine goes by `bin/toli delegate <machine> "<title>" --brief <file>`, never `bin/toli remote`. Reply to another machine\'s lead with `bin/toli talk <machine> "<words>"`.',
        "- After handling the items, acknowledge them with `bin/toli inbox ack` / `bin/toli job ack`.",
        "",
        wake,
    ].join("\n");
}

type Claim = { wake: string; resume: string | null; turn: number };

/**
 * Claim the next headless turn, or null when there is nothing to do: an interactive session is open (it takes the
 * wakes itself), a turn is already running, or no wake items and no pending text. The wake is taken here, under the
 * lead lock, so two passes never take the same items; the combined text is written to pending.md before the turn so
 * a turn that fails, or a service that dies mid-turn, leaves it for the next pass.
 */
function claimTurn(): Claim | null {
    return withLock(leadLock(), () => {
        if (liveSession() !== null || attachPidLocked() !== null) return null;
        const state = readLeadState();
        if (turnPid(state) !== null) return null;
        const pendingPath = paths.leadPending();
        const pending = existsSync(pendingPath) ? readFileSync(pendingPath, "utf8").trim() : "";
        const fresh = wakeMessage(takeWake());
        const wake = [pending, fresh].filter((text) => text !== "").join("\n\n");
        if (wake === "") return null;
        writeTextAtomic(pendingPath, `${wake}\n`);
        writeJsonAtomic(paths.leadState(), { ...state, pid: process.pid, ompPid: null } satisfies LeadState);
        return { wake, resume: sessionFile(paths.leadSessionsDir()), turn: state.turns + 1 };
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
        headlessPrompt(machineName(), claim.wake),
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
        const proc = Bun.spawn([resolved, ...argv.slice(1)], {
            cwd: root,
            env: process.env,
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

function pollMs(): number {
    const raw = process.env.TOLI_LEAD_POLL_MS;
    if (raw === undefined || raw === "") return POLL_MS;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0)
        throw new ToliError(`TOLI_LEAD_POLL_MS must be a positive integer (got "${raw}")`);
    return value;
}

/** `lead run [--once]`: the service loop, one pass every poll interval; `--once` makes one pass (the crontab form). */
async function serve(once: boolean): Promise<number> {
    const interval = pollMs();
    for (;;) {
        await leadPass();
        if (once) return 0;
        await Bun.sleep(interval);
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

// ---- the service in the OS scheduler ----

export function leadPlistPath(): string {
    return join(launchAgentsDir(), `${LEAD_LABEL}.plist`);
}

export function leadUnitPath(): string {
    return join(systemdUserDir(), LEAD_UNIT);
}

function serviceProgram(): string[] {
    return [bunPath(), paths.toliBin(), "lead", "run"];
}

/** The launchd agent: started at load and kept alive, at full priority (turns run omp, which jawans wait on). */
export function renderLeadPlist(): string {
    return renderLaunchdPlist({
        label: LEAD_LABEL,
        program: serviceProgram(),
        workingDirectory: paths.root(),
        env: { PATH: schedulePath() },
        runAtLoad: true,
        keepAlive: true,
        processType: "Interactive",
        stdoutPath: paths.leadLog(),
        stderrPath: paths.leadLog(),
    });
}

/** The systemd user service: a long-running `lead run`, restarted whenever it exits. */
export function renderLeadUnit(): string {
    const log = systemdPath(paths.leadLog());
    return [
        "[Unit]",
        "Description=toli lead (bin/toli lead run)",
        "",
        "[Service]",
        "Type=simple",
        `WorkingDirectory=${systemdPath(paths.root())}`,
        `Environment=${systemdEnv("PATH", schedulePath())}`,
        `ExecStart=${serviceProgram().map(systemdWord).join(" ")}`,
        "Restart=always",
        "RestartSec=10",
        `StandardOutput=append:${log}`,
        `StandardError=append:${log}`,
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ].join("\n");
}

/** Where neither launchd nor systemd works: one pass a minute (single-flight, so a long turn is never doubled). */
export function leadCronLine(): string {
    const command = [
        `cd ${shellQuote(paths.root())}`,
        `PATH=${shellQuote(schedulePath())} ${shellQuote(bunPath())} ${shellQuote(paths.toliBin())} lead run --once >> ${shellQuote(paths.leadLog())} 2>&1`,
    ].join(" && ");
    return `* * * * * ${command} ${LEAD_CRON_TAG}`;
}

/** A systemd user service stops at logout unless lingering is on; say so once at install. */
function lingerHint(): void {
    const user = process.env.USER ?? "";
    const result = run(["loginctl", "show-user", user, "--property=Linger"]);
    if (result.code === 0 && result.stdout.trim() === "Linger=yes") return;
    out(`note: the lead service stops at logout until lingering is on: loginctl enable-linger ${user}`.trimEnd());
}

function install(): void {
    mkdirSync(paths.logsDir(), { recursive: true });
    const scheduler = osScheduler();
    if (scheduler === "launchd") {
        const plist = renderLeadPlist();
        const target = leadPlistPath();
        if (dryRun()) {
            out(`# dry run: would write ${target}`);
            out(plist);
            out(`# would run: launchctl bootout ${guiDomain()}/${LEAD_LABEL} (if loaded)`);
            out(`# would run: launchctl bootstrap ${guiDomain()} ${target}`);
            return;
        }
        loadLaunchAgent(LEAD_LABEL, target, plist);
        out(`installed and loaded ${target}: the lead service runs now and at every login`);
        return;
    }
    if (scheduler === "systemd") {
        const unit = renderLeadUnit();
        const target = leadUnitPath();
        if (dryRun()) {
            out(`# dry run: would write ${target}`);
            out(unit);
            out(
                `# would run: systemctl --user daemon-reload && systemctl --user enable ${LEAD_UNIT} && systemctl --user restart ${LEAD_UNIT}`,
            );
            return;
        }
        writeTextAtomic(target, unit);
        mustRun(systemctl("daemon-reload"));
        mustRun(systemctl("enable", LEAD_UNIT));
        // restart, not start: a reinstall must pick up the rewritten unit.
        mustRun(systemctl("restart", LEAD_UNIT));
        out(`installed and started ${target}: the lead service runs now and at every login`);
        lingerHint();
        return;
    }
    const line = leadCronLine();
    const lines = [...readCrontab().filter((entry) => !entry.includes(LEAD_CRON_TAG)), line];
    if (dryRun()) {
        out("# dry run: would install crontab:");
        out(lines.join("\n"));
        return;
    }
    writeCrontab(lines);
    out(`installed crontab line: ${line}`);
}

function uninstall(): void {
    const scheduler = osScheduler();
    if (scheduler === "launchd") {
        const target = leadPlistPath();
        if (dryRun()) {
            out(`# dry run: would run launchctl bootout ${guiDomain()}/${LEAD_LABEL} (if loaded) and remove ${target}`);
            return;
        }
        out(unloadLaunchAgent(LEAD_LABEL, target) ? `uninstalled ${target}` : "no lead service installed");
        return;
    }
    if (scheduler === "systemd") {
        const target = leadUnitPath();
        if (dryRun()) {
            out(`# dry run: would run systemctl --user disable --now ${LEAD_UNIT} and remove ${target}`);
            return;
        }
        if (!existsSync(target)) {
            out("no lead service installed");
            return;
        }
        // A unit systemd no longer knows is not an error here; the file goes either way.
        run(systemctl("disable", "--now", LEAD_UNIT));
        rmSync(target, { force: true });
        mustRun(systemctl("daemon-reload"));
        out(`uninstalled ${target}`);
        return;
    }
    const lines = readCrontab();
    const kept = lines.filter((entry) => !entry.includes(LEAD_CRON_TAG));
    if (dryRun()) {
        out("# dry run: would install crontab:");
        out(kept.join("\n"));
        return;
    }
    if (kept.length !== lines.length) writeCrontab(kept);
    out(kept.length !== lines.length ? "removed the toli lead crontab line" : "no lead crontab line installed");
}

export type LeadServiceStatus = { scheduler: Scheduler; installed: boolean; running: boolean; detail: string };

/** Whether the lead service is installed in the scheduler in use, and running (a crontab line runs every minute). */
export function leadServiceStatus(): LeadServiceStatus {
    const scheduler = osScheduler();
    if (scheduler === "launchd") {
        const target = leadPlistPath();
        return { scheduler, installed: existsSync(target), running: launchctlLoaded(LEAD_LABEL), detail: target };
    }
    if (scheduler === "systemd") {
        const target = leadUnitPath();
        const running = run(systemctl("is-active", LEAD_UNIT)).stdout.trim() === "active";
        return { scheduler, installed: existsSync(target), running, detail: target };
    }
    const installed = readCrontab().some((entry) => entry.includes(LEAD_CRON_TAG));
    return { scheduler, installed, running: installed, detail: installed ? "crontab line present" : "no crontab line" };
}

export type LeadStatus = LeadServiceStatus & {
    /** The interactive lead session open on this machine (registered by the omp extension, or `lead attach`). */
    interactivePid: number | null;
    /** The lead conversation: the newest session file in state/lead/sessions/. */
    sessionFile: string | null;
    lastTurnAt: string | null;
    lastExit: number | null;
    turns: number;
    /** The process running a headless turn right now. */
    turnPid: number | null;
    /** A failed turn's wake text waits in state/lead/pending.md for the next pass. */
    pendingWake: boolean;
};

export function leadStatus(): LeadStatus {
    const state = readLeadState();
    return {
        ...leadServiceStatus(),
        interactivePid: interactiveLeadPid(),
        sessionFile: sessionFile(paths.leadSessionsDir()),
        lastTurnAt: state.lastTurnAt,
        lastExit: state.lastExit,
        turns: state.turns,
        turnPid: turnPid(state),
        pendingWake: existsSync(paths.leadPending()),
    };
}

function printStatus(status: LeadStatus): void {
    const service = status.installed ? `installed, ${status.running ? "running" : "not running"}` : "not installed";
    out(`service: ${status.scheduler} ${service} (${status.detail})`);
    out(`interactive: ${status.interactivePid === null ? "none" : `pid ${status.interactivePid}`}`);
    out(`conversation: ${status.sessionFile ?? "none yet"}`);
    out(
        status.lastTurnAt === null
            ? "last turn: none yet"
            : `last turn: ${status.lastTurnAt}, exit ${status.lastExit ?? "?"} (${status.turns} turn${status.turns === 1 ? "" : "s"})`,
    );
    if (status.turnPid !== null) out(`turn in progress: pid ${status.turnPid}`);
    out(`pending wake: ${status.pendingWake ? paths.leadPending() : "none"}`);
    if (!status.installed) out("warn: the lead service is not installed (bin/toli lead install)");
}

const USAGE = "usage: toli lead install|uninstall|status [--json]|run [--once]|attach";

export async function leadCommand(argv: string[]): Promise<number> {
    const [sub, ...rest] = argv;
    const args = new Args(rest, { booleans: ["json", "once"] });
    args.maxPositional(0);
    switch (sub) {
        case "install":
            install();
            return 0;
        case "uninstall":
            uninstall();
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
