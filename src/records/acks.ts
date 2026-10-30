import { paths } from "../core/paths.ts";
import { readJson, withLock, writeJsonAtomic } from "../core/util.ts";

/**
 * Per-stream watermarks: file stamps at or below are covered. `jobs`/`inbox` mark what the user acknowledged;
 * `jobsDelivered`/`inboxDelivered` mark what was already pushed into the live session (`toli wake`).
 */
type Acks = { jobs?: string; inbox?: string; jobsDelivered?: string; inboxDelivered?: string };
export type AckStream = keyof Acks;

export function ackedThrough(stream: AckStream): string {
    return readJson<Acks>(paths.acks(), {})[stream] ?? "";
}

export function ackThrough(stream: AckStream, stampValue: string): void {
    withLock(paths.lock("acks"), () => {
        const acks = readJson<Acks>(paths.acks(), {});
        if ((acks[stream] ?? "") < stampValue) acks[stream] = stampValue;
        writeJsonAtomic(paths.acks(), acks);
    });
}
