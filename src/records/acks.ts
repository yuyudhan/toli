import { Args } from "../core/args.ts";
import { paths } from "../core/paths.ts";
import { out, readJson, ToliError, withLock, writeJsonAtomic } from "../core/util.ts";

/**
 * Per-stream watermarks: file stamps at or below are covered. `jobs`/`inbox` mark what the user acknowledged;
 * `jobsDelivered`/`inboxDelivered` mark what was already pushed into the live session (`toli wake`);
 * `jobsShown`/`inboxShown` mark the newest item toli has shown a reader (a wake, `inbox list`, `job results`), the
 * most a plain `ack` may cover, so a result that arrives after the reader looked is never acknowledged unseen.
 */
type Acks = {
    jobs?: string;
    inbox?: string;
    jobsDelivered?: string;
    inboxDelivered?: string;
    jobsShown?: string;
    inboxShown?: string;
};
export type AckStream = keyof Acks;

/** The streams a reader acknowledges. */
export type ResultStream = "inbox" | "jobs";

const SHOWN: Record<ResultStream, AckStream> = { inbox: "inboxShown", jobs: "jobsShown" };

/** A file stamp as `stamp()` writes it: 2026-10-29T13-27-00-189Z. */
const STAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

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

/** Record that the items of `stream` up to `stamps`' newest were shown to a reader. */
export function markShown(stream: ResultStream, stamps: string[]): void {
    const newest = stamps.toSorted().at(-1) ?? "";
    if (newest !== "") ackThrough(SHOWN[stream], newest);
}

/** The exact command that acknowledges `stream` through `stampValue`, as wakes and the digest print it. */
export function ackCommand(stream: ResultStream, stampValue: string): string {
    return `bin/toli ${stream === "inbox" ? "inbox" : "job"} ack --through ${stampValue}`;
}

/**
 * `inbox ack` / `job ack [--through <stamp>]`: acknowledge `stream`'s items (`stamps`, every item on disk) through the
 * given stamp, by default through the newest item shown to a reader. Newer items stay unread and wake the lead again.
 */
export function acknowledge(stream: ResultStream, argv: string[], stamps: string[], noun: string): void {
    const args = new Args(argv, { values: ["through"] });
    args.maxPositional(0);
    const given = args.str("through");
    if (given !== undefined && !STAMP_PATTERN.test(given))
        throw new ToliError(`--through takes an item stamp like 2026-10-29T13-27-00-189Z, not "${given}"`);
    const through = given ?? ackedThrough(SHOWN[stream]);
    const before = ackedThrough(stream);
    const covered = stamps.filter((value) => value > before && value <= through).length;
    const left = stamps.filter((value) => value > before && value > through).length;
    if (through !== "") ackThrough(stream, through);
    const plural = (count: number): string => `${noun}${count === 1 ? "" : "s"}`;
    out(
        `acknowledged ${covered} ${plural(covered)}${left === 0 ? "" : `; ${left} newer ${plural(left)} not shown yet, still unread`}`,
    );
}
