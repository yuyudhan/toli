// The gate runners toli starts for its own jawans. A gate record names the `bin/toli spawn` runs that started or
// joined it (GateRecord.owners, src/forge/gate.ts); once every one of them has ended and none continues in a resumed or
// replacing run, nothing waits on the gate, so toli stops its runner and everything the runner started: when the run's
// supervisor finishes (src/jawans/supervise.ts) and, for a run whose supervisor died, on the minute tick
// (src/jobs/tick.ts). `bin/toli gate stop` stops one such gate by hand. A gate anyone else started or joined (a
// person, the lead, a hook outside a jawan) has no owners and is never stopped here.
//
// The runner is signalled only while its recorded pid still is that runner: the same pid, started when the record
// says, running `gate runner <its record>` (src/jawans/stop.ts stopRecorded). A pid the system has since handed to
// another process is never signalled.
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { paths } from "../core/paths.ts";
import { now, ToliError } from "../core/util.ts";
import { ACTIVE, type JawanRun, listRuns } from "../jawans/runs.ts";
import { stopRecorded } from "../jawans/stop.ts";
import {
    allRecordFiles,
    type GateRecord,
    logDecision,
    readRecord,
    reconcile,
    short,
    updateRecord,
} from "./gate-record.ts";

/** After SIGTERM, how long a gate's runner gets (it stops its recipe within 10 s and records that) before SIGKILL. */
const RUNNER_GRACE_MS = 20_000;
const RUN_ID = /^[A-Za-z0-9._-]+$/;

/** The `bin/toli spawn` run this process works for (TOLI_RUN_ID naming a run record), or null. */
export function currentRun(): string | null {
    const id = process.env.TOLI_RUN_ID ?? "";
    return RUN_ID.test(id) && existsSync(paths.jawanRecord(id)) ? id : null;
}

/** A caller of run `run` (null: not a jawan run) joins a running gate: a caller outside any run leaves it unowned. */
export function joinGate(record: GateRecord, run: string | null): void {
    if (record.owners === undefined) return;
    if (run === null) delete record.owners;
    else if (!record.owners.includes(run)) record.owners.push(run);
}

/**
 * The first owner of `record` still at work, or the active run that continues one (`resumedBy`, `replacedBy`); null
 * when every owner has ended. A gate without owners has none to end: undefined.
 */
export function liveOwner(record: GateRecord, runs: JawanRun[]): JawanRun | null | undefined {
    if (record.owners === undefined) return undefined;
    const byId = new Map(runs.map((run) => [run.id, run]));
    for (const owner of record.owners) {
        const seen = new Set<string>();
        let id: string | undefined = owner;
        while (id !== undefined && !seen.has(id)) {
            seen.add(id);
            const run = byId.get(id);
            if (run === undefined) break;
            if (ACTIVE.includes(run.status)) return run;
            id = run.resumedBy ?? run.replacedBy;
        }
    }
    return null;
}

/** `<id> (<project> <recipe> at <sha12>)`: a gate's id is its record file's name without `.json`. */
function gateText(file: string, record: GateRecord): string {
    return `${gateId(file)} (${record.project} \`${record.recipe}\` at ${short(record.sha)})`;
}

export function gateId(file: string): string {
    return basename(file, ".json");
}

/**
 * Stop the runner of the running gate in `file` and everything it started, because `why`; returns what happened, in
 * one line. A runner that is no longer the recorded process is never signalled: its record is marked `killed` (its
 * pid may belong to another process now, which would keep the record `running` and attached to forever), and one that
 * cannot be checked is left as it is.
 */
async function stopRunner(file: string, record: GateRecord, why: string): Promise<{ stopped: boolean; text: string }> {
    const pid = record.pid;
    const what = gateText(file, record);
    const spawnedAtMs = Date.parse(record.pidStartedAt ?? record.startedAt);
    if (pid === null || !Number.isFinite(spawnedAtMs)) {
        const text = `gate ${what}: no runner pid recorded yet; signalled nothing`;
        logDecision(record, "stop-skipped", text);
        return { stopped: false, text };
    }
    const survivors = await stopRecorded(
        { pid, spawnedAtMs, command: ["gate runner", basename(file)] },
        RUNNER_GRACE_MS,
    );
    if (survivors === "unknown") {
        const text = `gate ${what}: could not read the process table to check runner pid ${pid}; signalled nothing`;
        logDecision(record, "stop-skipped", text);
        return { stopped: false, text };
    }
    if (survivors === "gone") {
        updateRecord(file, (entry) => {
            if (entry.pid !== pid || entry.status !== "running") return;
            entry.status = "killed";
            entry.endedAt = now().toISOString();
            entry.reason = `its runner (pid ${pid}) is gone; the pid is not that runner any more`;
        });
        const text =
            `gate ${what}: runner pid ${pid} is not the recorded runner any more (gone, or the pid belongs to ` +
            "another process now); signalled nothing and recorded the gate killed";
        logDecision(record, "stop-skipped", text);
        return { stopped: false, text };
    }
    const outlived = survivors.length === 0 ? "" : `; pid ${survivors.join(", ")} outlived SIGKILL`;
    const final = updateRecord(file, (entry) => {
        // The runner records its own end on SIGTERM (`killed`); one that ended by itself meanwhile keeps its outcome.
        if (entry.pid !== pid || (entry.status !== "running" && entry.status !== "killed")) return;
        entry.status = "killed";
        entry.endedAt ??= now().toISOString();
        entry.reason = `stopped by toli: ${why}${outlived}`;
    });
    const text = `gate ${what}: stopped runner pid ${pid} and its processes (${final.status}): ${why}${outlived}`;
    logDecision(final, "stopped", text);
    return { stopped: survivors.length === 0, text };
}

/** Why a gate whose owners all ended is stopped. */
function endedText(record: GateRecord): string {
    const owners = record.owners ?? [];
    return `${owners.length === 1 ? "its jawan" : "every jawan that started or joined it"} (${owners.join(", ")}) ended`;
}

/**
 * Stop every running gate whose owners all ended, or only those `run` owns; returns one line per gate stopped. Runs
 * are read once (a run whose supervisor died reads as ended, src/jawans/runs.ts listRuns).
 */
export async function stopOrphanedGates(run?: string): Promise<string[]> {
    const candidates = allRecordFiles()
        .map((file) => ({ file, record: readRecord(file) }))
        .filter(
            (entry): entry is { file: string; record: GateRecord } =>
                entry.record?.status === "running" &&
                entry.record.owners !== undefined &&
                (run === undefined || entry.record.owners.includes(run)),
        );
    if (candidates.length === 0) return [];
    const runs = listRuns();
    const stops = candidates
        .filter(({ record }) => liveOwner(record, runs) === null)
        .map(async ({ file, record }) => (await stopRunner(file, record, endedText(record))).text);
    return await Promise.all(stops);
}

/** The running gates `selector` names: a record id (`<tree>-<recipe hash>`), or a prefix of its commit or tree. */
function selectGates(selector: string): { file: string; record: GateRecord }[] {
    if (!/^[0-9a-f-]{7,}$/.test(selector))
        throw new ToliError(`"${selector}" is not a gate id or a commit/tree sha (7+ hex digits); see \`gate status\``);
    return allRecordFiles()
        .map((file) => ({ file, record: reconcile(file) }))
        .filter(
            (entry): entry is { file: string; record: GateRecord } =>
                entry.record?.status === "running" &&
                (gateId(entry.file) === selector ||
                    entry.record.sha.startsWith(selector) ||
                    entry.record.tree.startsWith(selector)),
        );
}

/**
 * `bin/toli gate stop <sha|id>`: stop one running gate runner toli recorded for jawans that are all gone. Refuses a
 * gate a live jawan owns (naming it), one no jawan owns, and a selector that names no running gate or several.
 */
export async function gateStop(selector: string): Promise<{ code: number; text: string }> {
    const matches = selectGates(selector);
    const [match, ...more] = matches;
    if (match === undefined) throw new ToliError(`no running gate matches ${selector} (see \`bin/toli gate status\`)`);
    if (more.length > 0)
        throw new ToliError(
            `${selector} names ${matches.length} running gates; give one id: ${matches.map(({ file, record }) => gateText(file, record)).join(", ")}`,
        );
    const { file, record } = match;
    const owner = liveOwner(record, listRuns());
    if (owner === undefined)
        throw new ToliError(
            `refusing: gate ${gateText(file, record)} was started or joined outside any \`bin/toli spawn\` jawan ` +
                "(or before toli recorded its jawans), so it is not a runner toli recorded for a jawan; " +
                "`gate stop` stops only those",
        );
    if (owner !== null)
        throw new ToliError(
            `refusing: gate ${gateText(file, record)} belongs to live jawan ${owner.id} (${owner.status}` +
                `${owner.task === null ? "" : `, task ${owner.task}`}); it is stopped when that jawan ends`,
        );
    const { stopped, text } = await stopRunner(file, record, `\`gate stop\`: ${endedText(record)}`);
    return { code: stopped ? 0 : 1, text };
}
