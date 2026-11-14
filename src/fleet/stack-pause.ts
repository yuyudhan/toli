// Dev-stack containers that rebuild on save, paused or stopped while a heavy build holds a slot (docs/fleet.md "Dev
// stacks and heavy builds"). A watch container compiling its project inside Docker is a build outside every slot: next
// to a gate it doubles the load and fills the disk with its own target copy. A project declares such containers in its
// notes' `## Local stack` section, one line per way:
//
//     - Pause during builds: app-frontend
//     - Stop during builds: app-backend
//
// Whoever takes a heavy-build slot (src/fleet/build-slots.ts, src/fleet/cargo-slot.ts) pauses (`docker pause`:
// processes frozen, data and memory kept) or stops (`docker stop`: memory freed, data kept) the declared containers
// that run, and whoever frees the last busy slot with nobody waiting unpauses or starts them again. A container named
// on both lines is stopped. The names are recorded in state/build-slots/stacks.paused and stacks.stopped, so the
// resume needs no notes and a stack left by a holder that was killed is resumed by the next idle moment (any slot
// freed, or the minute tick). Containers are only ever paused, unpaused, stopped and started: never removed or
// inspected beyond their status. A live-stack project's declaration is handled per build instead
// (src/fleet/live-stack-pause.ts).
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../core/paths.ts";
import { run, warn, writeTextAtomic } from "../core/util.ts";
import { loadProjects } from "../projects/projects.ts";
import { flock, LOCK_EX } from "./cargo-lock.ts";

const DOCKER_TIMEOUT_MS = 20_000;
/** `docker stop` waits up to 10 s for the container to exit before killing it; leave room for that. */
const DOCKER_STOP_TIMEOUT_MS = 40_000;
const SECTION = /^## Local stack\s*$/i;
const HEADING = /^## /;
const DECLARATION = /^\s*[-*]\s*(pause|stop) during builds\s*:\s*(.+?)\s*$/i;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const pausedFile = (): string => join(paths.buildSlotsDir(), "stacks.paused");
const stoppedFile = (): string => join(paths.buildSlotsDir(), "stacks.stopped");
const lockFile = (): string => join(paths.buildSlotsDir(), "stacks.lock");

/** A `## Local stack` section's containers to pause and to stop during builds, and names it could not use. */
export type StackDeclaration = { containers: string[]; stop: string[]; invalid: string[] };

/**
 * The containers a notes file's `## Local stack` section declares to pause (`containers`) and to stop (`stop`) during
 * builds, and names it could not use. A container on both lines is only stopped.
 */
export function parseStackDeclaration(notes: string): StackDeclaration {
    const pause: string[] = [];
    const stop: string[] = [];
    const invalid: string[] = [];
    let inSection = false;
    for (const line of notes.split("\n")) {
        if (HEADING.test(line)) {
            inSection = SECTION.test(line);
            continue;
        }
        const match = inSection ? DECLARATION.exec(line) : null;
        if (match === null) continue;
        const into = match[1]?.toLowerCase() === "stop" ? stop : pause;
        for (const word of (match[2] ?? "").split(/[\s,]+/)) {
            const name = word.replaceAll("`", "");
            if (name === "") continue;
            if (!CONTAINER_NAME.test(name)) invalid.push(name);
            else if (!into.includes(name)) into.push(name);
        }
    }
    return { containers: pause.filter((name) => !stop.includes(name)), stop, invalid };
}

/** Every project's declared containers, live-stack projects excluded; unusable names are reported once per call. */
function declaredContainers(): { pause: string[]; stop: string[] } {
    const pause = new Set<string>();
    const stop = new Set<string>();
    for (const project of loadProjects()) {
        if (project.liveStack === true) continue;
        const file = paths.projectNotes(project.name);
        if (!existsSync(file)) continue;
        const declared = parseStackDeclaration(readFileSync(file, "utf8"));
        for (const bad of declared.invalid)
            warn(`toli: ${project.name}: "${bad}" is not a container name, not paused during builds`);
        for (const name of declared.containers) pause.add(name);
        for (const name of declared.stop) stop.add(name);
    }
    return { pause: [...pause].filter((name) => !stop.has(name)), stop: [...stop] };
}

function readNames(file: string): string[] {
    try {
        return readFileSync(file, "utf8")
            .split("\n")
            .filter((name) => name !== "");
    } catch {
        return [];
    }
}

function writeNames(file: string, names: string[]): void {
    if (names.length === 0) rmSync(file, { force: true });
    else writeTextAtomic(file, `${names.join("\n")}\n`);
}

/** Run `body` holding the stacks lock (blocking: every docker call inside is bounded by its timeout). */
export function withStackLock(body: () => void): void {
    const lock = flock();
    if (lock === null) {
        body();
        return;
    }
    mkdirSync(paths.buildSlotsDir(), { recursive: true });
    const fd = openSync(lockFile(), "a");
    try {
        if (lock(fd, LOCK_EX) !== 0) throw new Error(`cannot lock ${lockFile()}`);
        body();
    } finally {
        closeSync(fd);
    }
}

/** A container's status (`running`, `paused`, `exited`, ...), or null when Docker is absent or does not know it. */
function containerStatus(name: string): string | null {
    const result = run(["docker", "inspect", "--format", "{{.State.Status}}", name], { timeoutMs: DOCKER_TIMEOUT_MS });
    return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * Run docker `verb` (`pause` or `stop`) on each of `names` that runs; returns those it succeeded on. One it fails on
 * is warned about and left running.
 */
function haltContainers(verb: "pause" | "stop", names: string[]): string[] {
    const halted: string[] = [];
    for (const name of names) {
        if (containerStatus(name) !== "running") continue;
        const timeoutMs = verb === "stop" ? DOCKER_STOP_TIMEOUT_MS : DOCKER_TIMEOUT_MS;
        const result = run(["docker", verb, name], { timeoutMs });
        if (result.code === 0) halted.push(name);
        else warn(`toli: could not ${verb} ${name} for the build: ${result.stderr.trim() || `exit ${result.code}`}`);
    }
    return halted;
}

/** Pause each of `names` that runs; returns those paused. One that cannot be paused is warned about and left running. */
export function pauseContainers(names: string[]): string[] {
    return haltContainers("pause", names);
}

/**
 * Stop each of `names` that runs (`docker stop`: its memory is freed, its data kept); returns those stopped. One that
 * cannot be stopped is warned about and left running.
 */
export function stopContainers(names: string[]): string[] {
    return haltContainers("stop", names);
}

/**
 * Pause or stop every declared container that runs, once a build holds a slot. Never fails the build: a container
 * that cannot be paused or stopped is warned about and left running.
 */
export function pauseDevStacks(): void {
    try {
        const declared = declaredContainers();
        if (declared.pause.length === 0 && declared.stop.length === 0) return;
        withStackLock(() => {
            writeNames(pausedFile(), [...new Set([...readNames(pausedFile()), ...pauseContainers(declared.pause)])]);
            writeNames(stoppedFile(), [...new Set([...readNames(stoppedFile()), ...stopContainers(declared.stop)])]);
        });
    } catch (error) {
        warn(`toli: dev stacks not paused: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** What `docker unpause` or `docker start` says about a container that needs no resuming any more. */
const GONE = /is not paused|no such container|no such object/i;

/**
 * Run docker `verb` (`unpause` or `start`) on each of `names`; returns those it failed on, each warned about with the
 * command that fixes it.
 */
function resumeContainers(verb: "unpause" | "start", names: string[]): string[] {
    const stuck: string[] = [];
    for (const name of names) {
        const result = run(["docker", verb, name], { timeoutMs: DOCKER_TIMEOUT_MS });
        if (result.code === 0 || GONE.test(result.stderr)) continue;
        warn(
            `toli: could not ${verb} ${name}: ${result.stderr.trim() || `exit ${result.code}`}; run \`docker ${verb} ${name}\``,
        );
        stuck.push(name);
    }
    return stuck;
}

/** Unpause each of `names`; returns those still paused. A failed unpause is warned about with the command that fixes it. */
export function unpauseContainers(names: string[]): string[] {
    return resumeContainers("unpause", names);
}

/** Start each of `names` again; returns those still stopped. A failed start is warned about with the command that fixes it. */
export function startContainers(names: string[]): string[] {
    return resumeContainers("start", names);
}

/**
 * Unpause and start again the containers `pauseDevStacks` paused or stopped, when `idle` says no build holds or awaits
 * a slot (asked under the stacks lock, after a holder freed its slot, so the last one out always sees it). A container
 * that fails to resume stays recorded for the next idle moment.
 */
export function resumeDevStacks(idle: () => boolean): void {
    if (!existsSync(pausedFile()) && !existsSync(stoppedFile())) return;
    try {
        withStackLock(() => {
            if (!idle()) return;
            writeNames(pausedFile(), unpauseContainers(readNames(pausedFile())));
            writeNames(stoppedFile(), startContainers(readNames(stoppedFile())));
        });
    } catch (error) {
        warn(`toli: dev stacks not resumed: ${error instanceof Error ? error.message : String(error)}; see docker ps`);
    }
}
