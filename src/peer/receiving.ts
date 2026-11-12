// The receiving marker (state/peer/receiving): touched while a batch from a peer is applied, so the lead's turn and
// the session's wake wait until the whole batch is in and see it as one wake (docs/peers.md "One wake").
import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../core/paths.ts";

/** How long after the last item of a batch a wake waits. */
export const RECEIVING_QUIET_MS = 5_000;

/** Mark that a batch is being applied now. */
export function markReceiving(): void {
    const path = paths.peerReceiving();
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, "");
    const at = new Date();
    utimesSync(path, at, at);
}

/** Whether a batch from a peer was applied within the last RECEIVING_QUIET_MS (the rest may still be arriving). */
export function receivingNow(): boolean {
    const path = paths.peerReceiving();
    return existsSync(path) && Date.now() - statSync(path).mtimeMs < RECEIVING_QUIET_MS;
}
