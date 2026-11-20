// The time limit of `bin/toli disk keep` (src/fleet/disk-command.ts), by hand or in the background: a call the keeper
// makes that never returns (a macOS privacy prompt nobody answers, a hung disk or tool) blocks its only thread, so no
// timer of its own can fire. A worker thread keeps the time instead: past the limit it logs the stop to logs/disk.log
// and stderr and kills the process, whose keeper lock then reads as free (T1907).
import { workerEnv } from "../core/git-env.ts";

/** How long one `disk keep` may run: an I/O-starved disk can make a real run take an hour. */
const KEEP_LIMIT_MS = 2 * 60 * 60_000;

/** The keeper's time limit; `TOLI_DISK_KEEP_LIMIT_MS` replaces it (tests). */
export function keepLimitMs(): number {
    const override = Number(process.env.TOLI_DISK_KEEP_LIMIT_MS);
    return Number.isInteger(override) && override > 0 ? override : KEEP_LIMIT_MS;
}

/** A time limit as the keeper's line names it: `90 s`, `120 min`. */
export function limitText(ms: number): string {
    return ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
}

/** What the watchdog worker is told: the limit, and the pid to stop past it. */
export type Watch = { limitMs: number; pid: number };

/** Start the watchdog over this process; returns its stop, for when the keeper finished in time. */
export function watchKeeper(limitMs: number = keepLimitMs()): () => void {
    const worker = new Worker(new URL("./disk-watchdog-worker.ts", import.meta.url).href, { env: workerEnv() });
    worker.unref();
    const watch: Watch = { limitMs, pid: process.pid };
    worker.postMessage(watch);
    return () => worker.terminate();
}
