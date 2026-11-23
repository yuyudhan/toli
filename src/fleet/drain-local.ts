// `bin/toli fleet drain pause|status|resume`: each machine's own step of `bin/toli fleet reboot --drain`
// (src/fleet/drain.ts, docs/fleet.md "Rebooting the fleet"). `pause` holds new jobs here (src/fleet/dispatch-pause.ts),
// `resume` lifts that, and every step prints what a reboot here would cut: the running gates, push checks and jawans.
import { Args } from "../core/args.ts";
import { loadMachine } from "../core/config.ts";
import { isJsonObject, out, printJson, ToliError } from "../core/util.ts";
import { runningGates, short } from "../forge/gate-record.ts";
import { activeRuns, RUNNING } from "../jawans/runs.ts";
import { bootedAt, currentDispatchPause, pauseDispatch, resumeDispatch } from "./dispatch-pause.ts";
import { runsInProgress } from "./no-mistakes-runs.ts";

/** What a pause by `fleet reboot --drain` says on each machine. */
const DRAIN_REASON = "fleet reboot --drain";
const DEFAULT_PAUSE_MINUTES = 60;

/** One machine's drain state, as `fleet drain <step> --json` prints it. */
export type LocalDrain = {
    machine: string;
    /** When this machine booted (ISO): a new value after a reboot. */
    bootedAt: string;
    /** Whether new dispatch is paused here now. */
    paused: boolean;
    /** Running gates: `<project> <sha12>: <recipe> (pid <n>)`. */
    gates: string[];
    /** Running push checks: `no-mistakes run <id> (<status>)`. */
    pushChecks: string[];
    /** Running jawans: `<run id> (<task>)`. */
    jawans: string[];
    /** What could not be read here, and why. */
    unread: string[];
};

/** This machine's drain state now. */
export function localDrain(): LocalDrain {
    const pushChecks = runsInProgress();
    return {
        machine: loadMachine().name,
        bootedAt: bootedAt().toISOString(),
        paused: currentDispatchPause() !== null,
        gates: runningGates().map((gate) => `${gate.project} ${short(gate.sha)}: ${gate.recipe} (pid ${gate.pid})`),
        pushChecks: typeof pushChecks === "string" ? [] : pushChecks,
        jawans: activeRuns()
            .filter((run) => RUNNING.includes(run.status))
            .map((run) => (run.task === null ? run.id : `${run.id} (${run.task})`)),
        unread: typeof pushChecks === "string" ? [`no-mistakes runs: ${pushChecks}`] : [],
    };
}

/** Parse another machine's `fleet drain <step> --json`, rejecting anything not shaped like one. */
export function parseLocalDrain(text: string): LocalDrain {
    const value: unknown = JSON.parse(text);
    if (!isJsonObject(value)) throw new Error("not a drain report");
    const str = (key: string): string => {
        const field = value[key];
        if (typeof field !== "string") throw new Error(`field ${key} is not a string`);
        return field;
    };
    const list = (key: string): string[] => {
        const field = value[key];
        if (!Array.isArray(field) || !field.every((entry) => typeof entry === "string"))
            throw new Error(`field ${key} is not a list of strings`);
        return field;
    };
    if (typeof value.paused !== "boolean") throw new Error("field paused is not a boolean");
    return {
        machine: str("machine"),
        bootedAt: str("bootedAt"),
        paused: value.paused,
        gates: list("gates"),
        pushChecks: list("pushChecks"),
        jawans: list("jawans"),
        unread: list("unread"),
    };
}

function drainText(drain: LocalDrain): string {
    const listed = (label: string, items: string[]): string =>
        `${label}: ${items.length === 0 ? "none" : items.join("; ")}`;
    return [
        `${drain.machine}: dispatch ${drain.paused ? "paused" : "not paused"} (booted ${drain.bootedAt})`,
        listed("gates running", drain.gates),
        listed("push checks running", drain.pushChecks),
        listed("jawans running", drain.jawans),
        ...drain.unread.map((line) => `not read: ${line}`),
    ].join("\n");
}

/** A whole number of minutes, at least 1, from `flag`; undefined when it is absent. */
export function minutesValue(value: string | undefined, flag: string): number | undefined {
    if (value === undefined) return undefined;
    const minutes = Number(value);
    if (!Number.isInteger(minutes) || minutes < 1) throw new ToliError(`${flag} must be a whole number of minutes`);
    return minutes;
}

const DRAIN_USAGE = "usage: toli fleet drain pause [--minutes <n>] [--json] | status [--json] | resume [--json]";

/**
 * `toli fleet drain pause|status|resume`: this machine's step of a fleet reboot. `pause` holds new jobs here until this
 * machine reboots, `--minutes` pass (default 60) or `resume`; each prints this machine's drain state.
 */
export function drainCommand(argv: string[]): void {
    const [step = "", ...rest] = argv;
    if (step !== "pause" && step !== "status" && step !== "resume") throw new ToliError(DRAIN_USAGE);
    const args = new Args(rest, { booleans: ["json"], values: step === "pause" ? ["minutes"] : [] });
    args.maxPositional(0);
    if (step === "pause")
        pauseDispatch(DRAIN_REASON, minutesValue(args.str("minutes"), "--minutes") ?? DEFAULT_PAUSE_MINUTES);
    if (step === "resume") resumeDispatch();
    const drain = localDrain();
    if (args.bool("json")) printJson(drain);
    else out(drainText(drain));
}
