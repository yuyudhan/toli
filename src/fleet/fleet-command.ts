// `bin/toli fleet <subcommand>`: dispatch to each fleet report and `fleet status`, which says BLIND first when more
// than half the machines could not be measured.
import { Args } from "../core/args.ts";
import { out, printJson, ToliError } from "../core/util.ts";
import { waitingLines } from "../jobs/outbox-admin.ts";
import { rebootCommand } from "./drain.ts";
import { drainCommand } from "./drain-local.ts";
import { fleetStatus } from "./fleet-probe.ts";
import { fleetListCommand } from "./fleet-sync.ts";
import { healthCommand } from "./health.ts";
import { blindText, checkCommand } from "./oversight.ts";
import { availabilityLine } from "./pick.ts";
import { pushCommand } from "./push.ts";
import { questionsCommand } from "./questions.ts";
import { queuesCommand } from "./queues.ts";
import { releasesCommand } from "./releases.ts";
import { sayCommand } from "./say.ts";
import { startCommand } from "./start.ts";
import { workCommand } from "./work.ts";

const FLEET_USAGE = [
    "usage: toli fleet status [--json] | queues [--json] | health [--json] | work [--json] | push [--json]",
    "  | questions [--json] | releases <project>@<machine>... [--health <project>=<url>]... [--main <branch>] [--json]",
    '  | say "<text>" [--key <key>] [--os <uname>] [--to <machine,...>] [--wait <seconds>] [--json]',
    '  | start [--session <s>] [--window <w>] [--harness <h>] [--key <key>] [--message "<text>"] [--attach "<command>"]',
    "    [--os <uname>] [--json]",
    "  | check [--json] [--wake] [--local] | export | sync",
    "  | reboot [--drain [--wait <minutes>] [--back <minutes>]] [--self] [--json]",
    "  | drain pause [--minutes <n>] [--json] | status [--json] | resume [--json]",
].join("\n");

/** The `fleet` subcommands that print their report and exit 0. */
const FLEET_REPORTS: Record<string, (argv: string[]) => Promise<void>> = {
    check: checkCommand,
    queues: queuesCommand,
    health: healthCommand,
    work: workCommand,
    push: pushCommand,
    questions: questionsCommand,
    releases: releasesCommand,
    status: statusCommand,
};

async function statusCommand(argv: string[]): Promise<void> {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const entries = await fleetStatus();
    if (args.bool("json")) printJson(entries);
    else {
        // More than half the fleet unmeasured: say so before any machine's line, so no reader takes the rest for all.
        const unmeasured = entries.filter((entry) => !entry.reachable || entry.resources === null);
        const blind = blindText(entries.length, unmeasured, "not measured");
        if (blind !== null) out(blind);
        for (const entry of entries) out(availabilityLine(entry));
        for (const line of waitingLines()) out(`waiting to send: ${line}`);
    }
}

/** `toli fleet <subcommand>` (FLEET_USAGE); resolves to the exit code. */
export async function fleetCommand(argv: string[]): Promise<number> {
    const [sub = "", ...rest] = argv;
    if (sub === "say") return await sayCommand(rest);
    if (sub === "start") return await startCommand(rest);
    if (sub === "reboot") {
        await rebootCommand(rest);
        return 0;
    }
    if (sub === "drain") {
        drainCommand(rest);
        return 0;
    }
    if (sub === "export" || sub === "sync") {
        fleetListCommand(sub, rest);
        return 0;
    }
    const report = Object.hasOwn(FLEET_REPORTS, sub) ? FLEET_REPORTS[sub] : undefined;
    if (report === undefined) throw new ToliError(FLEET_USAGE);
    await report(rest);
    return 0;
}
