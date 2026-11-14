// A slice (a delegation made with `delegate --for` while the task keeps its own jawan) is work held on another
// machine, which reports back here: the task waits on it (`waitingOn`) instead of being judged by its own, possibly
// finished, agent (T1427). Once the slice is through, oversight judges that agent again.
import type { Task } from "./backlog.ts";

/** What a task waits on while delegation `fid` works on it (`task.waitingOn`). */
export function delegateWait(fid: string): string {
    return `${fid} (delegated)`;
}

/** Whether slice `fid` is still out: not done, dropped or handed back. */
export function sliceOpen(task: Task, fid: string): boolean {
    const state = task.delegates?.[fid];
    return (
        state === undefined || (state.status !== "done" && state.status !== "dropped" && state.handedBack === undefined)
    );
}

/**
 * Once a slice is through, a task that waited on it waits on the newest slice still out, else on nothing: oversight
 * judges its own agent again, so a dead one is named.
 */
export function rewait(task: Task): void {
    const slices = task.slices ?? [];
    if (!slices.some((fid) => task.waitingOn === delegateWait(fid))) return;
    const open = slices.filter((fid) => sliceOpen(task, fid)).at(-1);
    if (open === undefined) delete task.waitingOn;
    else task.waitingOn = delegateWait(open);
}
