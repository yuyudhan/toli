// `bin/toli fleet say "<text>" [--key <key>] [--os Linux|Darwin] [--to <machine,...>] [--wait <seconds>]`: type one
// message into every other fleet machine's lead (or only the ones `--to` names), where it runs in tmux (a harness in
// the toli root, src/fleet/machine-script.ts), and
// submit it with `--key` (a tmux key name, default Enter; a harness bound to submit on another key takes that one).
// It waits up to `--wait` seconds (default 300) for a lead whose harness has drawn its status bar, then confirms per
// machine that the pane shows the text or changed. The one fleet command that writes: it types, nothing else.
import { Args } from "../core/args.ts";
import { out, printJson, shellQuote, ToliError } from "../core/util.ts";
import { LEAD_PANES_SH, runOnFleet, type ScriptOutcome, section } from "./machine-script.ts";

const DEFAULT_WAIT_SECONDS = 300;
/** Typing, submitting and reading back after the wait. */
const SEND_SECONDS = 40;

/** Leading text the pane must show to count as received: a long message wraps or scrolls past its end. */
const PROBE_LENGTH = 24;

export type SayOptions = { text: string; key: string; os: string | null; waitSeconds: number };

/** The script each machine runs: find (or wait for) its ready lead pane, type, submit, read back. */
export function sayScript(options: SayOptions): string {
    return `${LEAD_PANES_SH}
text=${shellQuote(options.text)}
probe=${shellQuote(options.text.slice(0, PROBE_LENGTH))}
key=${shellQuote(options.key)}
want=${shellQuote(options.os ?? "")}
if [ -n "$want" ] && [ "$(uname -s)" != "$want" ]; then echo "@@skip $(uname -s)"; exit 0; fi
ready_pane() {
  lead_panes | while IFS='|' read -r id name cmd; do
    tmux capture-pane -p -t "$id" 2>/dev/null | grep -q '────────' && { echo "$id|$name"; break; }
  done
}
target=$(ready_pane); waited=0
while [ -z "$target" ] && [ "$waited" -lt ${options.waitSeconds} ]; do sleep 5; waited=$((waited + 5)); target=$(ready_pane); done
if [ -z "$target" ]; then echo "@@none"; exit 0; fi
id=\${target%%|*}; name=\${target#*|}
before=$(tmux capture-pane -p -t "$id" | cksum)
tmux send-keys -t "$id" -l "$text"
sleep 2
tmux send-keys -t "$id" "$key"
sleep 8
echo "@@sent $name"
tmux capture-pane -p -t "$id" | tr -s ' ' | tr -d '\\n' | grep -F -q "$(printf '%s' "$probe" | tr -s ' ')" && echo "@@seen"
[ "$(tmux capture-pane -p -t "$id" | cksum)" = "$before" ] || echo "@@changed"
echo "@@screen"; tmux capture-pane -p -t "$id" | grep '[[:alnum:]]' | tail -n 3 | tr -s ' '
`;
}

/** What happened on one machine. */
export type SayResult = {
    machine: string;
    outcome: "received" | "typed, not confirmed" | "no lead in tmux" | "skipped" | "unreachable";
    detail: string;
};

/** One machine's result from its script's sections. */
export function sayResult(outcome: ScriptOutcome): SayResult {
    if (!outcome.ok) return { machine: outcome.machine, outcome: "unreachable", detail: outcome.reason };
    const has = (name: string): boolean => outcome.sections.some((entry) => entry.name === name);
    const sent = outcome.sections.find((entry) => entry.name === "sent");
    if (has("skip"))
        return {
            machine: outcome.machine,
            outcome: "skipped",
            detail: outcome.sections.find((e) => e.name === "skip")?.arg ?? "",
        };
    if (sent === undefined)
        return {
            machine: outcome.machine,
            outcome: "no lead in tmux",
            detail: "no ready harness pane in the toli root",
        };
    const screen =
        (section(outcome.sections, "screen") ?? "")
            .split("\n")
            .map((line) => line.replace(/[\uE000-\uF8FF]|[\u{F0000}-\u{FFFFD}]|[╭╮╰╯─│├└]/gu, "").trim())
            .filter((line) => /[A-Za-z0-9]/.test(line))
            .at(-1)
            ?.slice(0, 160) ?? "";
    const evidence = has("seen") ? "pane shows the text" : has("changed") ? "pane changed" : "pane unchanged";
    return {
        machine: outcome.machine,
        outcome: has("seen") || has("changed") ? "received" : "typed, not confirmed",
        detail: `${sent.arg}: ${evidence}; last line: ${screen}`,
    };
}

/** `toli fleet say "<text>" [--key <key>] [--os <uname>] [--to <m1,m2>] [--wait <seconds>] [--json]`. */
export async function sayCommand(argv: string[]): Promise<number> {
    const args = new Args(argv, { booleans: ["json"], values: ["key", "os", "to", "wait"] });
    args.maxPositional(1);
    const text = args.pos(0, "text");
    if (text.trim() === "") throw new ToliError("fleet say needs the text to type");
    const waitText = args.str("wait");
    const waitSeconds = waitText === undefined ? DEFAULT_WAIT_SECONDS : Number(waitText);
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0)
        throw new ToliError("--wait must be whole seconds, 0 or more");
    const options: SayOptions = { text, key: args.str("key") ?? "Enter", os: args.str("os") ?? null, waitSeconds };
    const to = args.str("to");
    const outcomes = await runOnFleet(sayScript(options), {
        withSelf: false,
        capMs: (waitSeconds + SEND_SECONDS) * 1000,
        ...(to === undefined ? {} : { only: to.split(",").map((name) => name.trim()) }),
    });
    const results = outcomes.map(sayResult);
    if (args.bool("json")) printJson(results);
    else for (const result of results) out(`${result.machine}: ${result.outcome} (${result.detail})`);
    return results.some((result) => result.outcome === "typed, not confirmed") ? 1 : 0;
}
