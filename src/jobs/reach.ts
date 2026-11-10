// Which fleet hosts the tick's ssh calls can skip (docs/fleet.md "Unreachable machines"). One pass of the tick's
// messaging (the pull, then the outbox delivery) tries each host at most until its first failure: after that, that
// host's remaining calls in the pass are skipped, so its later items keep their order and nobody waits on its ssh
// timeout twice. A host the tick's ssh could not reach (ssh's own exit 255, or the call's timeout) is also backed off
// across ticks in state/reach.json: 30 s after the first failure, doubling with each one after, at most 10 minutes.
// Any call that reaches it clears that.
import { paths } from "../core/paths.ts";
import { now, readJson, withLock, writeJsonAtomic } from "../core/util.ts";

export const BACKOFF_FIRST_MS = 30_000;
export const BACKOFF_MAX_MS = 10 * 60_000;

/** state/reach.json: per ssh name, the failures in a row and when the tick tries it again. */
export type ReachState = Record<string, { failures: number; retryAt: number; error: string }>;

/** How long the tick leaves a host alone after `failures` failures in a row. */
export function backoffMs(failures: number): number {
    return Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

/** Whether an ssh call's result means the host was not reached: ssh's own failure (255) or the call timed out. */
export function unreached(result: { code: number; timedOut?: boolean }): boolean {
    return result.code === 255 || result.timedOut === true;
}

export function readReach(): ReachState {
    return readJson<ReachState>(paths.reachState(), {});
}

function updateReach(change: (state: ReachState) => boolean): void {
    withLock(paths.lock("reach"), () => {
        const state = readReach();
        if (change(state)) writeJsonAtomic(paths.reachState(), state);
    });
}

/**
 * One pass's view of the fleet's hosts. The tick's passes (`backoff: true`) skip and back off hosts; any other pass (a
 * hand-run `outbox pull`, a send's own delivery) still skips a host after its first failure in the pass and clears a
 * backoff when it reaches the host, but neither honours nor extends one: only the tick's own failures back a host off.
 */
export class Reach {
    private readonly failed = new Map<string, string>();

    constructor(private readonly options: { backoff: boolean }) {}

    /** Why `host` is not tried now, or null when it is. */
    held(host: string): string | null {
        const failed = this.failed.get(host);
        if (failed !== undefined) return `failed earlier in this pass: ${failed}`;
        if (!this.options.backoff) return null;
        const entry = readReach()[host];
        const at = now().getTime();
        if (entry === undefined || entry.retryAt <= at) return null;
        return `unreachable ${entry.failures} time${entry.failures === 1 ? "" : "s"} in a row; next try in ${Math.ceil((entry.retryAt - at) / 1000)} s (${entry.error})`;
    }

    /** A call to `host` failed: skip it for the rest of the pass; the tick backs it off when ssh did not reach it. */
    failure(host: string, error: string, result: { code: number; timedOut?: boolean }): void {
        const line = error.split("\n")[0] ?? error;
        this.failed.set(host, line);
        if (!this.options.backoff || !unreached(result)) return;
        const at = now().getTime();
        updateReach((state) => {
            const failures = (state[host]?.failures ?? 0) + 1;
            state[host] = { failures, retryAt: at + backoffMs(failures), error: line };
            return true;
        });
    }

    /** A call reached `host`: its backoff ends. */
    success(host: string): void {
        if (readReach()[host] === undefined) return;
        updateReach((state) => {
            if (state[host] === undefined) return false;
            delete state[host];
            return true;
        });
    }
}
