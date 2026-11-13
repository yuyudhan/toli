// A live-stack project's dev stack (docs/projects.md "Live-stack mode") recompiles on every save. A build started in
// its checkout (a gate, a push check, `bin/toli build-slot`, a cargo through the shim) skips the heavy-build slots
// (src/fleet/build-slots.ts), so beside the stack's own recompile it doubles the load. While such a build runs, toli
// pauses the stack's auto-rebuild the way the project's notes declare, and resumes it once the last build in that
// checkout ends, however it ends:
//
//     ## Live stack mode
//     - Pause: `docker compose pause backend`
//     - Resume: `docker compose unpause backend`
//
//     ## Local stack
//     - Pause during builds: app-backend
//
// Both commands run with `sh -c` in the checkout; the named containers are paused with `docker pause`, never stopped
// (src/fleet/stack-pause.ts). The builds are counted by pid in state/build-slots/live-<project>.json: the first in
// pauses, the last out resumes, and a holder killed outright is dropped by the next build's end or the minute tick,
// which then resumes the stack. The record keeps what was paused and how to resume it, so a resume needs no notes.
// With nothing declared the build runs beside the stack, said once (state/build-slots/live-<project>.undeclared).
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../core/paths.ts";
import { pidAlive, readJson, run, warn, writeJsonAtomic, writeTextAtomic } from "../core/util.ts";
import { parseStackDeclaration, pauseContainers, unpauseContainers, withStackLock } from "./stack-pause.ts";

const COMMAND_TIMEOUT_MS = 120_000;
const SECTION = /^## Live stack mode\s*$/i;
const HEADING = /^## /;
const COMMAND = /^\s*[-*]\s*(pause|resume)\s*:\s*`([^`]+)`\s*$/i;
const RECORD_FILE = /^live-(.+)\.json$/;

/** How a live-stack project's notes say to pause and resume its stack's auto-rebuild. */
export type LiveStackDeclaration = { pause: string | null; resume: string | null; containers: string[] };

/** What a pause did, enough to undo it without the notes: the resume command still owed, the containers paused. */
type Paused = { dir: string; resume: string | null; containers: string[] };

/** The builds running in a live-stack checkout (their pids, one entry per build) and what their pause did. */
type LiveRecord = { holders: number[]; paused: Paused | null };

const recordFile = (project: string): string => join(paths.buildSlotsDir(), `live-${project}.json`);
const undeclaredFile = (project: string): string => join(paths.buildSlotsDir(), `live-${project}.undeclared`);

/** A notes file's `## Live stack mode` `- Pause:` / `- Resume:` commands and its `## Local stack` containers. */
export function parseLiveStackDeclaration(notes: string): LiveStackDeclaration {
    const declared: LiveStackDeclaration = { pause: null, resume: null, containers: [] };
    let inSection = false;
    for (const line of notes.split("\n")) {
        if (HEADING.test(line)) {
            inSection = SECTION.test(line);
            continue;
        }
        const match = inSection ? COMMAND.exec(line) : null;
        if (match?.[1] === undefined || match[2] === undefined) continue;
        if (match[1].toLowerCase() === "pause") declared.pause = match[2].trim();
        else declared.resume = match[2].trim();
    }
    declared.containers = parseStackDeclaration(notes).containers;
    return declared;
}

function declarationOf(project: string): LiveStackDeclaration {
    const file = paths.projectNotes(project);
    return parseLiveStackDeclaration(existsSync(file) ? readFileSync(file, "utf8") : "");
}

function readRecord(project: string): LiveRecord {
    const record = readJson<Partial<LiveRecord>>(recordFile(project), {});
    return { holders: Array.isArray(record.holders) ? record.holders : [], paused: record.paused ?? null };
}

function writeRecord(project: string, record: LiveRecord): void {
    if (record.holders.length === 0 && record.paused === null) rmSync(recordFile(project), { force: true });
    else writeJsonAtomic(recordFile(project), record);
}

/** Say once (until the project declares a way again) that its stack keeps rebuilding beside its builds. */
function sayUndeclaredOnce(project: string, declared: LiveStackDeclaration): void {
    if (existsSync(undeclaredFile(project))) return;
    let why = "its notes declare no way to pause its stack";
    if (declared.pause !== null) why = "its notes declare its stack's `- Pause:` command without `- Resume:`";
    if (declared.resume !== null) why = "its notes declare its stack's `- Resume:` command without `- Pause:`";
    warn(
        `toli: ${project}: live-stack mode, but ${why} (docs/projects.md "Live-stack mode"); ` +
            "this build runs beside its rebuilds",
    );
    writeTextAtomic(undeclaredFile(project), `${new Date().toISOString()}\n`);
}

/** Pause the stack as declared; null when nothing declared is usable or nothing was paused. */
function pauseStack(project: string, dir: string, declared: LiveStackDeclaration): Paused | null {
    let resume: string | null = null;
    if (declared.pause !== null && declared.resume !== null) {
        const result = run(["sh", "-c", declared.pause], { cwd: dir, timeoutMs: COMMAND_TIMEOUT_MS });
        if (result.code === 0) resume = declared.resume;
        else
            warn(
                `toli: ${project}: could not pause its stack with \`${declared.pause}\`: ${result.stderr.trim() || `exit ${result.code}`}`,
            );
    }
    const containers = pauseContainers(declared.containers);
    return resume === null && containers.length === 0 ? null : { dir, resume, containers };
}

/** Undo `paused`; returns what is still paused (warned about with the command that fixes it), or null. */
function resumeStack(project: string, paused: Paused): Paused | null {
    let resume = paused.resume;
    if (resume !== null) {
        const result = run(["sh", "-c", resume], { cwd: paused.dir, timeoutMs: COMMAND_TIMEOUT_MS });
        if (result.code === 0) resume = null;
        else
            warn(
                `toli: ${project}: could not resume its stack: ${result.stderr.trim() || `exit ${result.code}`}; run \`${resume}\` in ${paused.dir}`,
            );
    }
    const containers = unpauseContainers(paused.containers);
    return resume === null && containers.length === 0 ? null : { ...paused, resume, containers };
}

/** Count this process in as a build in `project`'s checkout, pausing its stack when it is the first. */
function countIn(project: string): void {
    withStackLock(() => {
        const record = readRecord(project);
        const holders = record.holders.filter(pidAlive);
        let paused = record.paused;
        if (holders.length === 0 && paused === null) {
            const declared = declarationOf(project);
            const commands = declared.pause !== null && declared.resume !== null;
            if (!commands && declared.containers.length === 0) {
                sayUndeclaredOnce(project, declared);
                return;
            }
            rmSync(undeclaredFile(project), { force: true });
            paused = pauseStack(project, paths.projectDir(project), declared);
        }
        writeRecord(project, { holders: [...holders, process.pid], paused });
    });
}

/**
 * Drop `leaving`'s entry (null: none) and every holder that died, then resume the stack once none is left. A resume
 * that fails stays recorded for the next build's end or tick.
 */
function settle(project: string, leaving: number | null): void {
    withStackLock(() => {
        const record = readRecord(project);
        const at = leaving === null ? -1 : record.holders.indexOf(leaving);
        const holders = record.holders.filter((pid, index) => index !== at && pidAlive(pid));
        const paused =
            holders.length === 0 && record.paused !== null ? resumeStack(project, record.paused) : record.paused;
        writeRecord(project, { holders, paused });
    });
}

/** Run `step`, never failing the build: an error is warned about with what it left undone. */
function safely(project: string, undone: string, step: () => void): void {
    try {
        step();
    } catch (error) {
        warn(`toli: ${project}: live stack ${undone}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Run `body`, a build in live-stack `project`'s checkout, with the project's stack auto-rebuild paused for as long as
 * any such build runs; it is resumed when the last one ends, whether it passed, failed or was stopped.
 */
export async function whileLiveStackPaused<T>(project: string, body: () => Promise<T>): Promise<T> {
    safely(project, "not paused", () => countIn(project));
    try {
        return await body();
    } finally {
        safely(project, "not resumed", () => settle(project, process.pid));
    }
}

/** Resume each live stack whose builds all died without resuming it (a holder killed outright): the minute tick's. */
export function resumeAbandonedLiveStacks(): void {
    if (!existsSync(paths.buildSlotsDir())) return;
    for (const name of readdirSync(paths.buildSlotsDir())) {
        const project = RECORD_FILE.exec(name)?.[1];
        if (project !== undefined) safely(project, "not resumed", () => settle(project, null));
    }
}
