// `bin/toli lead decline <project>`: this machine's lead says it takes no work of a project at all (docs/sardars.md
// "A machine that declines a project"). The list is `lead.declines` in config/machine.json and travels in
// `resources --json` (`declines`), so `pick --project <p>` and the other leads' balancing offers pass this machine
// over for that project, whatever the work's shape. Each lead sets only its own machine's list.
import { Args } from "../core/args.ts";
import { machineSettings } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import {
    isJsonObject,
    out,
    printJson,
    readJson,
    requireName,
    ToliError,
    withLock,
    writeJsonAtomic,
} from "../core/util.ts";

/** `lead.declines`: the projects this machine takes no work of (none by default). */
export function declinedProjects(): string[] {
    const raw: unknown = machineSettings().lead?.declines;
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || !raw.every((name) => typeof name === "string" && name !== ""))
        throw new ToliError("config/machine.json lead.declines must be a list of project names");
    return raw;
}

/** Change config/machine.json `lead.declines` (the rest of the file is kept as it is); returns the new list. */
function updateDeclines(change: (declines: string[]) => string[]): string[] {
    return withLock(paths.lock("machine"), () => {
        const machine = readJson<Record<string, unknown>>(paths.machine(), {});
        const lead = isJsonObject(machine.lead) ? machine.lead : {};
        const declines = change(declinedProjects()).sort();
        if (declines.length === 0) delete lead.declines;
        else lead.declines = declines;
        machine.lead = lead;
        writeJsonAtomic(paths.machine(), machine);
        return declines;
    });
}

/** `lead decline [--json]` lists; `lead decline <project>` adds it; `lead decline <project> --clear` removes it. */
export function declineCommand(argv: string[]): void {
    const args = new Args(argv, { booleans: ["clear", "json"] });
    args.maxPositional(1);
    const named = args.positional[0];
    if (named === undefined) {
        if (args.bool("clear")) throw new ToliError("lead decline --clear needs the project: lead decline <p> --clear");
        const declines = declinedProjects();
        if (args.bool("json")) printJson(declines);
        else
            out(
                declines.length === 0
                    ? "declines no project: this machine takes work of every project"
                    : `declines ${declines.join(", ")}`,
            );
        return;
    }
    const project = requireName("project", named);
    if (args.bool("clear")) {
        updateDeclines((declines) => declines.filter((name) => name !== project));
        out(`takes work of ${project} again`);
        return;
    }
    updateDeclines((declines) => (declines.includes(project) ? declines : [...declines, project]));
    out(`declines ${project}; pick and the other leads' offers give this machine no work of ${project}`);
}
