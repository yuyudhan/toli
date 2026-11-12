// The disk keeper's Docker step (src/fleet/disk.ts, step 3): build cache and images no container uses, never volumes
// or containers (idle build-output volumes go only under the emergency level, in step 5: docker-volumes.ts). A prune
// deletes what a pull or build in flight has fetched but not yet tagged or started, so it
//   - waits while a `docker pull`, `build`, `buildx`, `compose up` or `load` runs (a process on this machine), and
//   - runs at most once per DOCKER_PRUNE_MIN_INTERVAL_MS; after a run that reclaimed 0 B it waits until free disk has
//     dropped DOCKER_PRUNE_FREE_DROP_GB below its level then, or DOCKER_PRUNE_IDLE_RETRY_MS has passed,
// so a minute tick under the floor with nothing left to reclaim no longer wipes images every minute.
// Above the emergency level only dangling images go (`docker image prune -f`); under it every image no container uses
// (`-af`), since by then free space matters more than a later pull.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { paths } from "../core/paths.ts";
import { now, run } from "../core/util.ts";
import { parseSize } from "./disk-caches.ts";

const DOCKER_PRUNE_TIMEOUT_MS = 30 * 60_000;
export const DOCKER_PRUNE_MIN_INTERVAL_MS = 30 * 60_000;
export const DOCKER_PRUNE_IDLE_RETRY_MS = 6 * 3_600_000;
export const DOCKER_PRUNE_FREE_DROP_GB = 1;

/** The last real prune: when, free disk before it, and the bytes it reclaimed (null when unknown: a step failed). */
export type DockerPruneState = { atMs: number; freeGB: number; reclaimedBytes: number | null };

export type DockerPruneInput = {
    /** A pull or build in flight (see dockerBusy), or null. */
    busy: string | null;
    last: DockerPruneState | null;
    nowMs: number;
    freeGB: number;
};

/** Why Docker must not be pruned now, or null when a prune is due. */
export function dockerPruneSkip(input: DockerPruneInput): string | null {
    if (input.busy !== null) return `${input.busy} is running; pruning now would delete what it fetched`;
    const last = input.last;
    if (last === null || last.atMs > input.nowMs) return null;
    const elapsed = input.nowMs - last.atMs;
    const minutes = Math.floor(elapsed / 60_000);
    if (elapsed < DOCKER_PRUNE_MIN_INTERVAL_MS)
        return `pruned ${minutes} min ago, at most once per ${DOCKER_PRUNE_MIN_INTERVAL_MS / 60_000} min`;
    const dropTo = last.freeGB - DOCKER_PRUNE_FREE_DROP_GB;
    if (last.reclaimedBytes === 0 && elapsed < DOCKER_PRUNE_IDLE_RETRY_MS && input.freeGB > dropTo)
        return `the prune ${minutes} min ago reclaimed 0 B; waiting for free space under ${dropTo.toFixed(1)} GB (now ${input.freeGB.toFixed(1)} GB) or ${DOCKER_PRUNE_IDLE_RETRY_MS / 3_600_000} h`;
    return null;
}

const DOCKER_PROGRAMS: Record<string, true> = { docker: true, "docker-compose": true, "docker-buildx": true };
const BUSY_WORDS: Record<string, true> = { pull: true, build: true, buildx: true, up: true, load: true };

/** A `docker pull`/`build`/`buildx`/`compose up`/`load` command line, from `ps` lines `<pid> <args>`; else null. */
export function dockerBusyFrom(psOutput: string, selfPid: number): string | null {
    for (const line of psOutput.split("\n")) {
        const match = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
        const pid = match?.[1];
        const args = match?.[2];
        if (pid === undefined || args === undefined || Number(pid) === selfPid) continue;
        const words = args.split(/\s+/);
        if (!Object.hasOwn(DOCKER_PROGRAMS, basename(words[0] ?? ""))) continue;
        if (words.slice(1).some((word) => Object.hasOwn(BUSY_WORDS, word)))
            return `pid ${pid} \`${args.length > 80 ? `${args.slice(0, 80)}...` : args}\``;
    }
    return null;
}

/** A pull or build running on this machine now, or null (also when `ps` cannot be read: a full disk keeps freeing). */
export function dockerBusy(): string | null {
    const listed = run(["ps", "-axww", "-o", "pid=,args="], { timeoutMs: 30_000 });
    return listed.code === 0 ? dockerBusyFrom(listed.stdout, process.pid) : null;
}

function readState(): DockerPruneState | null {
    try {
        const parsed = JSON.parse(readFileSync(paths.diskDockerPrune(), "utf8")) as Partial<DockerPruneState>;
        const reclaimed = parsed.reclaimedBytes;
        if (typeof parsed.atMs !== "number" || typeof parsed.freeGB !== "number") return null;
        return {
            atMs: parsed.atMs,
            freeGB: parsed.freeGB,
            reclaimedBytes: typeof reclaimed === "number" ? reclaimed : null,
        };
    } catch {
        return null;
    }
}

function writeState(state: DockerPruneState): void {
    try {
        mkdirSync(dirname(paths.diskDockerPrune()), { recursive: true });
        writeFileSync(paths.diskDockerPrune(), JSON.stringify(state));
    } catch {
        // A full disk: the next keeper run prunes once more, which is all this costs.
    }
}

export type DockerPruneContext = {
    dryRun: boolean;
    /** Free disk now, GB. */
    freeGB: number;
    /** Free disk is under the emergency level: unused tagged images go too. */
    emergency: boolean;
};

/** Docker build cache, then images no container uses, when due (see the top); `say` gets one line per step. */
export function pruneDocker(context: DockerPruneContext, say: (line: string) => void): void {
    const info = run(["docker", "info", "--format", "{{.ServerVersion}}"], { timeoutMs: 20_000 });
    if (info.code !== 0) {
        say(`docker: skipped (${info.code === 127 ? "not installed" : "daemon not reachable"})`);
        return;
    }
    const skip = dockerPruneSkip({
        busy: dockerBusy(),
        last: readState(),
        nowMs: now().getTime(),
        freeGB: context.freeGB,
    });
    if (skip !== null) {
        say(`docker: skipped (${skip})`);
        return;
    }
    const startedMs = now().getTime();
    let reclaimedBytes: number | null = 0;
    for (const step of [
        ["builder", "prune", "-af"],
        ["image", "prune", context.emergency ? "-af" : "-f"],
    ]) {
        const command = `docker ${step.join(" ")}`;
        if (context.dryRun) {
            say(`would run ${command}`);
            continue;
        }
        const result = run(["docker", ...step], { timeoutMs: DOCKER_PRUNE_TIMEOUT_MS });
        const reclaimed = /Total(?: reclaimed space)?:\s*(.+)$/im.exec(result.stdout)?.[1]?.trim();
        const bytes = result.code === 0 ? parseSize(reclaimed) : null;
        reclaimedBytes = reclaimedBytes === null || bytes === null ? null : reclaimedBytes + bytes;
        say(
            result.code === 0
                ? `ran ${command}: reclaimed ${reclaimed ?? "nothing reported"}`
                : `${command} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().split("\n")[0]}`,
        );
    }
    if (!context.dryRun) writeState({ atMs: startedMs, freeGB: context.freeGB, reclaimedBytes });
}
