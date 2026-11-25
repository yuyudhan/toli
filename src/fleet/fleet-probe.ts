// The fleet probes: every other machine's `resources --json` (HTTPS when paired, else ssh), asked in parallel with
// short caps, and what the probes remember between passes (docs/fleet.md "Unreachable machines"). A machine none of
// their routes reached is backed off in state/reach.json under `fleet:<name>`, on the tick's schedule
// (src/jobs/reach.ts: 30 s, doubling, at most 10 minutes), and so is a machine reached only by ssh while the tick's own
// ssh to it is backed off. A backed-off machine is not probed: its row says why at once, with the last snapshot seen
// from it (state/fleet-seen.json) marked stale, so a dead host costs no pass its timeouts again. A local outage backs
// no machine off: a probe that failed because this machine has no network ("Network is unreachable"), or a pass in
// which every probed machine (two or more) went unreached at once, says nothing about those machines, so the first
// pass after the network returns probes them all again.
import {
    type FleetMachine,
    inboundOff,
    inboundOffText,
    loadFleet,
    remoteToliCommand,
    sshArgs,
} from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, readJson, runAsync, withLock, writeJsonAtomic } from "../core/util.ts";
import { backedOff, LOCAL_OUTAGE, Reach, unreached } from "../jobs/reach.ts";
import { httpPeer } from "../peer/transport.ts";
import type { Full } from "./full.ts";
import { type Netbird, netbirdOnce, type ProbeFailure, unreachableReason } from "./netbird-reach.ts";
import type { Queue } from "./queue.ts";
import { type FleetEntry, localResources, type Resources } from "./resources.ts";

/** state/fleet-seen.json: per machine, the last `resources` snapshot a probe got from it. */
type Seen = Record<string, Resources>;

/** The last snapshot seen from each machine. */
function readSeen(): Seen {
    return readJson<Seen>(paths.fleetSeen(), {});
}

/** Keep each reached machine's snapshot for the passes that cannot reach it. */
function recordSeen(entries: FleetEntry[]): void {
    const reached = entries.filter((entry) => !entry.local && entry.resources !== null);
    if (reached.length === 0) return;
    withLock(paths.lock("fleet-seen"), () => {
        const seen = readSeen();
        for (const entry of reached) if (entry.resources !== null) seen[entry.machine] = entry.resources;
        writeJsonAtomic(paths.fleetSeen(), seen);
    });
}

function retryText(retryAt: number): string {
    return `next probe in ${Math.max(1, Math.ceil((retryAt - now().getTime()) / 1000))} s`;
}

/**
 * Why `machine` is not probed this pass, or null when it is: its own fleet backoff, or (reached only by ssh, no
 * paired peer) the tick's backoff of its ssh host. The text leads with the failure that backed it off.
 */
function heldReason(machine: FleetMachine): string | null {
    const own = backedOff(`fleet:${machine.name}`);
    if (own !== null)
        return `${own.error} (not probed: unreachable ${own.failures} time${own.failures === 1 ? "" : "s"} in a row, ${retryText(own.retryAt)})`;
    if (httpPeer(machine.name) !== undefined || inboundOff(machine)) return null;
    const tick = backedOff(machine.ssh);
    if (tick === null) return null;
    return `${tick.error} (not probed: the tick's ssh to ${machine.ssh} failed ${tick.failures} time${tick.failures === 1 ? "" : "s"} in a row, ${retryText(tick.retryAt)})`;
}

/** The row of a machine not probed this pass: unreachable for `reason`, with its last snapshot when one was seen. */
function heldEntry(machine: FleetMachine, reason: string, seen: Seen): FleetEntry {
    return withLastSeen(
        {
            machine: machine.name,
            local: false,
            reachable: false,
            available: false,
            reasons: [`unreachable: ${reason}`],
            resources: null,
        },
        seen,
    );
}

/** An unreachable row with the last snapshot seen from that machine, if any; a reached row as it is. */
function withLastSeen(entry: FleetEntry, seen: Seen): FleetEntry {
    const last = entry.resources === null ? seen[entry.machine] : undefined;
    return last === undefined ? entry : { ...entry, lastSeen: last };
}

/**
 * After a probe: a machine no route reached is backed off unless the outage is local (`localOutage`); one that
 * answered has its backoff cleared, and so has the tick's ssh to it when the probe reached it over ssh.
 */
function noteProbe(reach: Reach, machine: FleetMachine, result: Probe, localOutage: boolean): void {
    const key = `fleet:${machine.name}`;
    if (result.unreached && !localOutage)
        reach.unreachable(key, result.entry.reasons.join("; ").replace(/^unreachable: /, ""));
    else if (result.entry.reachable) {
        reach.success(key);
        if (result.overSsh) reach.success(machine.ssh);
    }
}

/** ssh's ConnectTimeout for a fleet probe: a mesh VPN host that is off the network fails the banner exchange in it. */
const PROBE_CONNECT_SECONDS = 5;
const PROBE_CAP_MS = 20_000;
/**
 * The HTTPS try of an unbudgeted probe: a mesh VPN accepts the TCP connection to a host that is off the network, so
 * without a cap the request waits the client's full answer time before ssh is even tried.
 */
const PROBE_HTTPS_MS = 10_000;

function firstLine(text: string): string {
    return (
        text
            .split("\n")
            .find((line) => line.trim() !== "")
            ?.trim() ?? "no output"
    );
}

/** Parse another machine's `resources --json`, rejecting anything not shaped like a snapshot. */
export function parseResources(text: string): Resources {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not a JSON object");
    const fields = new Map(Object.entries(value));
    const num = (key: string): number => {
        const field = fields.get(key);
        if (typeof field !== "number" || !Number.isFinite(field)) throw new Error(`field ${key} is not a number`);
        return field;
    };
    const str = (key: string): string => {
        const field = fields.get(key);
        if (typeof field !== "string") throw new Error(`field ${key} is not a string`);
        return field;
    };
    const strings = (key: string): string[] => {
        const field: unknown = fields.get(key);
        if (!Array.isArray(field)) throw new Error(`field ${key} is not a string list`);
        return field.map((item: unknown) => {
            if (typeof item !== "string") throw new Error(`field ${key} is not a string list`);
            return item;
        });
    };
    const available = fields.get("available");
    if (typeof available !== "boolean") throw new Error("field available is not a boolean");
    const rawQueue: unknown = fields.get("queue");
    let queue: Queue | null = null;
    if (rawQueue !== undefined) {
        if (typeof rawQueue !== "object" || rawQueue === null || Array.isArray(rawQueue))
            throw new Error("field queue is not an object");
        const parts = new Map(Object.entries(rawQueue));
        const count = (key: keyof Queue): number => {
            const part = parts.get(key);
            if (typeof part !== "number" || !Number.isInteger(part) || part < 0)
                throw new Error(`field queue.${key} is not a count`);
            return part;
        };
        const rawFull: unknown = parts.get("full");
        let full: Full | undefined;
        if (rawFull !== undefined) {
            if (typeof rawFull !== "object" || rawFull === null) throw new Error("field queue.full is not an object");
            const f = new Map(Object.entries(rawFull));
            const reason = f.get("reason");
            const since = f.get("since");
            const until = f.get("until");
            if (
                typeof reason !== "string" ||
                typeof since !== "string" ||
                (until !== null && typeof until !== "string")
            )
                throw new Error("field queue.full needs reason, since and until");
            full = { reason, since, until };
        }
        const rawDeclines: unknown = parts.get("declines");
        let declines: string[] | undefined;
        if (rawDeclines !== undefined) {
            if (!Array.isArray(rawDeclines)) throw new Error("field queue.declines is not a string list");
            declines = rawDeclines.map((name: unknown) => {
                if (typeof name !== "string") throw new Error("field queue.declines is not a string list");
                return name;
            });
        }
        queue = {
            queued: count("queued"),
            // A peer on an older toli publishes no slotWaits: its depth stands as it reported it.
            ...(parts.get("slotWaits") === undefined ? {} : { slotWaits: count("slotWaits") }),
            active: count("active"),
            held: count("held"),
            jawansRunning: count("jawansRunning"),
            jawansQueued: count("jawansQueued"),
            depth: count("depth"),
            ...(full === undefined ? {} : { full }),
            ...(declines === undefined ? {} : { declines }),
        };
    }
    const verifyOnly = fields.get("verifyOnly") === undefined ? undefined : strings("verifyOnly");
    return {
        machine: str("machine"),
        platform: str("platform"),
        cpus: num("cpus"),
        load1: num("load1"),
        load5: num("load5"),
        memTotalMB: num("memTotalMB"),
        memAvailableMB: num("memAvailableMB"),
        diskFreeGB: num("diskFreeGB"),
        activeRuns: num("activeRuns"),
        maxRuns: num("maxRuns"),
        maxLoadPerCpu: num("maxLoadPerCpu"),
        projects: strings("projects"),
        available,
        reasons: strings("reasons"),
        at: str("at"),
        queue,
        ...(verifyOnly === undefined ? {} : { verifyOnly }),
    };
}

/**
 * Probe one other fleet machine for its `resources --json` (HTTPS when paired, else ssh); never throws. `budgetMs`
 * bounds the whole probe, HTTPS and the ssh fallback together, for a caller someone waits for (`delegate`'s
 * verify-only check): an HTTPS try that used it all leaves no ssh try. `netbird` is this machine's NetBird view, read
 * only when an unbudgeted probe fails, to say why (src/fleet/netbird-reach.ts); a budgeted one spends no time on it.
 */
export async function probeMachine(
    machine: FleetMachine,
    budgetMs?: number,
    netbird: () => Promise<Netbird | null> = netbirdOnce(),
): Promise<FleetEntry> {
    return (await probe(machine, budgetMs, netbird)).entry;
}

/**
 * One probe: its entry; whether no route reached the machine at all (what backs it off); whether that failure says
 * this machine has no network (`localOutage`, which backs nothing off); and whether ssh is the route that answered.
 */
type Probe = { entry: FleetEntry; unreached: boolean; localOutage: boolean; overSsh: boolean };

async function probe(
    machine: FleetMachine,
    budgetMs: number | undefined,
    netbird: () => Promise<Netbird | null>,
): Promise<Probe> {
    const deadline = budgetMs === undefined ? undefined : performance.now() + budgetMs;
    const unreachable = (detail: string, noRoute = false, raw = detail): Probe => ({
        entry: {
            machine: machine.name,
            local: false,
            reachable: false,
            available: false,
            reasons: [`unreachable: ${detail}`],
            resources: null,
        },
        unreached: noRoute,
        localOutage: noRoute && LOCAL_OUTAGE.test(raw),
        overSsh: false,
    });
    const reached = (resources: Resources, overSsh: boolean): Probe => ({
        entry: {
            machine: machine.name,
            local: false,
            reachable: true,
            available: resources.available,
            reasons: resources.reasons,
            resources,
        },
        unreached: false,
        localOutage: false,
        overSsh,
    });
    // A paired peer answers over HTTPS (its `status` permission for this machine); ssh is the fallback.
    const peer = httpPeer(machine.name);
    // A budgeted probe has no time for netbird and `ssh -G`; its timeout still reads as no route / host down.
    const view = deadline === undefined ? netbird : () => Promise.resolve(null);
    // The reason may be rewritten from this machine's NetBird view; whether the outage is local is read from the raw one.
    const failed = async (failure: ProbeFailure, noRoute: boolean) =>
        unreachable(
            await unreachableReason(failure, { ssh: machine.ssh, peerAddrs: peer?.addrs ?? [] }, view, now()),
            noRoute,
            `${failure.https}${failure.ssh}`,
        );
    let httpsError = "";
    if (peer !== undefined) {
        try {
            // Loaded here, not at the top: deliver.ts registers with the listener when it loads, and the listener's
            // own imports reach this module (envelope -> backlog -> ... -> resources -> pick -> fleet-probe).
            const { askStatus } = await import("../peer/deliver.ts");
            // Loading it counts against the budget: on a loaded machine it takes a noticeable part of a second.
            const left = deadline === undefined ? PROBE_HTTPS_MS : Math.max(1, deadline - performance.now());
            return reached(parseResources(JSON.stringify((await askStatus(peer, left)).value)), false);
        } catch (error) {
            httpsError = `HTTPS: ${firstLine(error instanceof Error ? error.message : String(error))}; `;
        }
    }
    // Never probed over ssh, and never picked: work for it goes by `delegate`, which it pulls.
    if (inboundOff(machine)) {
        const off = unreachable("", peer !== undefined, httpsError);
        return { ...off, entry: { ...off.entry, reasons: [`${httpsError}${inboundOffText(machine)}`] } };
    }
    const capMs = deadline === undefined ? PROBE_CAP_MS : Math.ceil(deadline - performance.now());
    if (capMs <= 0) return unreachable(`${httpsError}no time left to try ssh ${machine.ssh}`);
    const capSeconds = Math.ceil(capMs / 1000);
    const connectSeconds = Math.min(PROBE_CONNECT_SECONDS, capSeconds);
    const result = await runAsync(
        [...sshArgs(machine.ssh, connectSeconds), remoteToliCommand(machine.root, "resources --json")],
        { timeoutMs: capMs },
    );
    if (result.timedOut)
        return await failed(
            { https: httpsError, ssh: `no answer from ${machine.ssh} within ${capSeconds}s`, timedOut: true },
            true,
        );
    if (result.code !== 0)
        return await failed(
            {
                https: httpsError,
                ssh: `ssh ${machine.ssh} exited ${result.code}: ${firstLine(result.stderr || result.stdout)}`,
                timedOut: false,
            },
            unreached(result),
        );
    try {
        return reached(parseResources(result.stdout), true);
    } catch (error) {
        return unreachable(
            `bad resources output from ${machine.ssh}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/**
 * This machine plus every other `config/fleet.json` machine, probed in parallel. Never throws for a bad machine. A
 * machine backed off after no route reached it is not probed again until its backoff ends (header above), unless the
 * outage was local; every unreachable row carries the last snapshot seen from that machine, marked stale.
 */
export async function fleetStatus(): Promise<FleetEntry[]> {
    const local = localResources();
    const others = loadFleet().machines.filter((machine) => machine.name !== local.machine);
    const netbird = netbirdOnce();
    const reach = new Reach({ backoff: true });
    const seen = readSeen();
    const passes = await Promise.all(
        others.map(async (machine) => {
            const held = heldReason(machine);
            if (held !== null) return { machine, held: heldEntry(machine, held, seen) };
            return { machine, probed: await probe(machine, undefined, netbird) };
        }),
    );
    const probed = passes.flatMap((pass) => (pass.probed === undefined ? [] : [pass.probed]));
    // Every probed machine unreached at once: this machine's network is down, not theirs.
    const passOutage = probed.length >= 2 && probed.every((result) => result.unreached);
    const remote = passes.map((pass) => {
        if (pass.probed === undefined) return pass.held;
        noteProbe(reach, pass.machine, pass.probed, passOutage || pass.probed.localOutage);
        return withLastSeen(pass.probed.entry, seen);
    });
    recordSeen(remote);
    return [
        {
            machine: local.machine,
            local: true,
            reachable: true,
            available: local.available,
            reasons: local.reasons,
            resources: local,
        },
        ...remote,
    ];
}
