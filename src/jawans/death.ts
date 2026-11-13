// Why a run's processes died, for the outcome it records. A harness that dies by a signal names it ("killed by
// SIGKILL"); on Linux, where it runs in its own `toli-jawan-<run id>.scope` (src/jawans/scope.ts), the journal says
// whether systemd-oomd or the kernel OOM killer sent it: the user manager logs `<unit>: systemd-oomd killed 86
// process(es) in this unit.` or `A process of this unit has been killed by the OOM killer.`, and systemd-oomd itself
// logs `Killed <cgroup>/<unit> due to memory pressure for ...`. A run whose supervisor is gone without recording an
// outcome is reconciled by the next `listRuns` (the tick, the digest) with the best cause found: a signal the
// supervisor noted before it died, the journal, the harness's own last words in its log, or its supervisor.log.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive, platform, run } from "../core/util.ts";

const JOURNAL_TIMEOUT_MS = 5_000;
/** The journal lines a cause is read from, newest last; older lines of a long run's scope do not matter. */
const JOURNAL_LINES = 200;

/** What the journal says killed a run's scope. */
export type JournalKill = { by: "systemd-oomd" | "the kernel OOM killer"; processes: number | null; reason: string };

/** Whether a journal line is about one of run `runId`'s scopes (its supervisor's or its harness's, any attempt). */
function aboutRun(line: string, runId: string): boolean {
    return [`toli-jawan-${runId}.scope`, `toli-jawan-${runId}-`, `toli-supervisor-${runId}.scope`].some((unit) =>
        line.includes(unit),
    );
}

/** The kill the journal `lines` record for run `runId`'s scopes, or null when they record none. */
export function parseJournalKill(lines: string[], runId: string): JournalKill | null {
    let reason = "";
    let processes: number | null = null;
    let oomd = false;
    let kernel = false;
    for (const line of lines) {
        if (!aboutRun(line, runId)) continue;
        const killed = /\bKilled \S+ due to (.+?)\.?\s*$/.exec(line);
        const counted = /systemd-oomd killed (\d+) process/.exec(line);
        if (killed?.[1] !== undefined) reason = killed[1];
        if (counted?.[1] !== undefined) processes = Number(counted[1]);
        oomd ||= killed !== null || counted !== null;
        kernel ||= /killed by the OOM killer/i.test(line);
    }
    if (oomd) return { by: "systemd-oomd", processes, reason };
    return kernel ? { by: "the kernel OOM killer", processes: null, reason: "" } : null;
}

/** `killed by systemd-oomd (SIGKILL, 86 processes): memory pressure for /user.slice ...`. */
export function killText(kill: JournalKill, signal: string | null): string {
    const details = [signal, kill.processes === null ? null : `${kill.processes} processes`].filter(
        (part): part is string => part !== null,
    );
    return `killed by ${kill.by}${details.length === 0 ? "" : ` (${details.join(", ")})`}${kill.reason === "" ? "" : `: ${kill.reason}`}`;
}

function journalLines(args: string[]): string[] {
    const result = run(["journalctl", "--quiet", "--no-pager", "--output=cat", `--lines=${JOURNAL_LINES}`, ...args], {
        timeoutMs: JOURNAL_TIMEOUT_MS,
    });
    return result.code === 0 ? result.stdout.split("\n") : [];
}

/**
 * What the journal says killed run `runId`'s scopes since `startedAt`, or null: off Linux, without journalctl, with no
 * such line, or with `TOLI_JOURNAL=off` (tests). The user journal holds the user manager's lines about the scope; the
 * system journal holds systemd-oomd's own, readable when the user may read it (the `adm` or `systemd-journal` group).
 */
export function journalKill(runId: string, startedAt: string): JournalKill | null {
    if (platform() !== "linux" || process.env.TOLI_JOURNAL === "off") return null;
    const startedMs = Date.parse(startedAt);
    const since = `--since=@${Math.floor((Number.isNaN(startedMs) ? Date.now() : startedMs) / 1000)}`;
    const lines = [
        ...journalLines(["--user", since, `--unit=toli-*-${runId}*.scope`]),
        ...journalLines([since, "--identifier=systemd-oomd"]),
    ];
    return parseJournalKill(lines, runId);
}

/**
 * The error a run whose harness died by `signal` records: what the journal says sent it, else the signal itself.
 * The user manager logs the scope's kill as the scope stops, a moment after the harness is reaped, so the journal is
 * read up to `tries` times, `waitMs` apart.
 */
export async function signalDeathText(
    runId: string,
    startedAt: string,
    signal: string,
    options: { tries: number; waitMs: number } = { tries: 3, waitMs: 1_000 },
): Promise<string> {
    for (let attempt = 1; attempt <= options.tries; attempt++) {
        const kill = journalKill(runId, startedAt);
        if (kill !== null) return killText(kill, signal);
        if (platform() !== "linux" || process.env.TOLI_JOURNAL === "off" || attempt === options.tries) break;
        await Bun.sleep(options.waitMs);
    }
    return `killed by ${signal}`;
}

/** The last non-empty line of a file, or null. */
function lastLine(path: string): string | null {
    if (!existsSync(path)) return null;
    const lines = readFileSync(path, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    return lines.at(-1) ?? null;
}

/** A harness's own record of the signal that stopped it, as omp prints it (`[Stopped by SIGTERM]`). */
export function stoppedBySignal(logText: string): string | null {
    const matches = [...logText.matchAll(/\[Stopped by (SIG[A-Z0-9]+)\]/g)];
    return matches.at(-1)?.[1] ?? null;
}

/** The parts of an orphaned run's record its cause is read from. */
export type OrphanRun = {
    id: string;
    startedAt: string;
    runDir: string;
    logPath: string;
    pid: number | null;
    supervisorSignal?: { signal: string; at: string };
};

/**
 * The error recorded for a run whose supervisor is gone without recording an outcome: the supervisor's death, then
 * every cause found, then whether its harness is still running unsupervised.
 */
export function orphanCause(record: OrphanRun): string {
    const causes: string[] = [];
    if (record.supervisorSignal !== undefined)
        causes.push(`the supervisor got ${record.supervisorSignal.signal} at ${record.supervisorSignal.at}`);
    const kill = journalKill(record.id, record.startedAt);
    if (kill !== null) causes.push(killText(kill, null));
    const logText = existsSync(record.logPath) ? readFileSync(record.logPath, "utf8") : "";
    const stopped = stoppedBySignal(logText.slice(-4_000));
    if (stopped !== null) causes.push(`the harness was stopped by ${stopped}`);
    const supervisorLog = lastLine(join(record.runDir, "supervisor.log"));
    if (causes.length === 0 && supervisorLog !== null) causes.push(`supervisor.log ends: ${supervisorLog}`);
    const harness =
        record.pid === null
            ? "its harness never started"
            : pidAlive(record.pid)
              ? `its harness (pid ${record.pid}) is still running unsupervised`
              : `its harness (pid ${record.pid}) is gone too`;
    const cause = causes.length === 0 ? "no cause found in the journal or the logs" : causes.join("; ");
    return `the supervisor exited without recording an outcome: ${cause}; ${harness}`;
}
