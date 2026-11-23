// `bin/toli fleet reboot [--drain [--wait <minutes>] [--back <minutes>]] [--self] [--json]` (docs/fleet.md "Rebooting
// the fleet"); each machine's own step, `fleet drain pause|status|resume`, is src/fleet/drain-local.ts. A reboot of
// every machine at once kills whatever runs there; `--drain` first pauses new dispatch on every machine of the wave
// (dispatch-pause.ts), waits (bounded by `--wait`, default `reboot.drainWaitMinutes` or 30) for the running gates
// (src/forge/gate-record.ts) and push checks (no-mistakes runs, src/fleet/no-mistakes-runs.ts) to finish, then reboots
// the wave at once and resumes dispatch on each machine as it comes back on a new boot (within `--back`, default 10
// minutes; one later resumes by itself, since a pause ends with the boot it was set in). It prints what it waited on
// and what it cut: whatever still ran when the wave went down. Other machines are rebooted by default; `--self` adds
// this one, rebooted last, after the others resumed. Each machine runs `reboot.command` (default `sudo -n shutdown -r
// now`) detached, a few seconds after it answers. Who may reboot is unchanged: the user's word.
import { Args } from "../core/args.ts";
import { loadMachine, type Machine, otherFleetMachines } from "../core/config.ts";
import { out, printJson, shellQuote, ToliError, waited } from "../core/util.ts";
import { sameBoot } from "./dispatch-pause.ts";
import { type LocalDrain, minutesValue, parseLocalDrain } from "./drain-local.ts";
import { runOnFleet, type ScriptOutcome, section } from "./machine-script.ts";

const DEFAULT_DRAIN_WAIT_MINUTES = 30;
const DEFAULT_BACK_MINUTES = 10;
/** A pause outlives the wait and the wait for the machines to come back by this much, then lapses. */
const PAUSE_MARGIN_MINUTES = 30;
const POLL_MS = 30_000;
/** How long after answering a machine starts its reboot, so the answer (and this machine's report) gets out first. */
const REBOOT_DELAY_SECONDS = 10;
const DEFAULT_REBOOT_COMMAND = "sudo -n shutdown -r now";

/** One machine's drain state, or why it could not be read. */
export type MachineDrain = { machine: string; drain: LocalDrain | null; error: string | null };

/** What `fleet reboot` does on the machines, and its clock: the real fleet, or a test's fake. */
export type DrainRunner = {
    pause(machines: readonly string[], minutes: number): Promise<MachineDrain[]>;
    status(machines: readonly string[]): Promise<MachineDrain[]>;
    /** Start each machine's reboot; `error` says why one did not start. */
    reboot(machines: readonly string[]): Promise<{ machine: string; error: string | null }[]>;
    resume(machines: readonly string[]): Promise<MachineDrain[]>;
    sleep(ms: number): Promise<void>;
    clock(): number;
};

export type RebootPlan = {
    /** The other machines to reboot. */
    machines: string[];
    /** This machine's name when it reboots too (last), else null. */
    self: string | null;
    drain: boolean;
    waitMs: number;
    pollMs: number;
    backMs: number;
    progress(line: string): void;
};

export type RebootReport = {
    paused: string[];
    notPaused: { machine: string; reason: string }[];
    /** Every gate and push check the drain found running, each once. */
    waitedOn: { machine: string; what: string }[];
    waitedMs: number;
    /** Whether every gate and push check finished before the wave went down. */
    drained: boolean;
    /** What still ran (or could not be read) when the wave went down. */
    cut: { machine: string; what: string }[];
    rebooted: string[];
    notRebooted: { machine: string; reason: string }[];
    resumed: string[];
    /** Rebooted machines that did not answer on a new boot within the bound: each resumes by itself at boot. */
    notBack: string[];
};

/** The gates and push checks running on each machine read. */
function busy(states: Iterable<MachineDrain>): { machine: string; what: string }[] {
    return [...states].flatMap((state) =>
        state.drain === null
            ? []
            : [
                  ...state.drain.gates.map((gate) => ({ machine: state.machine, what: `gate ${gate}` })),
                  ...state.drain.pushChecks.map((check) => ({ machine: state.machine, what: `push check ${check}` })),
              ],
    );
}

/** Everything running on each machine read (or why it was not read): what a reboot now cuts. */
function running(states: Iterable<MachineDrain>): { machine: string; what: string }[] {
    return [...states].flatMap((state) => {
        if (state.drain === null) return [{ machine: state.machine, what: `not read: ${state.error ?? "no answer"}` }];
        return [
            ...busy([state]),
            ...state.drain.jawans.map((jawan) => ({ machine: state.machine, what: `jawan ${jawan}` })),
            ...state.drain.unread.map((line) => ({ machine: state.machine, what: `not read: ${line}` })),
        ];
    });
}

const names = (machines: readonly string[]): string => machines.join(", ");
const itemsText = (items: readonly { machine: string; what: string }[]): string =>
    items.map((item) => `${item.machine} ${item.what}`).join("; ");

/**
 * Reboot `plan.machines` (and `plan.self` last) in one wave. With `drain`: pause dispatch on the wave, wait for its
 * gates and push checks up to `waitMs`, reboot, then resume each machine as it answers on a new boot within `backMs`
 * (at once for one whose reboot did not start, and at the bound for one still on its old boot). Without it: read
 * what runs, then reboot.
 */
export async function rebootFleet(runner: DrainRunner, plan: RebootPlan): Promise<RebootReport> {
    const wave = plan.self === null ? plan.machines : [plan.self, ...plan.machines];
    const report: RebootReport = {
        paused: [],
        notPaused: [],
        waitedOn: [],
        waitedMs: 0,
        drained: true,
        cut: [],
        rebooted: [],
        notRebooted: [],
        resumed: [],
        notBack: [],
    };
    const latest = new Map<string, MachineDrain>();
    const pausedBoot = new Map<string, string>();
    if (plan.drain) {
        const minutes = Math.ceil((plan.waitMs + plan.backMs) / 60_000) + PAUSE_MARGIN_MINUTES;
        for (const state of await runner.pause(wave, minutes)) {
            if (state.drain === null || !state.drain.paused) {
                const reason = state.error ?? "the pause did not take";
                report.notPaused.push({ machine: state.machine, reason });
                report.cut.push({ machine: state.machine, what: `not drained: ${reason}` });
                continue;
            }
            report.paused.push(state.machine);
            pausedBoot.set(state.machine, state.drain.bootedAt);
            latest.set(state.machine, state);
        }
        if (report.paused.length > 0) plan.progress(`dispatch paused on ${names(report.paused)}`);
        const seen = new Set<string>();
        const note = (): void => {
            for (const item of busy(latest.values())) {
                const key = `${item.machine}\n${item.what}`;
                if (seen.has(key)) continue;
                seen.add(key);
                report.waitedOn.push(item);
            }
        };
        note();
        const started = runner.clock();
        for (;;) {
            const waiting = busy(latest.values());
            const left = started + plan.waitMs - runner.clock();
            if (waiting.length === 0 || left <= 0) break;
            plan.progress(`waiting on ${itemsText(waiting)}`);
            await runner.sleep(Math.min(plan.pollMs, left));
            for (const state of await runner.status(report.paused))
                if (state.drain !== null) latest.set(state.machine, state);
            note();
        }
        report.waitedMs = runner.clock() - started;
        report.drained = busy(latest.values()).length === 0;
    } else for (const state of await runner.status(wave)) latest.set(state.machine, state);
    report.cut.unshift(...running(latest.values()));

    const reboot = async (machines: string[]): Promise<void> => {
        if (machines.length === 0) return;
        plan.progress(`rebooting ${names(machines)}`);
        for (const outcome of await runner.reboot(machines)) {
            if (outcome.error === null) report.rebooted.push(outcome.machine);
            else report.notRebooted.push({ machine: outcome.machine, reason: outcome.error });
        }
    };
    await reboot(plan.machines);
    if (plan.drain) await resumeWave(runner, plan, report, pausedBoot);
    if (plan.self !== null) await reboot([plan.self]);
    return report;
}

/** The drain's last step: resume dispatch on each paused machine of the wave as it comes back (rebootFleet). */
async function resumeWave(
    runner: DrainRunner,
    plan: RebootPlan,
    report: RebootReport,
    pausedBoot: ReadonlyMap<string, string>,
): Promise<void> {
    const resume = async (machines: string[]): Promise<string[]> => {
        if (machines.length === 0) return [];
        const done = (await runner.resume(machines))
            .filter((state) => state.error === null)
            .map((state) => state.machine);
        report.resumed.push(...done);
        return done;
    };
    const failed = new Set(report.notRebooted.map((entry) => entry.machine));
    await resume(plan.machines.filter((machine) => failed.has(machine) && pausedBoot.has(machine)));
    let pending = report.rebooted.filter((machine) => pausedBoot.has(machine));
    if (pending.length > 0) plan.progress(`waiting for ${names(pending)} to come back`);
    const sameBootSeen = new Set<string>();
    const deadline = runner.clock() + plan.backMs;
    while (pending.length > 0 && runner.clock() < deadline) {
        await runner.sleep(Math.min(plan.pollMs, deadline - runner.clock()));
        const back: string[] = [];
        for (const state of await runner.status(pending)) {
            const before = pausedBoot.get(state.machine);
            if (state.drain === null || before === undefined) continue;
            if (sameBoot(state.drain.bootedAt, before)) sameBootSeen.add(state.machine);
            else {
                sameBootSeen.delete(state.machine);
                back.push(state.machine);
            }
        }
        const done = new Set(await resume(back));
        pending = pending.filter((machine) => !done.has(machine));
    }
    // Still answering on its old boot at the bound: its reboot never happened, so it resumes now.
    const stayed = pending.filter((machine) => sameBootSeen.has(machine));
    for (const machine of stayed) {
        report.rebooted.splice(report.rebooted.indexOf(machine), 1);
        report.notRebooted.push({ machine, reason: `still on its old boot after ${waited(plan.backMs)}` });
    }
    const resumed = new Set(await resume(stayed));
    report.notBack = pending.filter((machine) => !resumed.has(machine) && !sameBootSeen.has(machine));
}

/** The report `fleet reboot` prints. */
export function rebootText(report: RebootReport, plan: Pick<RebootPlan, "drain" | "waitMs" | "backMs">): string {
    const reasons = (items: readonly { machine: string; reason: string }[]): string =>
        items.map((item) => `${item.machine} (${item.reason})`).join(", ");
    const lines: string[] = [];
    if (plan.drain) {
        lines.push(
            `dispatch paused: ${report.paused.length === 0 ? "nowhere" : names(report.paused)}${report.notPaused.length === 0 ? "" : `; not paused: ${reasons(report.notPaused)}`}`,
        );
        const outcome = report.drained
            ? "all finished"
            : `stopped waiting at the ${waited(plan.waitMs)} bound (--wait)`;
        lines.push(
            report.waitedOn.length === 0
                ? "waited on: nothing (no gate or push check running)"
                : `waited ${waited(report.waitedMs)} on: ${itemsText(report.waitedOn)}; ${outcome}`,
        );
    }
    lines.push(`cut: ${report.cut.length === 0 ? "nothing" : itemsText(report.cut)}`);
    lines.push(
        `rebooting: ${report.rebooted.length === 0 ? "none" : names(report.rebooted)}${report.notRebooted.length === 0 ? "" : `; not rebooted: ${reasons(report.notRebooted)}`}`,
    );
    if (plan.drain) {
        const notBack =
            report.notBack.length === 0
                ? ""
                : `; not back within ${waited(plan.backMs)}: ${names(report.notBack)} (each resumes by itself at boot: its pause ends with the boot it was set in)`;
        lines.push(`dispatch resumed: ${report.resumed.length === 0 ? "none" : names(report.resumed)}${notBack}`);
    }
    lines.push("Leads in tmux do not restart by themselves: `bin/toli fleet start` brings them back.");
    return lines.join("\n");
}

/** `reboot.command`, or the default. */
function rebootShell(machine: Machine): string {
    const command = machine.reboot?.command;
    if (command === undefined) return DEFAULT_REBOOT_COMMAND;
    if (typeof command !== "string" || command.trim() === "")
        throw new ToliError("config/machine.json reboot.command must be a non-empty shell command");
    return command;
}

/** `reboot.drainWaitMinutes`, or the default. */
function drainWaitMinutes(machine: Machine): number {
    const raw = machine.reboot?.drainWaitMinutes;
    if (raw === undefined) return DEFAULT_DRAIN_WAIT_MINUTES;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)
        throw new ToliError("config/machine.json reboot.drainWaitMinutes must be a positive number");
    return raw;
}

/** One machine's `fleet drain` answer from its script's `@@drain` section, or why there is none. */
function machineDrain(outcome: ScriptOutcome): MachineDrain {
    if (!outcome.ok) return { machine: outcome.machine, drain: null, error: outcome.reason };
    const body = section(outcome.sections, "drain") ?? "";
    try {
        return { machine: outcome.machine, drain: parseLocalDrain(body), error: null };
    } catch {
        const error = /usage: toli fleet/.test(body)
            ? "its toli has no `fleet drain` (an older release)"
            : (body
                  .split("\n")
                  .find((line) => line.trim() !== "")
                  ?.trim() ?? "no answer");
        return { machine: outcome.machine, drain: null, error };
    }
}

/** The real fleet: each step a script run on the named machines over ssh (this one in its own root). */
function fleetRunner(command: string): DrainRunner {
    const self = loadMachine().name;
    const onMachines = async (machines: readonly string[], script: string): Promise<ScriptOutcome[]> =>
        machines.length === 0
            ? []
            : await runOnFleet(script, {
                  only: machines.filter((machine) => machine !== self),
                  withSelf: machines.includes(self),
              });
    const step = async (machines: readonly string[], args: string): Promise<MachineDrain[]> =>
        (await onMachines(machines, `echo @@drain\n"$TOLI" fleet drain ${args} --json 2>&1\n`)).map(machineDrain);
    const later = `sleep ${REBOOT_DELAY_SECONDS}; ${command}`;
    const rebootScript = `echo @@reboot\nnohup sh -c ${shellQuote(later)} </dev/null >/dev/null 2>&1 &\necho started\n`;
    return {
        pause: (machines, minutes) => step(machines, `pause --minutes ${minutes}`),
        status: (machines) => step(machines, "status"),
        resume: (machines) => step(machines, "resume"),
        reboot: async (machines) =>
            (await onMachines(machines, rebootScript)).map((outcome) => {
                if (!outcome.ok) return { machine: outcome.machine, error: outcome.reason };
                const said = section(outcome.sections, "reboot")?.trim() ?? "";
                return { machine: outcome.machine, error: said === "started" ? null : said || "no answer" };
            }),
        sleep: (ms) => Bun.sleep(ms),
        clock: () => Date.now(),
    };
}

/** `toli fleet reboot [--drain [--wait <minutes>] [--back <minutes>]] [--self] [--json]`. */
export async function rebootCommand(argv: string[]): Promise<void> {
    const args = new Args(argv, { booleans: ["drain", "self", "json"], values: ["wait", "back"] });
    args.maxPositional(0);
    const drain = args.bool("drain");
    if (!drain && (args.has("wait") || args.has("back")))
        throw new ToliError("--wait and --back apply to --drain only");
    const machine = loadMachine();
    const machines = otherFleetMachines().map((entry) => entry.name);
    const self = args.bool("self") ? machine.name : null;
    if (machines.length === 0 && self === null)
        throw new ToliError("no other machine in config/fleet.json to reboot (--self reboots this one)");
    const plan: RebootPlan = {
        machines,
        self,
        drain,
        waitMs: (minutesValue(args.str("wait"), "--wait") ?? drainWaitMinutes(machine)) * 60_000,
        pollMs: POLL_MS,
        backMs: (minutesValue(args.str("back"), "--back") ?? DEFAULT_BACK_MINUTES) * 60_000,
        progress: args.bool("json") ? () => undefined : (line) => out(line),
    };
    const report = await rebootFleet(fleetRunner(rebootShell(machine)), plan);
    if (args.bool("json")) printJson(report);
    else out(rebootText(report, plan));
}
