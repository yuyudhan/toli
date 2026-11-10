// `task pin <id> [--reason "..."]` / `task unpin <id>`: a pinned task stays on this machine (it needs code or state only
// this clone has), so the queue balancer never lists it in an offer (src/fleet/queues.ts, docs/sardars.md).
import { Args } from "../core/args.ts";
import { out } from "../core/util.ts";
import { updateTask } from "./backlog.ts";

/** Run `task pin` or `task unpin`; false when `sub` is neither. */
export function pinTaskCommand(sub: string, argv: string[]): boolean {
    if (sub !== "pin" && sub !== "unpin") return false;
    const pinning = sub === "pin";
    const args = new Args(argv, { values: pinning ? ["reason"] : [] });
    args.maxPositional(1);
    const reason = args.str("reason")?.trim() ?? "";
    const task = updateTask(args.pos(0, "id"), (entry) => {
        if (pinning) entry.pinned = reason;
        else delete entry.pinned;
    });
    const state = task.pinned === undefined ? "unpinned" : `pinned${reason === "" ? "" : `: ${reason}`}`;
    out(`${task.id}\t${task.status}\t${state}`);
    return true;
}
