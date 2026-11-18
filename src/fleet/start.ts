// `bin/toli fleet start [--session <s>] [--window <w>] [--harness <h>] [--key <key>] [--message "<text>"]
// [--attach "<shell command>"] [--listener] [--os Linux|Darwin]`: after a reboot, start the lead in tmux on every
// other fleet machine where none runs (a machine whose lead already runs in tmux is never touched): a detached tmux
// session (or a new window in an existing one) in the toli root running the harness, optionally a terminal attached
// to it (`--attach`, run on that machine, e.g. a terminal emulator on a desktop workspace), and the first message
// typed and submitted with `--key` once the harness has drawn its status bar. `--listener` also starts the HTTPS
// peer listener as a systemd user unit (`toli-peer-serve`) on Linux machines where none runs, first moving aside a
// lock whose pid now belongs to a process that is not toli (a pid reused after the reboot).
import { Args } from "../core/args.ts";
import { out, printJson, shellQuote, ToliError } from "../core/util.ts";
import { parseHarness, SPECS } from "../harness/harness.ts";
import { LEAD_PANES_SH, runOnFleet, type ScriptOutcome } from "./machine-script.ts";

/** Waiting for an attached client (60 s) and the harness (90 s), typing, then the listener. */
const START_CAP_MS = 240_000;

export type StartOptions = {
    session: string;
    window: string;
    binary: string;
    key: string;
    message: string | null;
    attach: string | null;
    listener: boolean;
    os: string | null;
};

const LISTENER_SH = `
if [ "$(uname -s)" != Linux ] || ! command -v systemd-run >/dev/null 2>&1; then
  echo "@@listener not started: no systemd-run here"
elif systemctl --user is-active --quiet toli-peer-serve; then
  echo "@@listener already running (toli-peer-serve)"
else
  skip=
  lock=state/peer-listener.lock
  pid=$(tr -dc 0-9 < "$lock" 2>/dev/null)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    case "$(ps -o args= -p "$pid" 2>/dev/null)" in
      *toli*) skip=1; echo "@@listener already running (pid $pid)" ;;
      *)
        stamp=$(date +%s)
        mv "$lock" "$lock.stale-$stamp"
        [ -f state/peer/listener.json ] && mv state/peer/listener.json "state/peer/listener.json.stale-$stamp"
        echo "@@cleared stale listener lock: pid $pid is not toli"
        ;;
    esac
  fi
  if [ -z "$skip" ]; then
    systemctl --user reset-failed toli-peer-serve >/dev/null 2>&1
    systemd-run --user --unit toli-peer-serve -p Restart=always --working-directory="$PWD" "$PWD/bin/toli" peer serve >/dev/null 2>&1
    sleep 3
    if systemctl --user is-active --quiet toli-peer-serve; then echo "@@listener started (toli-peer-serve)"; else echo "@@listener failed to start"; fi
  fi
fi
`;

/** The script each machine runs. */
export function startScript(options: StartOptions): string {
    const target = `${options.session}:${options.window}`;
    return `${LEAD_PANES_SH}
want=${shellQuote(options.os ?? "")}
if [ -n "$want" ] && [ "$(uname -s)" != "$want" ]; then echo "@@skip $(uname -s)"; exit 0; fi
session=${shellQuote(options.session)}; target=${shellQuote(target)}
running=$(lead_panes | head -n 1)
if [ -n "$running" ]; then
  echo "@@running $(printf '%s' "$running" | cut -d'|' -f2- | tr '|' ' ')"
elif ! command -v tmux >/dev/null 2>&1; then
  echo "@@failed no tmux here"
else
  if tmux has-session -t "$session" 2>/dev/null; then
    tmux new-window -t "$session" -n ${shellQuote(options.window)} -c "$PWD"
  else
    tmux new-session -d -s "$session" -n ${shellQuote(options.window)} -c "$PWD" -x 200 -y 50
  fi
  ${
      options.attach === null
          ? ":"
          : `(${options.attach}) >/dev/null 2>&1
  for _ in $(seq 1 30); do [ "$(tmux list-clients -t "$session" 2>/dev/null | wc -l)" -gt 0 ] && break; sleep 2; done`
  }
  tmux send-keys -t "$target" ${shellQuote(options.binary)} Enter
  ready=0
  for _ in $(seq 1 45); do
    sleep 2
    tmux capture-pane -p -t "$target" 2>/dev/null | grep -q '────────' && ready=$((ready + 1))
    [ "$ready" -ge 2 ] && break
  done
  if [ "$ready" -lt 2 ]; then
    echo "@@failed ${options.binary} drew no status bar in 90 s in $target"
  else
    ${
        options.message === null
            ? ":"
            : `sleep 3
    tmux send-keys -t "$target" -l ${shellQuote(options.message)}
    sleep 1
    tmux send-keys -t "$target" ${shellQuote(options.key)}`
    }
    echo "@@started $target"
  fi
fi
${options.listener ? LISTENER_SH : ""}`;
}

export type StartResult = { machine: string; lead: string; listener: string | null };

/** One machine's result from its script's sections. */
export function startResult(outcome: ScriptOutcome): StartResult {
    if (!outcome.ok) return { machine: outcome.machine, lead: `unreachable: ${outcome.reason}`, listener: null };
    const lead = outcome.sections.find((entry) => ["skip", "running", "started", "failed"].includes(entry.name));
    const leadText =
        lead === undefined
            ? "no answer"
            : { skip: "skipped", running: "already running", started: "started", failed: "failed" }[lead.name] +
              (lead.arg === "" ? "" : `: ${lead.arg}`);
    const listener = outcome.sections
        .filter((entry) => entry.name === "listener" || entry.name === "cleared")
        .map((entry) => `${entry.name === "cleared" ? "cleared " : ""}${entry.arg}`);
    return { machine: outcome.machine, lead: leadText, listener: listener.length === 0 ? null : listener.join("; ") };
}

/** `toli fleet start ...`. */
export async function startCommand(argv: string[]): Promise<number> {
    const args = new Args(argv, {
        booleans: ["json", "listener"],
        values: ["session", "window", "harness", "key", "message", "attach", "os"],
    });
    args.maxPositional(0);
    const session = args.str("session") ?? "toli";
    const window = args.str("window") ?? "lead";
    if (!/^[A-Za-z0-9_.-]+$/.test(session) || !/^[A-Za-z0-9_.-]+$/.test(window))
        throw new ToliError("--session and --window take letters, digits, '.', '_' and '-'");
    const options: StartOptions = {
        session,
        window,
        binary: SPECS[parseHarness(args.str("harness") ?? "omp")].binary,
        key: args.str("key") ?? "Enter",
        message: args.str("message") ?? null,
        attach: args.str("attach") ?? null,
        listener: args.bool("listener"),
        os: args.str("os") ?? null,
    };
    const results = (await runOnFleet(startScript(options), { withSelf: false, capMs: START_CAP_MS })).map(startResult);
    if (args.bool("json")) printJson(results);
    else
        for (const result of results)
            out(
                `${result.machine}: lead ${result.lead}${result.listener === null ? "" : `; listener ${result.listener}`}`,
            );
    return results.some((result) => result.lead.startsWith("failed")) ? 1 : 0;
}
