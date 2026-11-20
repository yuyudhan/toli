// Fleet commands that must work whatever toli release each machine runs (`fleet health|work|push|questions|say|
// start`): one POSIX sh script, run in this machine's toli root and over ssh in every other fleet machine's, printing
// `@@<name> [arg]` headed sections that this machine parses. Every machine runs it at once, under one cap per machine.
import { resolve } from "node:path";
import {
    type FleetMachine,
    inboundOff,
    loadMachine,
    otherFleetMachines,
    remoteShellCommand,
    sshArgsAsync,
} from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { runAsync, shellQuote, ToliError } from "../core/util.ts";
import { SPECS } from "../harness/harness.ts";
import { httpPeer } from "../peer/transport.ts";
import { parseResources } from "./pick.ts";
import type { Resources } from "./resources.ts";

const CONNECT_SECONDS = 8;
/** One machine's whole read: the commands stay under 30 s together. */
export const MACHINE_CAP_MS = 20_000;

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

/**
 * How long each machine may take (default 20 s), whether this machine runs the script too (default yes), when given
 * the only other machines it runs on, and a callback for each machine's outcome as soon as that machine answers.
 */
export type FleetRunOptions = {
    capMs?: number;
    withSelf?: boolean;
    only?: readonly string[];
    onOutcome?: (outcome: ScriptOutcome) => void;
};

/** Run `script` in this machine's toli root, with `$TOLI` naming this CLI. */
async function runLocal(machine: string, script: string, capMs: number): Promise<ScriptOutcome> {
    const result = await runAsync(["sh", "-s"], {
        cwd: paths.root(),
        stdin: script,
        env: { TOLI: TOLI_SCRIPT },
        timeoutMs: capMs,
    });
    if (result.timedOut) return { machine, local: true, ok: false, reason: "timed out", fleet: null };
    return { machine, local: true, ok: true, sections: parseSections(result.stdout) };
}

/** Run `script` over ssh in `machine`'s toli root, with `$TOLI` naming its CLI; never throws. */
async function runRemote(machine: FleetMachine, script: string, capMs: number): Promise<ScriptOutcome> {
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
        // The async form, so the connection checks for every host run at once instead of one after another.
        args = await sshArgsAsync(machine.ssh, CONNECT_SECONDS);
    } catch (error) {
        return failed(error instanceof Error ? error.message : String(error));
    }
    const result = await runAsync([...args, remoteShellCommand(machine.root, "TOLI=bin/toli sh -s")], {
        stdin: script,
        timeoutMs: capMs,
    });
    if (result.timedOut) return failed(`no answer from ${machine.ssh} within ${capMs / 1000}s`);
    // The script itself never fails; a non-zero exit with no section is ssh's own (unreachable, refused, no root).
    const sections = parseSections(result.stdout);
    if (sections.length === 0)
        return failed(`ssh ${machine.ssh} exited ${result.code}: ${firstLine(result.stderr || result.stdout)}`);
    return { machine: machine.name, local: false, ok: true, sections };
}

/** Run `script` on this machine and every other fleet machine at once, this machine first. */
export async function runOnFleet(script: string, options: FleetRunOptions = {}): Promise<ScriptOutcome[]> {
    const capMs = options.capMs ?? MACHINE_CAP_MS;
    const only = options.only;
    if (only !== undefined) {
        const unknown = only.filter((name) => !otherFleetMachines().some((machine) => machine.name === name));
        if (unknown.length > 0) throw new ToliError(`not another machine in config/fleet.json: ${unknown.join(", ")}`);
    }
    const onOutcome = options.onOutcome;
    const report = (run: Promise<ScriptOutcome>): Promise<ScriptOutcome> =>
        onOutcome === undefined
            ? run
            : run.then((outcome) => {
                  onOutcome(outcome);
                  return outcome;
              });
    const others = otherFleetMachines()
        .filter((machine) => only === undefined || only.includes(machine.name))
        .map((machine) => report(runRemote(machine, script, capMs)));
    if (options.withSelf === false) return await Promise.all(others);
    return await Promise.all([report(runLocal(loadMachine().name, script, capMs)), ...others]);
}

/** Run `script` on one fleet machine (this one in its own root), under `capMs`. */
export async function runOnMachine(
    name: string,
    script: string,
    capMs: number = MACHINE_CAP_MS,
): Promise<ScriptOutcome> {
    if (name === loadMachine().name) return await runLocal(name, script, capMs);
    const machine = otherFleetMachines().find((entry) => entry.name === name);
    if (machine === undefined) throw new ToliError(`machine "${name}" is not in config/fleet.json`);
    return await runRemote(machine, script, capMs);
}

/**
 * Shell function `lead_panes`: one `<pane id>|<session>:<window>|<harness>` line per tmux pane that runs a harness in
 * the toli root, the way a lead runs in tmux: the pane's command is the harness's CLI, or a runtime (`bun`, `node`)
 * whose process, a child of the pane's shell, runs that CLI's script.
 */
export const LEAD_PANES_SH = `
lead_panes() {
  here=$(pwd -P)
  bins=${shellQuote(
      Object.values(SPECS)
          .map((spec) => spec.binary)
          .join(" "),
  )}
  tmux list-panes -a -F '#{pane_id}|#{session_name}:#{window_name}|#{pane_current_command}|#{pane_current_path}|#{pane_pid}' 2>/dev/null |
  while IFS='|' read -r id name cmd path shell; do
    [ "$path" = "$here" ] || [ "$path" = "$PWD" ] || continue
    harness=
    case " $bins " in *" $cmd "*) harness=$cmd ;; esac
    if [ -z "$harness" ] && { [ "$cmd" = bun ] || [ "$cmd" = node ]; }; then
      args=$(ps -A -o ppid=,args= | awk -v p="$shell" '$1 == p { $1 = ""; print }')
      for b in $bins; do
        case "$args" in *"/$b "*|*"/$b") harness=$b; break ;; esac
      done
    fi
    [ -n "$harness" ] && echo "$id|$name|$harness"
  done
}
`;

/**
 * Shell functions for typing into a harness in tmux (`fleet say`, `fleet start`), after LEAD_PANES_SH:
 *
 * `harness_drawn <pane> <binary>`: whether the harness has drawn its status bar (a `────────` line) below the
 * shell's echo of the command line that started it. A powerline prompt draws such a line too, and keys typed while
 * only the prompt shows go to the shell's line buffer and land unsent in the harness's editor (T2086). With no such
 * echo on screen (scrolled off, or started as `omp -c`), only the harness's own bottom counts: its `drawnInput` line
 * last, right under a bar line that is no two-line prompt's `╭─` top; never a bar line anywhere in the pane.
 *
 * `submit_text <pane> <key> <text> <deadline>`: type the text, then press the submit key until the text has left the
 * input at the bottom of the pane, every 3 s until `<deadline>` (epoch seconds); fails when it is still there. omp
 * draws its bar before it takes a message, so on a slow start the first press leaves the text in its editor (T2086).
 */
export const TYPE_INTO_LEAD_SH = `
harness_drawn() {
  case "$2" in
${Object.values(SPECS)
    .map((spec) => `    ${shellQuote(spec.binary)}) input=${shellQuote(spec.drawnInput ?? "")} ;;`)
    .join("\n")}
    *) input= ;;
  esac
  tmux capture-pane -p -t "$1" 2>/dev/null | awk -v cmd="$2" -v input="$input" '
    NF { line[++n] = $0; if ($NF == cmd || $NF ~ ("/" cmd "$")) last = n }
    END {
      if (last) { for (i = last + 1; i <= n; i++) if (line[i] ~ /────────/) exit 0; exit 1 }
      if (input != "" && n >= 2 && line[n] ~ input && line[n - 1] ~ /────────/ && line[n - 1] !~ /^[[:space:]]*╭/) exit 0
      exit 1
    }'
}
submit_text() {
  tmux send-keys -t "$1" -l "$3"
  sleep 1
  end=$(printf '%s' "$3" | tr -d ' \\n' | tail -c 8)
  while :; do
    tmux send-keys -t "$1" "$2"
    sleep 3
    tmux capture-pane -p -t "$1" | grep -v '^[[:space:]]*$' | tail -n 1 | tr -d ' ' | grep -F -q -- "$end" || return 0
    [ "$(date +%s)" -lt "$4" ] || return 1
  done
}
`;

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
