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

| Harness     | CLI            | Lead context                           | Skills / commands                               | Background subagents                    | Per-turn guidance and guard                                                              |
| ----------- | -------------- | -------------------------------------- | ----------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------- |
| omp         | `omp`          | `AGENTS.md`                            | `.omp/skills`, `.omp/commands`                  | yes (`task` tool)                       | `.omp/extensions/toli.ts`: guidance every turn, lead guard, result push                  |
| Claude Code | `claude`       | `CLAUDE.md` (imports `@AGENTS.md`)     | `.claude/skills`, `.claude/commands` (symlinks) | yes (Agent tool, background by default) | `.claude/settings.json` hooks: UserPromptSubmit, PreToolUse, SessionStart (setup notice) |
| Codex CLI   | `codex`        | `AGENTS.md`                            | `.agents/skills` (no project commands)          | no: the main turn waits, use `spawn`    | rules in `AGENTS.md` only                                                                |
| Cursor CLI  | `cursor-agent` | `AGENTS.md` + `.cursor/rules/toli.mdc` | `.agents/skills`, `.cursor/commands`            | waits in CLI mode, use `spawn`          | `.cursor/rules/toli.mdc` (always applied)                                                |
| Grok CLI    | `grok`         | `AGENTS.md`                            | `.claude/skills` (Grok reads Claude skills)     | yes (`spawn_subagent`, background)      | rules in `AGENTS.md`                                                                     |
| pi          | `pi`           | `AGENTS.md`                            | `.agents/skills`, `.pi/prompts`                 | none by design, use `spawn`             | rules in `AGENTS.md`                                                                     |

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
                   [--model <m>] [--work scout|ship|verify] [--cwd <dir>] [--max-time <minutes>] [--json]
    bin/toli runs [--json] [--active]
    bin/toli run status <id> [--json] | run log <id> [--lines <n>] | run kill <id>

`spawn` checks the brief starts with `TOLI_BRIEF v1` and the harness CLI is installed (a missing CLI fails at once
with its install and login commands), then returns a run id. A detached supervisor runs the harness in the project
clone (`--task` names the project and is marked active with the run id as its agent) with `TOLI_ROLE=jawan`, counts
it as load (`bin/toli resources`), streams output to `data/projects/<p>/runs/<id>/output.log` (`state/jawans/<id>/`
without a project), and on exit records `done`, `failed` or `killed` and posts the outcome to the inbox. The omp
extension (and Claude's prompt hook) bring it into the lead's chat as a `[toli wake]` message. On a worker machine the
outcome is also forwarded to the coordinator's inbox. Run records live in `state/jawans/<id>.json`.

Headless commands (`src/harness.ts`):

| Harness | Command                                                                                                                                                        | Source                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| omp     | `omp -p --cwd <dir> --no-title --approval-mode yolo --max-time <n>m [--model M] <brief>`                                                                       | `omp --help`, `omp://cli-reference.md`                                                     |
| claude  | `claude -p --output-format text --permission-mode acceptEdits --allowedTools Bash,Read,Edit,Write,... --add-dir <toli> [--model M]`, brief on stdin            | `claude --help`, [CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage) |
| codex   | `codex exec --sandbox workspace-write -c sandbox_workspace_write.network_access=true --add-dir <toli> --skip-git-repo-check -C <dir> [-m M] -`, brief on stdin | [non-interactive mode](https://developers.openai.com/codex/noninteractive)                 |
| cursor  | `cursor-agent -p --force --output-format text [--model M] <brief>`, cwd = project                                                                              | [headless](https://docs.cursor.com/en/cli/headless)                                        |
| grok    | `grok --cwd <dir> --always-approve --no-auto-update --output-format plain [-m M] -p <brief>`                                                                   | [headless & scripting](https://docs.x.ai/build/cli/headless-scripting)                     |
| pi      | `pi -p [--model M] <brief>`, cwd = project                                                                                                                     | [pi README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md) |

`--add-dir <toli>` lets Claude and Codex jawans write their report and run `bin/toli` in toli's root. Codex's
`workspace-write` sandbox blocks network by default; toli enables it because tests and installs need it.

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
`models` supplies `--model` when none is given. `bin/toli doctor` warns when a configured harness is missing or
logged out, and the digest's Next block says how to install it.

## Lead guard and guidance

The lead is the session started in toli's root that is not a jawan. Jawans are recognised by `TOLI_ROLE=jawan` (set
by `spawn`), `NO_MISTAKES_GATE`, a subagent id, a first prompt starting `TOLI_BRIEF v1`, or a working directory other
than toli's root; they are never guarded.

- **Guard** (`src/lead-guard.ts`): the lead may write only under `data/`, `state/`, `config/` (plus temp files and
  Claude plan files) and may not read, grep, or glob under `projects/`. Shell commands are not blocked, so `bin/toli`
  bookkeeping always works. omp: the extension's `tool_call` handler. Claude Code: `PreToolUse` hook
  (`bin/toli hook claude-pre-tool`). Hooks fail open: an internal error allows the call. Codex, Cursor and Grok have
  hook systems, but none reliably tells the lead from its subagents, so they rely on `AGENTS.md`.
- **Guidance** (`bin/toli guidance`): record every request as a task, delegate everything, dispatch in the background
  and reply in one or two lines, never wait or poll, use `bin/toli` and the skills. omp appends it to the lead's system
  prompt each turn; Claude Code adds it on each prompt (with any new results); Cursor gets it from its always-apply
  rule; the others read the same rules in `AGENTS.md`.

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
