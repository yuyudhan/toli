# Harnesses

toli runs with any of six agent harnesses, in two roles:

- **the lead**: the one session the user talks to, started in toli's root. It only talks, records, briefs, and
  dispatches.
- **jawans**: the workers that do everything else. They run as the lead harness's own background subagents, or as
  headless processes started by `bin/toli spawn` on any installed harness.

One contract (`AGENTS.md`) and one source of skills and commands (`.omp/skills`, `.omp/commands`) serve every
harness. `bin/toli harness sync` links them into each harness's own folders; `bin/toli harness sync --check` (also
run by the tests and `bin/toli doctor`) reports drift.

## Matrix

| Harness     | CLI            | Lead context                           | Skills / commands                               | Background subagents                    | Per-turn guidance and guard                                                                                                                           |
| ----------- | -------------- | -------------------------------------- | ----------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| omp         | `omp`          | `AGENTS.md`                            | `.omp/skills`, `.omp/commands`                  | yes (`task` tool)                       | `.omp/extensions/toli.ts`: guidance every turn, lead guard, result push, subagent reports                                                             |
| Claude Code | `claude`       | `CLAUDE.md` (imports `@AGENTS.md`)     | `.claude/skills`, `.claude/commands` (symlinks) | yes (Agent tool, background by default) | `.claude/settings.json` hooks: UserPromptSubmit, PreToolUse, SessionStart (setup notice), subagent reports (SubagentStart, PostToolUse, SubagentStop) |
| Codex CLI   | `codex`        | `AGENTS.md`                            | `.agents/skills` (no project commands)          | no: the main turn waits, use `spawn`    | rules in `AGENTS.md` only                                                                                                                             |
| Cursor CLI  | `cursor-agent` | `AGENTS.md` + `.cursor/rules/toli.mdc` | `.agents/skills`, `.cursor/commands`            | waits in CLI mode, use `spawn`          | `.cursor/rules/toli.mdc` (always applied)                                                                                                             |
| Grok CLI    | `grok`         | `AGENTS.md`                            | `.claude/skills` (Grok reads Claude skills)     | yes (`spawn_subagent`, background)      | rules in `AGENTS.md`                                                                                                                                  |
| pi          | `pi`           | `AGENTS.md`                            | `.agents/skills`, `.pi/prompts`                 | none by design, use `spawn`             | rules in `AGENTS.md`                                                                                                                                  |

Sources: omp `omp://context-files.md`, `omp://skills.md` (same-file symlinks are de-duplicated by realpath),
`omp://extensions.md` (`before_agent_start`, `tool_call`); Claude Code
[memory](https://code.claude.com/docs/en/memory), [hooks](https://code.claude.com/docs/en/hooks),
[sub-agents](https://code.claude.com/docs/en/sub-agents); Codex
[AGENTS.md](https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs),
[skills](https://developers.openai.com/api/docs/guides/tools-skills); Cursor [rules](https://cursor.com/docs/rules),
[subagents](https://cursor.com/docs/subagents); Grok [skills](https://docs.x.ai/build/features/skills-plugins-marketplaces),
[subagents](https://docs.x.ai/build/features/subagents); pi [skills](https://pi.dev/docs/latest/skills),
[prompt templates](https://pi.dev/docs/latest/prompt-templates).

Grok and pi skill folders: Grok also reads `.claude/skills` and pi reads `.agents/skills`, so toli adds no
`.grok/skills` or `.pi/skills` copy (two copies of one skill would collide by name).

## Starting the lead

`cd` to toli's root and start the harness there; nothing else is needed after `bin/toli harness sync`.

| Harness     | Command        | Notes                                                                                       |
| ----------- | -------------- | ------------------------------------------------------------------------------------------- |
| omp         | `omp`          | The extension registers the session, ticks jobs, and pushes results into the chat.          |
| Claude Code | `claude`       | Results arrive with your next message (UserPromptSubmit hook runs `bin/toli wake`).         |
| Codex CLI   | `codex`        | Dispatch with `bin/toli spawn` (its own subagents block the lead). Check `bin/toli digest`. |
| Cursor CLI  | `cursor-agent` | Dispatch with `bin/toli spawn`.                                                             |
| Grok CLI    | `grok`         | Background subagents or `bin/toli spawn`.                                                   |
| pi          | `pi`           | Dispatch with `bin/toli spawn`.                                                             |

Without a push mechanism (Codex, Cursor, Grok, pi), the lead sees finished jawans in `bin/toli digest` (unseen inbox,
Next block) and with `bin/toli wake`.

## Jawans on any harness: `bin/toli spawn`

    bin/toli spawn --brief <file> [--harness omp|claude|codex|cursor|grok|pi] [--task T<n>] [--project <p>]
                   [--model <m>] [--tier light|standard|deep] [--work scout|qa|desk|mechanical|ship|verify|release]
                   [--cwd <dir>] [--max-time <minutes>] [--now] [--first] [--replace] [--dry-run] [--json]
    bin/toli runs [--json] [--active]
    bin/toli run status <id> [--json] | run log <id> [--lines <n>] | run kill <id>

`spawn` checks the brief starts with `TOLI_BRIEF v1` and the harness CLI is installed (a missing CLI fails at once
with its install and login commands), then returns a run id. A detached supervisor runs the harness in the project
clone (`--task` names the project and is marked active with the run id as its agent) with `TOLI_ROLE=jawan`,
`TOLI_TASK` set to the `--task` id (the jawan's `bin/toli task done|hold|drop` of any other id is refused: only the
lead changes it, so a brief naming a stale or another machine's id never closes an unrelated task here), no
`CARGO_TARGET_DIR` (it builds in the clone's own build folder), toli's cargo shim first on PATH (heavy cargo commands
wait for a heavy-build slot, [fleet.md](fleet.md#heavy-build-slots)) and `CARGO_BUILD_JOBS` set to the machine's
`capacity.cargoJobs` (config/machine.json, default one build slot's share of the cores; ~/.cargo/config.toml
`[build] jobs` mirrors it and `bin/toli doctor` warns when they differ), counts it as load (`bin/toli resources`),
streams output to `data/projects/<p>/runs/<id>/output.log` (`state/jawans/<id>/` without a project), and on exit
records `done`, `failed` or `killed` and posts the outcome to the inbox. The omp extension (and Claude's prompt hook)
bring it into the lead's chat as a `[toli wake]` message. On a worker machine the outcome is also forwarded to the
coordinator's inbox. Run records live in `state/jawans/<id>.json`.

**Jawan slots.** A machine runs at most `capacity.maxRuns` jawans at once (config/machine.json, default a quarter of
the cores): running spawn runs plus the lead's native subagents that are running now, one per distinct agent id
recorded with `task start --agent <id>` on an active task no spawn run works on. A subagent recorded on no open task
(a lead's scout, reviewer or verifier) takes no jawan slot (T2259): its builds and test suites, if any, wait for a
heavy-build slot through the shims and the Node preload it inherits ([fleet.md](fleet.md#heavy-build-slots)), and
counting it would put a one-slot lead at cap with one scout, or deadlock a helper waiting on a run it spawned. A live
lead session is no evidence that any one of its subagents runs: one interactive session outlives the many subagents
it started. The harness
reports each subagent running in `state/agents/<id>.json`, with nothing for the jawan to do. omp: the extension in the
session that started it reads that session's own async-job list every minute and reports each running `task`
subagent (the omp pid and the time), then its end once it stops running; it counts while that report is fresh (3
minutes) from a running omp. Claude Code: the `SubagentStart`, `PostToolUse` and `SubagentStop` hooks (`bin/toli hook
claude-agent`, run in the background) report it at its start, after each of its tool calls and at its stop; it counts
while its last report is younger than `oversight.staleTaskMinutes`, so the lead records the Agent tool's `agentId`.
An agent no harness reports (a label naming who works on it) counts only for
`oversight.staleTaskMinutes` after it was recorded; a `bin/toli remote` run (`remote:<machine>:...`) is the target's
jawan, never one here, and so is a label naming another fleet machine (the task waits on that machine,
docs/fleet.md). `task start --agent` also records the lead session that runs it (the extension-registered
session, the `lead attach` omp or a headless turn's omp, whichever is an ancestor of the command). A subagent recorded
from a live lead session runs until its report says it ended or that session's pid is gone (its subagents died with
it): a report that lapsed, or never came (a harness whose subagents this machine cannot see), never makes it stale,
so the stale-task check and the jawan count read the same state. A finished subagent the watch saw end is ended,
whatever its session does. The digest's Next block lists a task whose subagent died with its session (`its
agent <id> died with its session <pid>`), reported its end (`its run <id> ended ... (state/agents/<id>.json)`), or,
recorded outside a lead session, stopped reporting (`has not reported running since ...`) or never reported (`never
reported running`) for a re-dispatch, after the grace minutes. `spawn` with every slot busy
records the run as `queued` (shown by `bin/toli runs`) and returns; queued runs start oldest first as slots free,
from the supervisor of each run that ends and from the minute tick (`bin/toli job tick`). `--now` starts the run
regardless, for the lead's explicit use. `--first` puts an urgent run at the head of the queue instead: it starts
ahead of every run queued without it, and several `--first` runs start in the order they were queued. A continuation
of a `--first` run (a stall, time-limit or network-fault resume) keeps it. It only reorders the queue: a running run is
never stopped, and a `--first` run still waits for a disk or network hold and for its `notBefore`. `bin/toli runs`
(and the digest) end each queued run's line with its place, `queue 1 (--first)`, `queue 2`, in start order. `run
kill` on a queued run cancels it; a task naming that run as its jawan
goes back to queued with no jawan, ready for the next dispatch. A queued run whose task is done or dropped never
starts: `task drop`, `task done` and `task handback` cancel the task's queued runs and name each, and the queue drain
reads each task again before a start, so a task closed elsewhere (or in a race) has its run cancelled too, logged in
the tick log or the finishing run's `supervisor.log`. A run already started is left to finish, never signalled. The
digest, `bin/toli resources` and `bin/toli fleet queues` show the slots as `jawans <n>/<slots> (<k> native
subagents)`, and `jawans at cap N/N (...): queue instead` once all are taken: the lead then queues new work instead of
starting another subagent.

**Leftover browsers are closed.** When a run's harness exits, the supervisor closes the automation browsers the run
left open: a browser binary (Chrome, Chromium, its headless shell, Edge, Brave, Firefox) started with remote
debugging, headless, `--enable-automation` or marionette, or with a `--user-data-dir` under a temp dir (what
Playwright, Puppeteer and DevTools MCP servers launch). Only the run's own processes count: its tree, sampled every
10 seconds while the harness lives (pid and start time, so a browser reparented once its launcher exits stays known),
and on Linux every process that inherited the run's `TOLI_RUN_ID`. Each gets SIGTERM, then SIGKILL after 5 seconds,
with its own tree, and the log notes `[toli] closed the automation browser(s) the run left open: pid ...`. A browser
on the user's default profile is never touched, even one the jawan opened, and nothing outside the run's tree is.
Native subagents have no supervisor: their briefs say to close every browser they start.

**One live jawan per task.** `spawn --task T<n>` refuses while T<n> already has a live run on this machine (queued,
starting or running), naming the run and suggesting `write agent://<id>` to steer it, so two jawans never edit the
same copy. `--replace` supersedes it instead: each live run is stopped as `bin/toli run kill` does (its outcome is
still posted, as killed), the new run records `replaces`, the old one `replacedBy`, and both appear in the inbox
outcomes. A run whose supervisor died while marked running does not block: it is recorded failed as `bin/toli runs`
always does, and the spawn proceeds. Runs for other tasks, and spawns without `--task`, are unaffected.

**No time limit; stalls are resumed in the same session.** A jawan run has no wall-clock limit: it works until it is
done, like the lead. toli stops it only when it shows no progress for `capacity.stallMinutes` (default 30): its output
log did not grow, its omp session (`<run dir>/session`, passed as `--session-dir`, where omp writes every message and
tool call) did not change, the files of its working tree did not change, and its process tree used less than 10 CPU
seconds. A long build or test the run waits on keeps it alive through its CPU use. Work that sits silent longer by
design, such as a release run watching a remote CI pipeline, carries a `Stall: <minutes>` line in its brief header
(before the first `## ` section, like `Tier:`; for example `Stall: 90`): that run, its exec run or scheduled job
uses those minutes instead of `capacity.stallMinutes`, and `bin/toli runs --json` shows them as `stallMinutes`. A
malformed value is refused at spawn. A stalled run without a report is
recorded `stalled` and resumed: on omp the same session continues (`omp --resume <session file>`) with a short
`## RESUME (auto, N)` prompt saying why it stopped, so nothing is re-read or redone; on other harnesses a fresh run
gets the original brief plus a `## RESUME (auto, N)` section naming the previous run, its log and its uncommitted
edits. The continuation has the same task, project, cwd, harness and model; the task's notes record every resume and
name the continuation as its agent, and the stopped run's inbox item says `continued by: <id>`. A chain gets at most
`capacity.autoResume` resumes (default 3, 0 turns it off); after that an inbox item and the task's notes say why the
chain stopped. A run that ended with a report is never resumed. The lead can resume any finished run with
`bin/toli resume <run> [--note "<text>"] [--max-time <minutes>] [--now]`: the same session continues, with the note.

`--max-time <minutes>` is an explicit opt-in limit: the brief then gains a `## Deadline (auto)` section (when the
limit ends the run, and a request to report 10 minutes before, halfway for limits under 20 minutes); a run that used
it without a report is recorded `time-limit` and resumed the same way.

**Network faults are requeued, and no jawan starts while the model API does not resolve.** A run whose harness gave
up on the model API with a network-class error in its last lines (`EAI_AGAIN`, `ENOTFOUND`, `ECONNRESET`, such as
omp's `Retry budget exhausted after 3 retries: getaddrinfo EAI_AGAIN <host>`) is recorded failed with
`network fault: <that line>` and continued the same way, in the same omp session, within `capacity.autoResume`. A
chain is requeued for a network fault at most once every 10 minutes: a requeued run that fails the same way within 10
minutes of its start waits out the rest (`notBefore` on the queued run). A name that did not resolve also records the
host (the one the error names, else the model's provider: `api.anthropic.com` for Claude models and `provider/`
names, `api.openai.com` for Codex, ...) in `state/network-fault.json`. While it still does not resolve, toli starts no
jawan: spawns, continuations and the queue wait, `spawn` says why, and `logs/network.log` gets one line for the hold
and one when the host resolves again, after which the minute tick starts the queue. `spawn --now` starts one anyway.

**No request budget.** omp's `task.softRequestBudget` (200 requests per subagent by default, force-stopped at 1.5x)
told long-running subagent jawans to wrap up and then stopped them. toli's root carries `.omp/config.yml` with
`task.softRequestBudget: 0` (no budget), which omp reads as project settings for the lead and every run in toli's
root (`bin/toli exec`, scheduled jobs), and every headless omp jawan working elsewhere gets it with `--config`.

omp jawans run with `--wait-async`: a turn that ends while an async `task` subagent, a background `bash` build, or a
poll the run started is still going does not end the run. omp waits for that work and starts another turn with each
result, until nothing the run owns is left (or an explicit `--max-time` stops it). Without the flag, print mode exits
at the first turn that yields and cancels that work. The same flags apply to `bin/toli exec` (local headless prompts)
and scheduled headless jobs.

Headless commands (`src/harness/harness.ts`):

| Harness | Command                                                                                                                                                                                         | Source                                                                                     |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| omp     | `omp -p --wait-async --cwd <dir> --no-title --approval-mode yolo [--max-time <n>m] [--config <toli>/.omp/config.yml] --session-dir <run>/session [--resume <file>] [--model M]`, brief on stdin | `omp --help`, `omp://cli-reference.md`                                                     |
| claude  | `claude -p --output-format text --permission-mode acceptEdits --allowedTools Bash,Read,Edit,Write,... --add-dir <toli> [--model M]`, brief on stdin                                             | `claude --help`, [CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage) |
| codex   | `codex exec --sandbox workspace-write -c sandbox_workspace_write.network_access=true --add-dir <toli> --skip-git-repo-check -C <dir> [-m M] -`, brief on stdin                                  | [non-interactive mode](https://developers.openai.com/codex/noninteractive)                 |
| cursor  | `cursor-agent -p --force --output-format text [--model M] <pointer>`, cwd = project                                                                                                             | [headless](https://docs.cursor.com/en/cli/headless)                                        |
| grok    | `grok --cwd <dir> --always-approve --no-auto-update --output-format plain [-m M] -p <pointer>`                                                                                                  | [headless & scripting](https://docs.x.ai/build/cli/headless-scripting)                     |
| pi      | `pi -p [--model M]`, brief on stdin, cwd = project                                                                                                                                              | [pi README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md) |

The brief never goes on a jawan's command line: there `ps` shows it to every user, `pkill -f <pattern>` matches every
jawan whose brief mentions the pattern, and a long brief can exceed the argument length limit. Harnesses that read
their prompt from stdin get it there unchanged. Cursor CLI and Grok document no stdin prompt, so their `<pointer>` is
a two-line prompt, `TOLI_BRIEF v1` and a sentence naming the run's `brief.md` to read in full and follow.

`--add-dir <toli>` lets Claude and Codex jawans write their report and run `bin/toli` in toli's root. Codex jawans
have network access by default: Codex's `workspace-write` sandbox blocks the network on its own, and toli always
passes `sandbox_workspace_write.network_access=true` because tests, installs, `git fetch`/`push` and forge CLIs need
it. The sandbox still confines writes to the working directory and the `--add-dir` paths.

**Native subagents or spawn?** Use the lead harness's own background subagents (omp `task`, Claude's Agent tool,
Grok background subagents) for normal work: they start fast and share the lead's login. Use `spawn` when the lead's
harness has no background subagents (Codex, Cursor CLI, pi), to run work on another vendor or model, or when the run
must outlive the lead session.

### Default harness per work type

`config/machine.json`:

```json
{
    "harness": {
        "jawan": "omp",
        "byWork": { "scout": "claude", "verify": "claude" },
        "models": { "claude": "sonnet" }
    }
}
```

`spawn` without `--harness` uses `byWork[<work>]` (from `--work`, or the task's shape), then `jawan`, then omp.
`models` supplies `--model` when neither a tier nor a work type picks one (next section). `bin/toli doctor` warns when a
configured harness is missing or logged out, and the digest's Next block says how to install it.

### Model tiers and models per kind of work

Every jawan runs on a model chosen for its kind of work, so testing and lookups do not spend the strongest model's
usage. Kinds of work: `scout` (read-only investigation), `qa` (running test cases against a product), `desk`
(triaging and filing what testers find), `mechanical` (bookkeeping, renames, data collection), `ship` (code changes),
`verify` (the independent checker) and `release`. Each kind belongs to one of three tiers and runs on its tier's model
list unless it has a list of its own:

| Tier       | omp default list (first available wins)                                                   | Kinds on it by default |
| ---------- | ----------------------------------------------------------------------------------------- | ---------------------- |
| `light`    | `anthropic/claude-haiku-5-5`, `anthropic/claude-haiku-4-5`                                | `mechanical`           |
| `standard` | `anthropic/claude-sonnet-5-5`, `anthropic/claude-sonnet-5`, `anthropic/claude-sonnet-4-6` | `scout`, `qa`, `desk`  |
| `deep`     | `anthropic/claude-opus-5-5`, `anthropic/claude-opus-5`                                    | `verify`, `release`    |

`ship` (code changes) has its own empty list by default: it runs on the harness's own default model, as the lead
does, and is on the `standard` tier only for its limit fallback. The defaults are data, not code:
`src/harness/default-models.json` (omp and Claude Code lists, each kind's tier, and `ship`'s empty list), so every
machine has them after `bin/toli upgrade` with no config, and nothing in toli's code names a model or a provider.
Codex, Cursor, Grok and pi have no default lists: they keep their own default model unless configured.

A model list is ordered: a run takes the first model this machine can run. omp reports which those are
(`omp models --json`); `bin/toli models check` (also run by `models set` and `harness sync`) records them in
`state/model-catalog.json`, and `spawn`, `exec` and scheduled jobs pick from each list with it. Without a catalog, or
when none of the list is in it, the first model runs.

**Precedence**, most specific first: `--model` > `--tier` > the brief's `Tier:` line (docs/brief-template.md) > the
task's tier (`bin/toli task add --tier`) > the kind of work's own list, else its tier's list (the kind is `--work`, else
the brief's `Work:` line, else the task's shape) > `harness.models` > the harness's own default. A tier or kind the
harness has no model for falls through to `harness.models`, then the harness default. `bin/toli spawn --dry-run [--work
w] [--tier t] [--brief f]` prints the harness, model, tier, what chose it and the omp subagent for the kind, without
writing anything.

**Every path** resolves the same way on the machine that runs the work: `spawn` (and its queued starts and automatic
continuations), `bin/toli exec` (local only; `TOLI_EXEC_WORK` or the prompt's `Work:` line), and scheduled headless
jobs (`job add --tier`, else the shape's kind: scout runs on `standard`, ship on the harness default). A delegated task's brief keeps its `Work:` and
`Tier:` lines, and its `--tier` becomes the task's tier on the receiving machine, whose lead dispatches it there and
picks the model with that machine's own tables.

**Native subagents.** A lead's in-session subagents (omp `task`) are started by the lead, not toli, and omp's `task`
tool takes no model of its own. So `bin/toli harness sync` writes one omp agent per kind of work,
`.omp/agents/toli-<kind>.md` (gitignored, generated from this machine's tables), whose frontmatter names the kind's
model list; omp tries it in order and skips a model it cannot run. The lead picks the model by picking the agent:
`agent: toli-qa` for a testing slice, `toli-desk` for a QA desk, `toli-scout` for a scout, `toli-mechanical` for
bookkeeping, `toli-ship` for code changes, `toli-verify` for the verifier, `toli-release` for release steps. Without
an agent the subagent runs on the lead's own model. omp's own `task.agentModelOverrides` (user config) still wins over
an agent's list. Claude Code leads pass the kind's model (`bin/toli models show --harness claude`) as the Agent tool's
`model`.

**Changing models: `bin/toli models`.**

    bin/toli models show [--harness omp] [--json]          # each kind and tier: its list, what runs here, the subagent
    bin/toli models set qa google/gemini-3-flash,anthropic/claude-sonnet-4-6   # any provider's ids, in order
    bin/toli models set light local/small                   # a tier's list
    bin/toli models set ship none                           # the harness's own default model
    bin/toli models unset qa                                # back to toli's default (the tier's list)
    bin/toli models check [--fleet]                         # which of the ids this machine (each machine) can run

`set` and `unset` take `--harness <h>` (default omp) and `--fleet`, which runs the same command on every other fleet
machine over ssh, so one instruction switches the whole fleet; a machine that takes no inbound ssh is named with the
`bin/toli talk` to send its Sardar instead. `check` exits 1 when a kind or tier has no model this machine can run, so a
switch to another provider can be checked on every machine (`check --fleet`) before work runs on it.

The tables live in `config/machine.json` (`set` writes them; every entry is optional and overrides the default entry
by entry):

```json
{
    "harness": {
        "tiers": { "omp": { "light": ["local/small"] }, "codex": { "deep": "gpt-5.2" } },
        "workModels": { "omp": { "qa": ["google/gemini-3-flash", "anthropic/claude-sonnet-4-6"], "ship": [] } },
        "workTiers": { "scout": "light" },
        "fallback": { "anthropic/claude-sonnet-5-5": "openrouter/anthropic/claude-sonnet-5-5" },
        "limitWaitMinutes": 300
    }
}
```

`tiers` sets a harness's list per tier, `workModels` a kind's own list (an empty list: the harness's own default), and
`workTiers` a kind's tier (its limit fallback steps down from it). A single id works wherever a list does.
**Limit fallback:** a run that stops on a rate or usage limit (`429`, `rate_limit_error`, "usage limit" in the tail
of its output) retries once: on `fallback[<model>]` (the same tier on another account or provider) when configured,
else on the first available model one tier lower, never below standard for `ship`, `verify`, `release` or work of
unknown type (scout, qa, desk and mechanical may drop to light); else on the
same model after the reset the error names (an ISO time, a `|<epoch>`, "in N minutes", `retry-after-ms`,
`retry-after` in seconds, "resets 3pm"; 15 minutes when it names none), unless that is more than `limitWaitMinutes`
(default 300) away. The decision is logged in the run's output and recorded as `fallback` on the run.
`bin/toli exec` and scheduled jobs never wait for a reset: they only switch model, and a scheduled job whose limit
names a reset skips its due runs until then ([jobs.md](jobs.md#rate-and-usage-limits)).

**Records:** each run records `harness`, `model`, `tier` and `modelSource` (`bin/toli runs`, `run status`, the
outcome in the inbox), plus `usage` (tokens, cost) when the harness prints them (Codex's `tokens used`; omp and Claude
Code in text mode print neither). `bin/toli digest` lists today's runs per model ("models today") and
`bin/toli resources --json` carries the same totals as `models`.

## Lead guard and guidance

The lead is the session started in toli's root that is not a jawan. Jawans are recognised by `TOLI_ROLE=jawan` (set
by `spawn`), `NO_MISTAKES_GATE`, a subagent id, a first prompt starting `TOLI_BRIEF v1`, or a working directory other
than toli's root; they are never guarded.

- **Guard** (`src/harness/lead-guard.ts`): the lead may write only under `data/`, `state/`, `config/` (plus temp files and
  Claude plan files) and may not read, grep, or glob under `projects/` or the real checkout of any project there (a
  linked project's target directory). Paths compare by their symlink-resolved real location, so a toli reached
  through a symlink (macOS `/tmp`) or a linked checkout in temp is never treated as scratch. Shell commands are not
  blocked, so `bin/toli` bookkeeping always works. omp: the extension's `tool_call` handler. Claude Code: `PreToolUse` hook
  (`bin/toli hook claude-pre-tool`). Hooks fail open: an internal error allows the call. Codex, Cursor and Grok have
  hook systems, but none reliably tells the lead from its subagents, so they rely on `AGENTS.md`.
- **Guidance** (`bin/toli guidance`): reply in 1-3 short lines unless asked for detail (the first rule), record every
  request as a task, delegate everything, dispatch in the background, never wait or poll, use `bin/toli` and the
  skills. omp appends it to the lead's system prompt each turn; Claude Code adds it on each prompt (with any new
  results); Cursor gets it from its always-apply rule; the others read the same rules in `AGENTS.md`.

## Browsers use fake media

No browser a toli harness session starts may use the machine's real camera or microphone. The lead (the omp
extension and Claude Code's SessionStart, through `bin/toli hook lead-build-env`), its native subagents and every
`bin/toli spawn` jawan get `PUPPETEER_EXECUTABLE_PATH` at `bin/chrome-fake-media` (src/jawans/env.ts
`fakeMediaEnv`), so omp's browser, and any other puppeteer, starts Chrome through it. The wrapper runs the real
Chrome with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` ahead of the caller's own arguments:
getUserMedia gets Chrome's fake camera and microphone, and the permission prompt is accepted on its own.

- **Which Chrome:** `TOLI_CHROME`, else a `PUPPETEER_EXECUTABLE_PATH` the session already had (kept as
  `TOLI_CHROME`), else the first of the usual install paths (`/usr/bin/google-chrome-stable`, `/usr/bin/google-chrome`,
  `/opt/google/chrome/chrome`, Chromium's, and the macOS `.app` bundles). It is never looked up on PATH.
- **What the fake camera shows:** `config/machine.json` `{ "browser": { "fakeVideoFile": "<file>" } }` (absolute, or
  relative to toli's root) or `TOLI_FAKE_VIDEO_FILE`, which wins, names a `.y4m` or `.mjpeg` file the camera plays in
  a loop (`--use-file-for-fake-video-capture`); default none, or a file that does not exist: Chrome's built-in test
  pattern. Make one from a still with ffmpeg:
  `ffmpeg -loop 1 -framerate 15 -t 10 -i face.jpg -pix_fmt yuv420p -vf scale=640:480 -r 15 face.y4m`.
- **Restart:** omp reuses a browser that is already running, so the flags reach it only once that browser has
  stopped and started again.

## Install and login

| Harness     | Install                                           | Login                                      | Check                 |
| ----------- | ------------------------------------------------- | ------------------------------------------ | --------------------- |
| omp         | `bun install -g @oh-my-pi/pi-coding-agent`        | `omp login`                                | `omp --version`       |
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` | `claude auth login` or `ANTHROPIC_API_KEY` | `claude auth status`  |
| Codex CLI   | `npm install -g @openai/codex`                    | `codex login` or `CODEX_API_KEY`           | `codex login status`  |
| Cursor CLI  | `curl https://cursor.com/install -fsS \| bash`    | `cursor-agent login` or `CURSOR_API_KEY`   | `cursor-agent status` |
| Grok CLI    | `curl -fsSL https://x.ai/cli/install.sh \| bash`  | `grok login` or `XAI_API_KEY`              | `grok --version`      |
| pi          | `npm install -g @earendil-works/pi-coding-agent`  | provider API key or `/login` in pi         | `pi --version`        |

`bin/toli harness status` (and `bin/toli doctor`) shows which CLIs are installed, their versions, and their login
state where the CLI can report it without starting a session. omp is required on every machine: scheduled jobs run
in headless omp.

### Service environment

The lead service, the tick and the helpers (launchd agent, systemd user service or crontab line) start toli with
little more than PATH, and `bin/toli exec` over ssh runs in a non-login shell, so a provider key exported in the shell
profile (e.g. `ANTHROPIC_API_KEY`) would be missing there. Before toli starts a harness (a jawan's supervisor, a lead
turn, a scheduled job, `exec`), it runs the user's login shell once (`$SHELL -i -l -c`, the same profile files an ssh
login reads; when `$SHELL` is cron's `/bin/sh`, the shell the user database names) and adds every variable the process
lacks. What the process already has wins, PATH included: services keep the PATH they were installed with. The values
stay in memory and reach only the harness's process tree; nothing is written to a plist, unit file, crontab, log or
disk, so a profile change reaches the next harness start without reinstalling a service. `TOLI_LOGIN_ENV=1` marks a
process that already has it (children skip the capture); `TOLI_LOGIN_ENV=off` turns it off. A capture that fails or
takes over 15 s is warned about in the service's log and the harness starts with the environment it has.

PATH is the exception the other way round: every toli command, as it starts, appends the user's tool folders its PATH
lacks and that exist: cargo's (`$CARGO_HOME/bin`, default `~/.cargo/bin`), Bun's (`$BUN_INSTALL/bin`, default
`~/.bun/bin`), `~/.local/bin`, `~/bin`, `/opt/homebrew/bin` and `/usr/local/bin` (src/core/tool-path.ts). As ssh's
StrictModes asks, a folder is added only when it and each folder above it (up to your home folder for one under it,
else `/`) are owned by you or root, are not world-writable and are group-writable only for a group you are in, so no
other user can plant a `cargo` there or swap the folder for one; a PATH entry with a trailing slash counts as the same
folder. So a jawan, catch-up, job, gate, push or commit check started by
the lead service or the tick finds a toolchain installed after the service was, without its login profile and however
the service was started. They go after what PATH holds, so the service's own folders keep their precedence and a
jawan's cargo shim stays first (docs/fleet.md). `TOLI_TOOL_DIRS=off` leaves PATH alone (tests). A staged `Cargo.lock`
that `bin/toli commit` cannot check because no cargo is found (none on PATH, or only toli's shim) is refused with
`cargo not found on PATH` and the PATH it searched.

`bin/toli doctor`'s `service-env` check runs the login shell from a service's environment and warns, by name only,
about each `*_API_KEY`, `*_AUTH_TOKEN` or `*_OAUTH_TOKEN` variable set in your shell that the login profile does not
export (set only in a terminal session, or in a file the login shell does not read): export it in the profile.
