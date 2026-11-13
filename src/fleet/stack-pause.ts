// Dev-stack containers that rebuild on save, paused while a heavy build holds a slot (docs/fleet.md "Dev stacks and
// heavy builds"). A watch container compiling its project inside Docker is a build outside every slot: next to a gate
// it doubles the load and fills the disk with its own target copy. A project declares such containers in its notes'
// `## Local stack` section, on one line:
//
//     - Pause during builds: app-backend, app-frontend
//
// Whoever takes a heavy-build slot (src/fleet/build-slots.ts, src/fleet/cargo-slot.ts) pauses the declared containers
// that run (`docker pause`: processes frozen, data and memory kept), and whoever frees the last busy slot with nobody
// waiting unpauses them. The paused names are recorded in state/build-slots/stacks.paused, so the unpause needs no
// notes and a stack paused by a holder that was killed is resumed by the next idle moment (any slot freed, or the
// minute tick). Containers are only ever paused and unpaused: never stopped, removed or inspected beyond their status.
// Live-stack projects' declarations are ignored: their stack is the machine's one build (docs/projects.md).
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../core/paths.ts";
import { run, warn, writeTextAtomic } from "../core/util.ts";
import { loadProjects } from "../projects/projects.ts";
import { flock, LOCK_EX } from "./cargo-lock.ts";

const DOCKER_TIMEOUT_MS = 20_000;
const SECTION = /^## Local stack\s*$/i;
const HEADING = /^## /;
const DECLARATION = /^\s*[-*]\s*pause during builds\s*:\s*(.+?)\s*$/i;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const pausedFile = (): string => join(paths.buildSlotsDir(), "stacks.paused");
const lockFile = (): string => join(paths.buildSlotsDir(), "stacks.lock");

/** The containers a notes file's `## Local stack` section declares to pause during builds, and names it could not use. */
export function parseStackDeclaration(notes: string): { containers: string[]; invalid: string[] } {
    const containers: string[] = [];
    const invalid: string[] = [];
    let inSection = false;
    for (const line of notes.split("\n")) {
        if (HEADING.test(line)) {
            inSection = SECTION.test(line);
            continue;
        }
        const match = inSection ? DECLARATION.exec(line) : null;
        if (match === null) continue;
        for (const word of (match[1] ?? "").split(/[\s,]+/)) {
            const name = word.replaceAll("`", "");
            if (name === "") continue;
            if (!CONTAINER_NAME.test(name)) invalid.push(name);
            else if (!containers.includes(name)) containers.push(name);
        }
    }
    return { containers, invalid };
}

/** Every project's declared containers, live-stack projects excluded; unusable names are reported once per call. */
function declaredContainers(): string[] {
    const names: string[] = [];
    for (const project of loadProjects()) {
        if (project.liveStack === true) continue;
        const file = paths.projectNotes(project.name);
        if (!existsSync(file)) continue;
        const declared = parseStackDeclaration(readFileSync(file, "utf8"));
        for (const bad of declared.invalid)
            warn(`toli: ${project.name}: "${bad}" is not a container name, not paused during builds`);
        for (const name of declared.containers) if (!names.includes(name)) names.push(name);
    }
    return names;
}

function readPaused(): string[] {
    try {
        return readFileSync(pausedFile(), "utf8")
            .split("\n")
            .filter((name) => name !== "");
    } catch {
        return [];
    }
}

function writePaused(names: string[]): void {
    if (names.length === 0) rmSync(pausedFile(), { force: true });
    else writeTextAtomic(pausedFile(), `${names.join("\n")}\n`);
}

/** Run `body` holding the stacks lock (blocking: every docker call inside is bounded by its timeout). */
function withStackLock(body: () => void): void {
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
 * Pause every declared container that runs, once a build holds a slot. Never fails the build: a container that
 * cannot be paused is warned about and left running.
 */
export function pauseDevStacks(): void {
    try {
        const names = declaredContainers();
        if (names.length === 0) return;
        withStackLock(() => {
            const paused = readPaused();
            for (const name of names) {
                if (containerStatus(name) !== "running") continue;
                const result = run(["docker", "pause", name], { timeoutMs: DOCKER_TIMEOUT_MS });
                if (result.code === 0) paused.push(name);
                else
                    warn(
                        `toli: could not pause ${name} for the build: ${result.stderr.trim() || `exit ${result.code}`}`,
                    );
            }
            writePaused([...new Set(paused)]);
        });
    } catch (error) {
        warn(`toli: dev stacks not paused: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** What `docker unpause` says about a container that needs no unpausing any more. */
const GONE = /is not paused|no such container|no such object/i;

/**
 * Unpause the containers `pauseDevStacks` paused, when `idle` says no build holds or awaits a slot (asked under the
 * stacks lock, after a holder freed its slot, so the last one out always sees it). A failed unpause is warned about
 * with the command that fixes it, and the container stays recorded for the next idle moment.
 */
export function resumeDevStacks(idle: () => boolean): void {
    if (!existsSync(pausedFile())) return;
    try {
        withStackLock(() => {
            if (!idle()) return;
            const stuck: string[] = [];
            for (const name of readPaused()) {
                const result = run(["docker", "unpause", name], { timeoutMs: DOCKER_TIMEOUT_MS });
                if (result.code === 0 || GONE.test(result.stderr)) continue;
                warn(
                    `toli: could not unpause ${name}: ${result.stderr.trim() || `exit ${result.code}`}; run \`docker unpause ${name}\``,
                );
                stuck.push(name);
            }
            writePaused(stuck);
        });
    } catch (error) {
        warn(`toli: dev stacks not unpaused: ${error instanceof Error ? error.message : String(error)}; see docker ps`);
    }
}
