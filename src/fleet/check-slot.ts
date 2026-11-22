// The heavy-build slot of a project's check (a gate's recipe, a push running its pre-push hook): one slot for its whole
// run (`withBuildSlot`), or, for a project set `--slot-at-heavy-step yes`, one taken at its first heavy step and held
// to its end (src/fleet/heavy-step-slot.ts, T2257).
import { closeSync, existsSync } from "node:fs";
import { warn } from "../core/util.ts";
import { runMinuteMs } from "../jawans/runs.ts";
import { loadProjects } from "../projects/projects.ts";
import { POLL_MS, slotHolder, takeInTurn } from "./build-queue.ts";
import {
    type HeldSlot,
    liveStackProjectAt,
    resumeDevStacksWhenIdle,
    runInSlot,
    slotSizing,
    withBuildSlot,
} from "./build-slots.ts";
import { flock, LOCK_UN } from "./cargo-lock.ts";
import { enclosingSlot } from "./enclosing-slot.ts";
import { clearSlotRequest, DEFERRED_SLOT_ENV, deferredSlotRun, slotRequestFile } from "./heavy-step-slot.ts";
import { pauseLiveStacks, resumeLiveStacks, whileStackInUse } from "./live-stack-pause.ts";
import { pauseDevStacks } from "./stack-pause.ts";

/** The most minutes a check waiting at its first heavy step goes without saying it still waits. */
const SLOT_NOTE_MAX_MINUTES = 5;

/**
 * Run `body`, a project's check (a gate's recipe, a push running its pre-push hook), as `withBuildSlot` does: in one
 * heavy-build slot for its whole run. A `project` that declares its check takes the slot at its first heavy step
 * (`project set --slot-at-heavy-step yes`) runs it under `withSlotAtHeavyStep` instead, saying it still waits every
 * third of the gate's `stallMinutes` (null: a push, no stall check), at most every `SLOT_NOTE_MAX_MINUTES`, so the
 * wait never reads as a stall. `project`'s own stack is kept running either way (`whileStackInUse`).
 */
export async function withCheckSlot<T>(
    cwd: string,
    project: string,
    stallMinutes: number | null,
    body: (held: HeldSlot) => Promise<T>,
): Promise<T> {
    if (!loadProjects().some((entry) => entry.name === project && entry.slotAtHeavyStep === true))
        return await withBuildSlot(cwd, project, body);
    const noteMinutes = Math.min(SLOT_NOTE_MAX_MINUTES, (stallMinutes ?? Number.POSITIVE_INFINITY) / 3);
    return await withSlotAtHeavyStep(cwd, project, noteMinutes * runMinuteMs(), body);
}

/**
 * `command` under `withCheckSlot` (no stall check), with `env` and the slot's variables, in the slot's scope
 * (`runInSlot`): `bin/toli push` running `git push`, and so its pre-push hook. Resolves to its exit code.
 */
export async function runCheckInSlot(
    cwd: string,
    project: string,
    command: string[],
    env: Record<string, string>,
): Promise<number> {
    return await withCheckSlot(cwd, project, null, (held) => runInSlot(command, { ...env, ...held.env }, held.scope));
}

/**
 * Run `body`, a check whose heavy steps go through `bin/toli build-slot` (src/fleet/heavy-step-slot.ts), without a
 * slot: it gets this process's pid as TOLI_DEFERRED_SLOT and no scope, so its cheap steps run at once. Once a heavy
 * step asks for the slot, this process waits in line for one (saying so, then again every `noteEveryMs`), pauses the
 * stacks as `withBuildSlot` does and holds the slot until `body` ends. A check that never reaches a heavy step, or
 * fails before one, never queues. Inside a slot already, in a live-stack project's checkout or without flock(2) it
 * runs as `withBuildSlot` does; inside another such check, its heavy steps take that check's slot.
 */
async function withSlotAtHeavyStep<T>(
    cwd: string,
    stackUser: string | null,
    noteEveryMs: number,
    body: (held: HeldSlot) => Promise<T>,
): Promise<T> {
    if (deferredSlotRun() !== null) return await whileStackInUse(stackUser, () => body({ env: {}, scope: null }));
    const lock = flock();
    if (lock === null || enclosingSlot() !== null || liveStackProjectAt(cwd) !== null)
        return await withBuildSlot(cwd, stackUser, body);
    const { capacity } = slotSizing();
    const run = process.pid;
    clearSlotRequest(run);
    const state: { ended: boolean; held: { index: number; fd: number } | null } = { ended: false, held: null };
    const serve = (async (): Promise<void> => {
        while (!state.ended && !existsSync(slotRequestFile(run))) await Bun.sleep(POLL_MS);
        if (state.ended) return;
        const note = setInterval(
            () => warn(`toli: still waiting for a heavy-build slot (${capacity.buildSlots} busy)`),
            noteEveryMs,
        );
        try {
            state.held = await takeInTurn(capacity, lock, slotHolder(cwd), run, () => !state.ended);
        } finally {
            clearInterval(note);
        }
        if (state.held === null) return;
        pauseDevStacks();
        pauseLiveStacks();
    })();
    try {
        return await whileStackInUse(stackUser, () => body({ env: { [DEFERRED_SLOT_ENV]: String(run) }, scope: null }));
    } finally {
        state.ended = true;
        await serve;
        clearSlotRequest(run);
        if (state.held !== null) {
            lock(state.held.fd, LOCK_UN);
            closeSync(state.held.fd);
            resumeLiveStacks();
            resumeDevStacksWhenIdle();
        }
    }
}
