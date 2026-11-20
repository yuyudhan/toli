// `bin/toli fleet say "<text>" [--key <key>] [--os Linux|Darwin] [--to <machine,...>] [--wait <seconds>]`: type one
// message into every other fleet machine's lead (or only the ones `--to` names), where it runs in tmux (a harness in
// the toli root, src/fleet/machine-script.ts), and submit it with the lead's harness's submit key (SPECS submitKey;
// omp: Ctrl+S, never Enter, T1960, T2086), or `--key`. Each machine has `--wait` seconds in all (default 60): waiting
// for a lead whose harness has drawn its status bar, typing, and confirming that the pane shows the text or changed.
// Each machine's ok/fail line prints as soon as that machine answers. The one fleet command that writes: it types.
import { Args } from "../core/args.ts";
import { inboundOff } from "../core/config.ts";
import { out, printJson, shellQuote, ToliError } from "../core/util.ts";
import { SPECS } from "../harness/harness.ts";
import { LEAD_PANES_SH, runOnFleet, type ScriptOutcome, section, TYPE_INTO_LEAD_SH } from "./machine-script.ts";

const DEFAULT_WAIT_SECONDS = 60;
/** Of a machine's `--wait`: the ssh connection, the last submit press and reading back; the rest waits for a lead. */
export const SAY_SEND_SECONDS = 15;

/** Leading text the pane must show to count as received: a long message wraps or scrolls past its end. */
const PROBE_LENGTH = 24;

/** `key` null: the pane's harness's submit key. `waitSeconds`: each machine's whole time. */
export type SayOptions = { text: string; key: string | null; os: string | null; waitSeconds: number };

/** The script each machine runs: find (or wait for) its ready lead pane, type, submit, read back. */
export function sayScript(options: SayOptions): string {
    return `${LEAD_PANES_SH}${TYPE_INTO_LEAD_SH}
text=${shellQuote(options.text)}
probe=${shellQuote(options.text.slice(0, PROBE_LENGTH))}
key=${shellQuote(options.key ?? "")}
want=${shellQuote(options.os ?? "")}
if [ -n "$want" ] && [ "$(uname -s)" != "$want" ]; then echo "@@skip $(uname -s)"; exit 0; fi
deadline=$(( $(date +%s) + ${Math.max(0, options.waitSeconds - SAY_SEND_SECONDS)} ))
ready_pane() {
  lead_panes | while IFS='|' read -r id name cmd; do
    harness_drawn "$id" "$cmd" && { echo "$id|$name|$cmd"; break; }
  done
}
target=$(ready_pane)
while [ -z "$target" ] && [ "$(date +%s)" -lt "$deadline" ]; do sleep 5; target=$(ready_pane); done
if [ -z "$target" ]; then echo "@@none"; exit 0; fi
id=\${target%%|*}; rest=\${target#*|}; name=\${rest%%|*}; harness=\${rest#*|}
if [ -z "$key" ]; then
  case "$harness" in
${Object.values(SPECS)
    .map((spec) => `    ${shellQuote(spec.binary)}) key=${shellQuote(spec.submitKey)} ;;`)
    .join("\n")}
  esac
fi
before=$(tmux capture-pane -p -t "$id" | cksum)
submit_text "$id" "$key" "$text" "$deadline" || echo "@@pending"
echo "@@sent $name"
sleep 2
tmux capture-pane -p -t "$id" | tr -s ' ' | tr -d '\\n' | grep -F -q "$(printf '%s' "$probe" | tr -s ' ')" && echo "@@seen"
[ "$(tmux capture-pane -p -t "$id" | cksum)" = "$before" ] || echo "@@changed"
echo "@@screen"; tmux capture-pane -p -t "$id" | grep '[[:alnum:]]' | tail -n 3 | tr -s ' '
`;
}

type SayOutcome =
    | "received"
    | "typed, not submitted"
    | "typed, not confirmed"
    | "no lead in tmux"
    | "skipped"
    | "unreachable";

/** What happened on one machine: `ok` once received, `skip` where it does not apply, `fail` otherwise. */
export type SayResult = { machine: string; status: "ok" | "skip" | "fail"; outcome: SayOutcome; detail: string };

function result(machine: string, outcome: SayOutcome, detail: string): SayResult {
    const status = outcome === "received" ? "ok" : outcome === "skipped" ? "skip" : "fail";
    return { machine, status, outcome, detail };
}

/** One machine's result from its script's sections; a machine that takes no inbound ssh is skipped, not failed. */
export function sayResult(outcome: ScriptOutcome): SayResult {
    if (!outcome.ok)
        return result(
            outcome.machine,
            outcome.fleet !== null && inboundOff(outcome.fleet) ? "skipped" : "unreachable",
            outcome.reason,
        );
    const has = (name: string): boolean => outcome.sections.some((entry) => entry.name === name);
    const sent = outcome.sections.find((entry) => entry.name === "sent");
    const skip = outcome.sections.find((entry) => entry.name === "skip");
    if (skip !== undefined) return result(outcome.machine, "skipped", skip.arg);
    if (sent === undefined) return result(outcome.machine, "no lead in tmux", "no ready harness pane in the toli root");
    const screen =
        (section(outcome.sections, "screen") ?? "")
            .split("\n")
            .map((line) => line.replace(/[\uE000-\uF8FF]|[\u{F0000}-\u{FFFFD}]|[╭╮╰╯─│├└]/gu, "").trim())
            .filter((line) => /[A-Za-z0-9]/.test(line))
            .at(-1)
            ?.slice(0, 160) ?? "";
    const evidence = has("pending")
        ? "the text still sits in its input"
        : has("seen")
          ? "pane shows the text"
          : has("changed")
            ? "pane changed"
            : "pane unchanged";
    const delivered = has("pending")
        ? "typed, not submitted"
        : has("seen") || has("changed")
          ? "received"
          : "typed, not confirmed";
    return result(outcome.machine, delivered, `${sent.arg}: ${evidence}; last line: ${screen}`);
}

/** `toli fleet say "<text>" [--key <key>] [--os <uname>] [--to <m1,m2>] [--wait <seconds>] [--json]`. */
export async function sayCommand(argv: string[]): Promise<number> {
    const args = new Args(argv, { booleans: ["json"], values: ["key", "os", "to", "wait"] });
    args.maxPositional(1);
    const text = args.pos(0, "text");
    if (text.trim() === "") throw new ToliError("fleet say needs the text to type");
    const waitText = args.str("wait");
    const waitSeconds = waitText === undefined ? DEFAULT_WAIT_SECONDS : Number(waitText);
    if (!Number.isInteger(waitSeconds) || waitSeconds < 1)
        throw new ToliError("--wait must be whole seconds, 1 or more");
    const json = args.bool("json");
    const options: SayOptions = { text, key: args.str("key") ?? null, os: args.str("os") ?? null, waitSeconds };
    const to = args.str("to");
    const outcomes = await runOnFleet(sayScript(options), {
        withSelf: false,
        capMs: waitSeconds * 1000,
        ...(to === undefined ? {} : { only: to.split(",").map((name) => name.trim()) }),
        ...(json
            ? {}
            : {
                  onOutcome: (outcome: ScriptOutcome) => {
                      const line = sayResult(outcome);
                      out(`${line.machine}: ${line.status} ${line.outcome} (${line.detail})`);
                  },
              }),
    });
    const results = outcomes.map(sayResult);
    if (json) printJson(results);
    return results.some((entry) => entry.status === "fail") ? 1 : 0;
}
