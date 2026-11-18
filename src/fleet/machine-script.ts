// Fleet reads that must work whatever toli release each machine runs (`fleet health`, `fleet work`): one POSIX sh
// script, run in this machine's toli root and over ssh in every other fleet machine's, printing `@@<name> [arg]`
// headed sections that this machine parses. Every machine is read in parallel under one cap per machine.
import { resolve } from "node:path";
import {
    type FleetMachine,
    inboundOff,
    loadMachine,
    otherFleetMachines,
    remoteShellCommand,
    sshArgs,
} from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { runAsync } from "../core/util.ts";
import { httpPeer } from "../peer/transport.ts";
import { parseResources } from "./pick.ts";
import type { Resources } from "./resources.ts";

const CONNECT_SECONDS = 8;
/** One machine's whole read: the commands stay under 30 s together. */
export const MACHINE_CAP_MS = 25_000;

/** This CLI (not paths.toliBin(): TOLI_ROOT may point the data elsewhere, as in tests). */
const TOLI_SCRIPT = resolve(import.meta.dir, "..", "..", "bin", "toli");

/** One `@@<name> [arg]` section of a script's output. */
export type Section = { name: string; arg: string; body: string };

/** What one machine's script printed, or why it could not run there. */
export type ScriptOutcome =
    | { machine: string; local: boolean; ok: true; sections: Section[] }
    | { machine: string; local: boolean; ok: false; reason: string; fleet: FleetMachine | null };

/** Split script output into its `@@` sections; text before the first header is dropped. */
export function parseSections(text: string): Section[] {
    const sections: Section[] = [];
    let current: { name: string; arg: string; lines: string[] } | null = null;
    const close = (): void => {
        if (current !== null) sections.push({ name: current.name, arg: current.arg, body: current.lines.join("\n") });
    };
    for (const line of text.split("\n")) {
        const header = /^@@(\S+)(?: (.*))?$/.exec(line);
        if (header === null) {
            current?.lines.push(line);
            continue;
        }
        close();
        current = { name: header[1] ?? "", arg: header[2] ?? "", lines: [] };
    }
    close();
    return sections;
}

/** The body of the first section called `name`, or null. */
export function section(sections: Section[], name: string): string | null {
    return sections.find((entry) => entry.name === name)?.body ?? null;
}

function firstLine(text: string): string {
    return (
        text
            .split("\n")
            .find((line) => line.trim() !== "")
            ?.trim() ?? "no output"
    );
}

/** Run `script` in this machine's toli root, with `$TOLI` naming this CLI. */
async function runLocal(machine: string, script: string): Promise<ScriptOutcome> {
    const result = await runAsync(["sh", "-s"], {
        cwd: paths.root(),
        stdin: script,
        env: { TOLI: TOLI_SCRIPT },
        timeoutMs: MACHINE_CAP_MS,
    });
    if (result.timedOut) return { machine, local: true, ok: false, reason: "timed out", fleet: null };
    return { machine, local: true, ok: true, sections: parseSections(result.stdout) };
}

/** Run `script` over ssh in `machine`'s toli root, with `$TOLI` naming its CLI; never throws. */
async function runRemote(machine: FleetMachine, script: string): Promise<ScriptOutcome> {
    const failed = (reason: string): ScriptOutcome => ({
        machine: machine.name,
        local: false,
        ok: false,
        reason,
        fleet: machine,
    });
    if (inboundOff(machine)) return failed("takes no inbound ssh");
    let args: string[];
    try {
        args = sshArgs(machine.ssh, CONNECT_SECONDS);
    } catch (error) {
        return failed(error instanceof Error ? error.message : String(error));
    }
    const result = await runAsync([...args, remoteShellCommand(machine.root, "TOLI=bin/toli sh -s")], {
        stdin: script,
        timeoutMs: MACHINE_CAP_MS,
    });
    if (result.timedOut) return failed(`no answer from ${machine.ssh} within ${MACHINE_CAP_MS / 1000}s`);
    // The script itself never fails; a non-zero exit with no section is ssh's own (unreachable, refused, no root).
    const sections = parseSections(result.stdout);
    if (sections.length === 0)
        return failed(`ssh ${machine.ssh} exited ${result.code}: ${firstLine(result.stderr || result.stdout)}`);
    return { machine: machine.name, local: false, ok: true, sections };
}

/** Run `script` on this machine and every other fleet machine at once, this machine first. */
export async function runOnFleet(script: string): Promise<ScriptOutcome[]> {
    const self = loadMachine().name;
    return await Promise.all([
        runLocal(self, script),
        ...otherFleetMachines().map((machine) => runRemote(machine, script)),
    ]);
}

/**
 * The machine's `resources --json` over HTTPS when it is a paired peer that allows this one `status`: the fallback
 * for a machine ssh cannot read. Null when it is no peer; the error text when the ask failed.
 */
export async function statusOverHttps(machine: string): Promise<Resources | string | null> {
    const peer = httpPeer(machine);
    if (peer === undefined) return null;
    try {
        // Loaded here, not at the top (as in pick.ts): deliver.ts registers with the listener when it loads, and the
        // listener's own imports reach this module, so a static import would be a cycle.
        const { askStatus } = await import("../peer/deliver.ts");
        return parseResources(JSON.stringify((await askStatus(peer)).value));
    } catch (error) {
        return `HTTPS: ${firstLine(error instanceof Error ? error.message : String(error))}`;
    }
}
