// The processes waiting on a gate: each `gate run` or `push --gate` that started or attached to it is recorded in
// its record (GateRecord.callers) by pid and start time. The detached runner (src/forge/gate-runner.ts) watches them:
// a caller that comes back within CALLER_GRACE_MINUTES (a retried push, a dropped ssh session) attaches to the same
// run, but once every caller has been gone that long nothing waits on the gate any more, so the runner stops its
// recipe (its whole process group and tree) and leaves the heavy-build slot, or its place in line for one. A pid the
// system has since handed to another process is not taken for the caller, and a caller is never signalled.
import { runMinuteMs } from "../jawans/runs.ts";
import { type RecordedState, recordedState } from "../jawans/stop.ts";
import { type GateCaller, type GateRecord, inProgress, readRecord } from "./gate-record.ts";

/** How long a gate's runner goes on after its last caller is gone, for one to come back. */
export const CALLER_GRACE_MINUTES = 1;
/** The longest a runner waits between two looks at its callers. */
const CALLER_POLL_MAX_MS = 5_000;

/** This process as a gate's caller: its pid and when it started, by the real clock (not now(), which tests may fix). */
export function thisCaller(): GateCaller {
    return { pid: process.pid, startedAt: new Date(performance.timeOrigin).toISOString() };
}

/** Record this process as one more caller waiting on `record`. */
export function addCaller(record: GateRecord): void {
    const me = thisCaller();
    const callers = record.callers ?? [];
    if (!callers.some((caller) => caller.pid === me.pid && caller.startedAt === me.startedAt)) callers.push(me);
    record.callers = callers;
}

/** Whether `caller` still runs, provably does not (gone, or its pid is another process's now), or cannot be told. */
function callerState(caller: GateCaller): RecordedState {
    const spawnedAtMs = Date.parse(caller.startedAt);
    if (!Number.isInteger(caller.pid) || caller.pid <= 0 || !Number.isFinite(spawnedAtMs)) return "gone";
    return recordedState({ pid: caller.pid, spawnedAtMs, command: [] });
}

/**
 * The first caller of `record` that may still wait on it (alive, or not checkable); null when every one is gone;
 * undefined for a record without callers (written before toli recorded them), which nothing here ever stops.
 */
export function liveCaller(record: GateRecord): GateCaller | null | undefined {
    if (record.callers === undefined) return undefined;
    return record.callers.find((caller) => callerState(caller) !== "gone") ?? null;
}

/** `pid 12, 34`: the callers a gate recorded. */
export function callersText(record: GateRecord): string {
    return `pid ${(record.callers ?? []).map((caller) => caller.pid).join(", ")}`;
}

/** Why a gate whose callers are all gone is stopped. */
export function callersGoneText(record: GateRecord): string {
    const many = (record.callers ?? []).length > 1;
    return `nothing waits on it any more: ${many ? "every process that started or joined it" : "the process that started it"} (${callersText(record)}) is gone`;
}

/**
 * From the gate's runner, watch the callers of the gate in `file`: once none has been there for CALLER_GRACE_MINUTES,
 * call `gone` once with the reason. Returns the function that ends the watch.
 */
export function watchCallers(file: string, gone: (reason: string) => void): () => void {
    const graceMs = CALLER_GRACE_MINUTES * runMinuteMs();
    const pollMs = Math.max(50, Math.min(CALLER_POLL_MAX_MS, graceMs / 6));
    let goneSince: number | null = null;
    const timer = setInterval(() => {
        const record = readRecord(file);
        if (record === null || !inProgress(record.status)) return;
        if (liveCaller(record) !== null) {
            goneSince = null;
            return;
        }
        goneSince ??= Date.now();
        if (Date.now() - goneSince < graceMs) return;
        clearInterval(timer);
        gone(
            `${callersGoneText(record)} and none came back within ${CALLER_GRACE_MINUTES} minute; stopped it so it ` +
                "frees its heavy-build slot",
        );
    }, pollMs);
    return () => clearInterval(timer);
}
