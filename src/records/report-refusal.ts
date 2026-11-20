// A delegated task reports to its delegator and every machine above it (src/records/delegation-report.ts). A machine
// whose `--for` task records no delegation to that task refuses each report (src/peer/envelope.ts): the work reached
// this machine some way it does not follow, such as a slice forwarded on (T2045). Sending it every later report only
// gets another refusal and another "not sent" inbox item, so the first refusal stops the task's reports to that
// machine (`delegatedBy.refusedBy`) and is the one alert; a repeat already queued before it is cancelled quietly.
import { loadMachine } from "../core/config.ts";
import { isJsonObject } from "../core/util.ts";
import type { OutboxItem } from "../jobs/outbox.ts";
import { updateBacklog } from "./backlog.ts";
import { fleetId } from "./delegation-report.ts";

/** Why a machine refuses an update for its task `forTask` from `id` (`<owner>/T<n>`): no such delegation there. */
export function unrecordedReason(forTask: string, id: string): string {
    return `no delegation of ${forTask} to ${id} is recorded here`;
}

/**
 * For a cancelled item (`reason` as src/jobs/outbox-admin.ts records it): null unless it is this machine's report
 * of a delegated task that its target refused as unrecorded. Then that task reports there no more, and the line the
 * alert lists it with, or "repeat" when an earlier refusal already stopped them (no second alert).
 */
export function stopUnrecordedReports(item: OutboxItem, reason: string): string | "repeat" | null {
    const peer = item.to?.name;
    if (item.kind !== "update" || peer === undefined) return null;
    let body: unknown;
    try {
        body = JSON.parse(item.body);
    } catch {
        return null;
    }
    if (!isJsonObject(body) || typeof body.id !== "string" || typeof body.forTask !== "string") return null;
    const owner = loadMachine().name;
    if (body.owner !== owner) return null;
    const id = body.id;
    const fid = fleetId(owner, id);
    const why = unrecordedReason(body.forTask, fid);
    if (!reason.includes(why)) return null;
    return updateBacklog((backlog) => {
        const task = backlog.tasks.find((entry) => entry.id === id);
        const by = task?.delegatedBy;
        if (task === undefined || by === undefined) return null;
        if (by.refusedBy?.includes(peer) === true) return "repeat";
        by.refusedBy = [...(by.refusedBy ?? []), peer];
        const line = `${fid} no longer reports to ${peer}: it records ${why.replace(/ is recorded here$/, "")}`;
        task.notes.push(line);
        return line;
    });
}
