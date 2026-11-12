// A receiver's refusal of one delivered item (docs/peers.md "Delivery"): every transport (ssh, a pull, HTTPS) runs
// the same `bin/toli` command there, and its exit says whether retrying the item could ever work. Kept free of
// imports: the outbox, the pull and the envelope all read it.

/** A receiver's own failures that a later try can fix: a lock wait, or an older toli that lacks the command. */
const RETRYABLE = /^toli: (timed out waiting for lock|unknown option|usage:|unknown command)/;

/**
 * Why the receiving toli refused an item, or null when it was not a refusal. Applying an item there ends in a
 * `toli: <reason>` line and exit 1 when the item itself is wrong (a malformed body, a task that does not exist there,
 * a sender that does not own it), so sending it again can never work: the sender cancels it with that reason instead
 * of retrying it every minute. ssh failures (255), timeouts, crashes (no `toli:` line), lock waits and version gaps
 * stay retryable.
 */
export function refusalOf(result: { code: number; stderr: string; timedOut?: boolean }): string | null {
    if (result.code !== 1 || result.timedOut === true) return null;
    const last = result.stderr.trim().split("\n").at(-1)?.trim() ?? "";
    if (!last.startsWith("toli: ") || RETRYABLE.test(last)) return null;
    return last.slice("toli: ".length);
}
