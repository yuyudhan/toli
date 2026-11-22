// `bin/toli digest --fleet`'s other machines: each one's own `digest --json` over ssh, asked only of the machines the
// fleet probe reached (src/fleet/fleet-probe.ts), a few at once with a short connect timeout, in fleet order. An
// unreachable or backed-off machine is not asked: its section gives the probe's reason and when it was last seen.
import {
    type FleetMachine,
    inboundOff,
    inboundOffText,
    otherFleetMachines,
    remoteToliCommand,
    sshArgsAsync,
} from "../core/config.ts";
import { runAsync } from "../core/util.ts";
import type { FleetEntry as AvailabilityEntry } from "../fleet/resources.ts";
import type { Digest, FleetEntry } from "./digest.ts";

/** At most this many fleet machines are asked for their digest at once. */
const DIGEST_PARALLEL = 8;
/** ssh's ConnectTimeout for a fleet digest, as for the fleet probes. */
const DIGEST_CONNECT_SECONDS = 5;

async function fleetDigest(machine: FleetMachine, entry: AvailabilityEntry | undefined): Promise<FleetEntry> {
    if (inboundOff(machine)) return { machine: machine.name, ok: false, error: inboundOffText(machine) };
    // The probe found it unreachable or held it back: no ssh, its stale snapshot says when it was seen.
    if (entry !== undefined && !entry.reachable) {
        const stale = entry.lastSeen === undefined ? "" : `; stale, last seen ${entry.lastSeen.at}`;
        const reasons = entry.reasons.map((reason) => reason.replace(/^unreachable: /, "")).join("; ");
        return { machine: machine.name, ok: false, error: `${reasons}${stale}` };
    }
    const result = await runAsync(
        [
            ...(await sshArgsAsync(machine.ssh, DIGEST_CONNECT_SECONDS)),
            remoteToliCommand(machine.root, "digest --json"),
        ],
        { timeoutMs: 90_000 },
    );
    if (result.code !== 0) {
        return {
            machine: machine.name,
            ok: false,
            error: `ssh ${machine.ssh} exited ${result.code}: ${(result.stderr || result.stdout).trim()}`,
        };
    }
    try {
        return { machine: machine.name, ok: true, digest: JSON.parse(result.stdout) as Digest };
    } catch {
        return { machine: machine.name, ok: false, error: `unparseable digest from ${machine.ssh}` };
    }
}

/** Every other machine's digest, in fleet order, asked DIGEST_PARALLEL at a time; unreachable ones are not asked. */
export async function fleetDigests(availability: AvailabilityEntry[]): Promise<FleetEntry[]> {
    const machines = otherFleetMachines();
    const results: FleetEntry[] = new Array(machines.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        for (let index = next++; index < machines.length; index = next++) {
            const machine = machines[index] as FleetMachine;
            const entry = availability.find((candidate) => candidate.machine === machine.name);
            results[index] = await fleetDigest(machine, entry);
        }
    };
    await Promise.all(Array.from({ length: Math.min(DIGEST_PARALLEL, machines.length) }, worker));
    return results;
}
