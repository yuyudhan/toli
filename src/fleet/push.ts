// `bin/toli fleet push [--json]`: every project clone on every fleet machine and where its pushing stands: branch,
// commits not pushed, how old origin's tip and the oldest unpushed commit are, uncommitted files, and the line of
// the project's newest jawan report that says its push is blocked. Read with plain git (src/fleet/clones.ts).
import { Args } from "../core/args.ts";
import { now, out, printJson, waited } from "../core/util.ts";
import { type Clone, clonesScript, parseClones } from "./clones.ts";
import { runOnFleet, section } from "./machine-script.ts";
import { renderTable } from "./table.ts";

/** One machine's clones, or why it could not be read. */
export type MachinePush = { machine: string; local: boolean; clones: Clone[] | null; reason?: string };

/** Every fleet machine's clones, this machine first. */
export async function fleetPush(): Promise<MachinePush[]> {
    return (await runOnFleet(clonesScript(true))).map((outcome) =>
        outcome.ok
            ? {
                  machine: outcome.machine,
                  local: outcome.local,
                  clones: parseClones(section(outcome.sections, "clones") ?? ""),
              }
            : { machine: outcome.machine, local: outcome.local, clones: null, reason: outcome.reason },
    );
}

/** One table row per clone, then each blocked clone's report line and each machine that could not be read. */
export function pushText(machines: MachinePush[], at: number = now().getTime()): string {
    const age = (iso: string | null): string => (iso === null ? "-" : waited(at - Date.parse(iso)));
    const rows = machines.flatMap((machine) =>
        (machine.clones ?? []).map((clone) => [
            machine.machine,
            clone.project,
            clone.branch ?? "(detached)",
            clone.ahead === null ? "no upstream" : String(clone.ahead),
            age(clone.upstreamAt),
            clone.ahead === 0 ? "-" : age(clone.oldestUnpushedAt),
            String(clone.dirty),
            clone.blocked === null ? "" : "yes",
        ]),
    );
    const header = ["Machine", "Project", "Branch", "Ahead", "Origin tip", "Oldest unpushed", "Dirty", "Blocked"];
    const blocked = machines.flatMap((machine) =>
        (machine.clones ?? []).flatMap((clone) =>
            clone.blocked === null ? [] : [`${machine.machine} ${clone.project}: ${clone.blocked}`],
        ),
    );
    const unread = machines.flatMap((machine) =>
        machine.clones === null ? [`${machine.machine}: unreachable: ${machine.reason ?? "no answer"}`] : [],
    );
    return [
        ...renderTable(header, rows, 3),
        ...(blocked.length > 0 ? ["", "Blocked (newest report):", ...blocked.map((line) => `  ${line}`)] : []),
        ...(unread.length > 0 ? ["", ...unread] : []),
    ].join("\n");
}

/** `toli fleet push [--json]`. */
export async function pushCommand(argv: string[]): Promise<void> {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const machines = await fleetPush();
    if (args.bool("json")) printJson(machines);
    else out(pushText(machines));
}
