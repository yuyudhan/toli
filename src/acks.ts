import { paths } from "./paths.ts";
import { readJson, withLock, writeJsonAtomic } from "./util.ts";

/** Per-stream "seen up to" watermarks: file stamps at or below are acknowledged. */
type Acks = { jobs?: string; inbox?: string };
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
