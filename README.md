# toli

Sardar is a personal orchestrator for omp (Oh My Pi). Malik talks to one omp session started
in this repo; Sardar turns each request into work for omp `task` subagents (the "jawans"), and they do all of it:
the code, the checks, the commits, the reports. Sardar itself never does any work, so it is always free to talk.

| Name   | Plural   | Who                                                 |
| ------ | -------- | --------------------------------------------------- |
| Malik  |          | you                                                 |
| Sardar | Saradars | the lead: the omp session you talk to               |
| Jawan  | Jawans   | one helper (an omp `task` subagent) doing one task  |
| Toli   |          | a group of jawans sent out together for one request |
| Paltan |          | all jawans working across all your machines         |

The repo is cloned on three machines. Rules, skills, slash commands, and the CLI are tracked in git; everything
private (projects, backlog, notes, config, logs) is gitignored and stays on each machine.

    cd ~/code/toli && omp

## What Sardar does for you (in simple words)

Think of Sardar as your personal assistant manager. You talk only to Sardar; Sardar hires helpers (omp subagents) to do
all the actual work, including checking each other's work, and tells you the result.

**The one principle: Sardar never works; jawans do everything; Sardar stays available.** Sardar does not read code,
investigate, check proof, commit, write reports or notes, build pages, or run releases itself, not even "quick"
ones. Its own job is only: listening to you, picking the project, asking at most one question, writing the task
down for a jawan, keeping the task list, and asking you before anything that pushes, merges, releases, or
destroys. Everything else goes to a jawan.

How a request flows, without ever blocking the chat:

- You ask. Sardar writes the task, sends a jawan off in the background, replies in a line or two, and is free
  again. You can keep talking to it (or ask for more work) while the jawan runs.
- When the jawan finishes, its result arrives in the chat by itself. For code changes, Sardar sends a second,
  independent jawan to check the proof against what you asked for; that jawan commits the work and closes the
  task, or reports what is missing (and Sardar sends a fix).
- Sardar tells you the outcome in plain words. Long things (work on other machines, timed jobs, fleet status)
  also run in the background and arrive in the chat when they finish.

What that gives you:

1. **One place to talk.** Start `omp` in this folder and just say what you want: "fix the login bug in billing-api",
   "find why the build is slow in web-app". Sardar answers you as "Malik" and replies "Ji Malik".
2. **Many projects.** All your projects live in `projects/`. Sardar figures out which project you mean, and asks once
   if it is not sure.
3. **Helpers do the work, fast.** Sardar gives each job a clear written task and hands it to omp subagents. Several
   helpers (a toli) can work at the same time, even on the same project. Nothing is locked or queued behind each other.
4. **Two kinds of jobs.** "Ship" jobs change code. "Scout" jobs only investigate and write a report in
   `data/reports/`, without touching code.
5. **Proof before done.** A helper must actually run the project's tests or a quick check and show the output.
   When your notes for a project list its URLs, the helper also checks the logs and opens the local page in a
   headless browser; UI changes come with before/after screenshots at your chosen widths, and bug fixes show the
   test failing first and passing after. Staging is only looked at, never changed, and helpers stop at any OTP.
   A second jawan checks that proof before the work counts as finished.
6. **Safe by default.** Sardar commits on the branch you are already on (or the project's fixed branch, if you set
   one), and stops there. It never pushes, merges, releases, or opens a pull request unless you say so. It never
   throws away your unsaved work. Branches are created only when you ask.
7. **Careful review when you want it.** Ask for a branch or PR and Sardar can run your `no-mistakes` pipeline
   (review, tests, docs, lint) with omp. Sardar settles review questions that clearly follow what you already agreed
   and brings you only the ones that widen scope, are unclear, destructive, or touch security.
8. **Three machines, one paltan.** The same Sardar runs on all your machines, and all jawans on them form the paltan. Sardar checks which machine is free
   (CPU, memory, disk, how busy it is) and sends heavy work there. A machine that is asleep or busy is skipped.
9. **Timed jobs.** Say "every day at 5 pm, check X" and Sardar runs it on time, always in the background (never
   inside your chat). When the result is ready it shows up in your chat by itself. Results from other machines come
   back to your main machine.
10. **Picture pages for decisions.** When there are several options, Sardar opens a lavish page in your browser so
    you can tick choices instead of typing.
11. **Memory that stays small.** Sardar keeps notes per project, your preferences, and lessons learned in `data/`,
    and uses them in every new task. Each `/stow` keeps the always-loaded part under a token budget: lessons that
    stop being confirmed for 30 days (7 for "until X" ones) are re-checked or moved to an archive, never deleted.
    Your preferences are never archived unless you say so. Once a week Sardar also lists old job results, finished
    tasks, and logs that could be cleaned up; nothing is removed until you say "prune".
12. **Local stacks.** If a project's notes list how to start and stop its local stack, Sardar starts and stops it in
    the background with exactly those commands. Migrations, logs, and health checks go to a jawan.
13. **Quiet or away.** `/quiet` keeps Sardar to results, failures, and decisions while you are here; `/afk` lets it
    work the queue while you are gone. After half an hour without a message from you, Sardar's next reply starts with
    what needs you, what finished, and what is still running.

Everyday commands you type inside omp:

| Command                         | What it does                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `/bearings`                     | "Where did I leave off?" - status of all projects, work in progress, waiting decisions |
| `/ahoy`                         | Walk through decisions that are waiting for you                                        |
| `/schedule`                     | Add, list, pause, or remove timed jobs ("every day at 5 pm ...")                       |
| `/add-project`, `/drop-project` | Add or remove a project                                                                |
| `/stow`                         | Save what was learned this session and keep memory within its budget                   |
| `/afk`                          | "I'm away" - keep working through queued tasks and give one summary when you are back  |
| `/quiet`                        | "I'm here, keep it short" - only results, failures, and decisions                      |
| `/sync-toli`                    | Pull the latest Sardar rules onto this machine (or all machines)                       |

## First-time setup (each machine)

Requirements: [bun](https://bun.sh), omp, git, `gh` (logged in), and optionally `no-mistakes`. For GitLab projects,
`glab` logged in to each GitLab host in use; for Bitbucket Cloud projects, `BITBUCKET_USERNAME` and
`BITBUCKET_API_TOKEN` (environment or the gitignored `.env` in this repo) or a bitbucket.org login in the git credential
helper.

    git clone https://github.com/yuyudhan/toli.git ~/code/toli
    cd ~/code/toli
    bun install

    # the coordinator (one machine):
    bin/toli init --name <machine> --role coordinator

    # each worker:
    bin/toli init --name <machine> --role worker --coordinator-ssh <host> --coordinator-root <path>

    bin/toli doctor              # checks bun, omp, git, forge auth (gh/glab/bitbucket), no-mistakes, config, clones, fleet, scheduler
    bin/toli schedule install    # runs `bin/toli job tick` every minute (launchd on macOS, crontab on Linux)

List every machine in `config/fleet.json` (on each machine that should see or dispatch to the others):

    {
        "machines": [
            {"name": "<machine>", "ssh": "<host>", "root": "/Users/<you>/code/toli"}
        ]
    }

Optional per-machine capacity thresholds go in `config/machine.json` (defaults shown; `maxRuns` defaults to
`max(1, floor(cpus / 4))`):

    "capacity": {"maxRuns": 2, "maxLoadPerCpu": 0.8, "minMemAvailableMB": 2048, "minDiskFreeGB": 5}

Note: `~/.omp/agent` (and other dotfile links) point into the `projects/yuyudhan-dotfiles` clone. If that clone moves,
re-point the links, or omp loses its global config and skills.

### Machine helpers (macOS)

`scripts/machine/` holds per-machine maintenance that runs from launchd as `com.yuyudhan.toli.<helper>` (logs in
`~/Library/Logs/toli-<helper>.log`). Install the ones a machine needs; re-running is safe:

    scripts/machine/install-launchd cargo-sweep target-reaper    # disk: hourly cargo-sweep, low-disk target/ reaper
    scripts/machine/install-launchd netbird-watch                # reconnect NetBird (Keychain item fm-netbird-setup-key)
    TOLI_AUTH_BROKER_BIND=<tailnet-ip>:<port> scripts/machine/install-launchd omp-auth-broker

## Coordinator and workers

- **Coordinator**: the Sardar Malik talks to day to day. Sees the whole fleet (`bin/toli digest --fleet`), syncs every
  machine (`bin/toli sync --all`), and receives worker results in its inbox.
- **Worker**: has some projects cloned and runs their work and scheduled jobs. Every job result is also sent to the
  coordinator's inbox; if the coordinator is unreachable, results wait in `state/outbox/` and retry every minute.

Each machine's `data/projects.json` lists only the clones on that machine; a project may be cloned on several.
Sardar uses the machines that are free:

    bin/toli resources [--json]               # this machine: load, free memory/disk, active runs, clones, available?
    bin/toli fleet status [--json]            # every machine, probed over ssh in parallel; unreachable is not fatal
    bin/toli pick [--project <p>] [--json]    # best machine for one unit of work; exit 2 with reasons when none
    bin/toli remote auto "<prompt>" --project <p>
    bin/toli remote <machine> "<prompt>" [--project <p>]

`pick` scores each available machine by min(cpu headroom, memory headroom) minus its share of busy run slots; within
0.1 of the best it prefers this machine, then one that already has the clone, then name order. `remote auto` prints
`local` when this machine wins (Sardar then dispatches jawans here); otherwise it runs `bin/toli project ensure` on the
target when the project's URL is known here, then pipes the prompt to `bin/toli exec` there. `exec` and headless job
runs leave a record in `state/runs/` while they run, which is what `activeRuns` counts. Nothing is ever locked or
refused because a machine is busy; availability only steers where work goes.

## Adding projects

In the omp session: `/add-project <name> <git-url>`, or directly:

    bin/toli project add <name> <git-url> [--mode commit|pr|no-mistakes]

This clones into `projects/<name>`, records it, and reports whether the clone is ready for no-mistakes. In the omp
session a jawan does the clone and then writes a short notes file (`data/notes/<name>.md`: stack, commands, gotchas)
that is fed into every jawan brief.

To register clones that are already in `projects/` (copied or moved in by hand), run `bin/toli project import`.

Other project commands: `bin/toli project list`, `bin/toli project path <name>`,
`bin/toli project set <name> [--mode <m>] [--branch <b>|none] [--forge github|gitlab|bitbucket|none]
[--forge-host <host>|none]`, `bin/toli project ensure <name> <git-url>` (idempotent: clone and/or register as needed),
`bin/toli project drop <name> [--delete-clone]` (refuses when the clone is dirty or has unpushed commits).

A project can have a fixed working branch (`--branch`): `bin/toli commit` then refuses to commit when the clone is on
any other branch, and `bin/toli digest` flags the mismatch. Sardar switches or creates branches only on Malik's word.

## Forges, push and pull requests

GitHub (`gh`), GitLab (`glab`, gitlab.com or self-hosted) and Bitbucket Cloud (REST API) are detected from the clone's
`origin` URL. For an ssh endpoint such as `git@gitlab-ssh.<host>:group/repo.git`, the GitLab host comes from glab's
config (the host whose `ssh_host` matches); `project set --forge/--forge-host` override detection.

    bin/toli forge <project> [--json]                  # forge, host, repo path, CLI/credential readiness
    bin/toli push <project>                            # git push -u origin <current branch>; never forced
    bin/toli pr create <project> --title <t> (--body <b> | --body-file <f>) [--base <b>] [--draft]
    bin/toli pr status <project> [<id>] [--json]       # state, mergeable, CI/pipeline, URL (default: current branch)
    bin/toli pr list <project> [--json]
    bin/toli pr merge <project> <id> [--method merge|squash|rebase]

`push` refuses a detached HEAD. `pr create` refuses until the current branch is on origin and contains local HEAD,
then prints the PR/MR URL. Pushing, opening and merging all need Malik's word for that change.

## Slash commands

| Command                                      | What it does                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| `/bearings [lavish]`                         | Status overview: work in flight, questions waiting, job results, inbox  |
| `/ahoy`                                      | Go through every task waiting on a decision                             |
| `/stow`                                      | Save learnings and preferences; re-check stale memory; tidy the backlog |
| `/afk [off]`                                 | Keep working the queue while away; one report on return                 |
| `/quiet [off]`                               | Only outcomes, failures, and decisions while present                    |
| `/add-project`, `/drop-project`              | Register or remove a project                                            |
| `/schedule add\|list\|pause\|resume\|remove` | Recurring jobs                                                          |
| `/sync-toli [--all]`                         | Update the toli repo (fast-forward only)                                |

## Periodic jobs

Say it in plain words; Sardar converts it to cron and confirms:

    /schedule add every day at 5 pm, summarise yesterday's commits in billing-api

becomes

    bin/toli job add billing-daily-summary --cron "0 17 * * *" --prompt "Summarise yesterday's commits..." --project billing-api --shape scout

Jobs never run inside the chat. While the omp session is open, the Sardar extension checks every minute and starts
due jobs in the background (`bin/toli job run-due`, one headless `omp -p` per job); when no session is open, the OS
ticker (`bin/toli job tick`) does the same. Output goes to `data/jobs/<name>/<stamp>.md`. On the same minute the
extension takes new results (`bin/toli wake`: local job results and inbox items, each delivered once) and puts them
into the chat, so Sardar relays them without being asked. Results stay in `/bearings` until acknowledged
(`bin/toli job ack`, `bin/toli inbox ack`). Scheduled runs never push, merge, open PRs, or ask questions.

## Memory and pruning

    bin/toli memory [--json]          # always-loaded memory (data/malik.md + data/learnings.md) in estimated tokens vs budget; notes listed separately
    bin/toli memory stale [--json]    # entries past their lifetime: file, line, id, date, age, tier
    bin/toli memory archive <file> <line-or-id> --reason "<why>" [--force]   # move one entry to data/archive/<file>.md
    bin/toli prune [--apply] [--json] # dry run by default: old job results, finished tasks, logs, seen inbox items

Tokens are estimated as UTF-8 bytes / 3. The budget is `memoryBudgetTokens` in `config/machine.json` (default 7500);
`bin/toli doctor` warns when memory is over it. Entries are dated (`- 2026-10-29: ...`); the date is when the entry was
last confirmed. `data/malik.md` is pinned (never ages; archiving needs `--force` on Malik's word); `data/learnings.md`
and `data/notes/*.md` entries go stale after 30 days, or 7 days when marked `(until: <condition>)`. Archived entries
keep their source file, original date, and reason under a dated heading.

| Pruned by `bin/toli prune --apply`                        | Default rule                                  | What happens                       |
| --------------------------------------------------------- | --------------------------------------------- | ---------------------------------- |
| Job results `data/jobs/<name>/*.md`                       | older than 30 days; the newest 5 per job stay | deleted                            |
| Done or dropped tasks in `data/backlog.json`              | finished more than 90 days ago                | moved to `data/archive/tasks.json` |
| Files in `logs/`                                          | not written for 14 days                       | deleted                            |
| Inbox items `data/inbox/*.md` (delivered worker messages) | acknowledged and older than 14 days           | deleted                            |
| Investigation reports `data/reports/`                     | never                                         | kept                               |

Override any rule in `config/machine.json`, e.g.
`"retention": { "jobResultsDays": 30, "jobResultsKeep": 5, "tasksDays": 90, "logsDays": 14, "inboxDays": 14 }`.
Once a week the ticker (`bin/toli job tick`) posts the dry-run listing to the inbox (a worker sends it to the
coordinator's inbox); it never applies it.

## no-mistakes and lavish

- **no-mistakes** is used only when Malik asks for a branch or PR on a piece of work. A jawan creates the branch
  (`bin/toli branch`), the verifier jawan commits, and a gate jawan drives the gate with a full intent in Malik's
  words. The gate runs omp as its agent (`~/.no-mistakes/config.yaml`: `agent: acp:omp`, `omp: omp acp`); never set
  `disable_project_settings`. Mechanics: the global `no-mistakes` skill; Sardar policy: `.omp/skills/toli-nm`.
- **lavish** (`npx -y lavish-axi`) renders review pages for multi-option decisions, batches of questions, and large
  reports. Yes/no questions stay in chat. A jawan builds and polls each page, so the chat stays free. Pages live in
  `.lavish/`; `lavish-axi share` is never used. Mechanics: the global `lavish` skill; Sardar policy:
  `.omp/skills/toli-lavish`.

## Hard rules

- No git worktrees and no tmux/herdr/zellij windows. Jawans are omp `task` subagents editing `projects/<name>/` directly.
- Default delivery is a commit on the current branch (`bin/toli commit`). Branches only on request.
- Never push, merge, or open a PR without Malik's explicit word for that specific change.
- Never discard uncommitted work: no `git reset --hard`, `git checkout -- .`, `git stash`, `git clean`, branch
  deletion, or force push.
- Destructive, irreversible, or security-sensitive actions go to Malik first.
- No AI co-author trailers (`bin/toli commit` strips them). Malik's name appears in chat only, never in commits, PRs,
  or code.
- Parallel jawans on the same project are allowed, even in the same files; each commits only the paths it changed.
- Scheduled and headless runs never push, merge, open PRs, or ask questions; they write results to files.

## Developing Sardar

Run `just setup` once per clone: `bun install`, points git at `.githooks/`, and lists any missing system tools with
their `brew install` command (shfmt, shellcheck, actionlint, just, gitleaks). Format and lint steps that need a missing
tool fail with that hint instead of skipping.

Every file type has one formatter, all at 4-space indentation, driven by `scripts/format.ts`:

| Files                           | Formatter (config)            | Lint         |
| ------------------------------- | ----------------------------- | ------------ |
| `.ts`, `.json`, `.jsonc`        | Biome (`biome.json`)          | `tsc`, Biome |
| `.md`, `.yml`, `.yaml`          | Prettier (`.prettierrc.json`) |              |
| `.toml`                         | Taplo (`.taplo.toml`)         |              |
| `.githooks/*`, `*.sh`, `*.bash` | shfmt (`.editorconfig`)       | shellcheck   |
| `Justfile`                      | `just --fmt`                  |              |
| `.github/workflows/*.yml`       | Prettier                      | actionlint   |

Day to day: `just fmt` formats everything, `just fmt-check` reports without writing, `just lint` (tsc, Biome, the
other formatters in check mode, shellcheck, actionlint, guards), `just test`, `just check` (lint then tests),
`just guard`; plain `just` lists them, and each wraps the matching `bun run` script. `.vscode/` recommends the
matching editor extensions with format-on-save.

Git hooks:

- **pre-commit**: gitleaks over the staged changes, then `scripts/format.ts` formats the staged files of every type
  above and re-stages the ones it changed (so unstaged hunks in a reformatted file get committed too;
  `git stash push --keep-index` first for a partial commit), then the guards over the staged files.
- **commit-msg**: subject of at most 72 characters with no trailing period, a blank line before the body, and no AI
  co-author or Generated-by trailers.
- **pre-push**: gitleaks over the pushed commits, then `bun run check`.

CI installs the pinned, checksum-verified shfmt, shellcheck, actionlint, and just, uses the Bun version in
`.bun-version`, and runs `bun run lint`, `bun test --coverage` (threshold in `bunfig.toml`), and gitleaks on every push
and PR.

## File layout

Tracked (shared by all machines):

    bin/toli                     CLI entry point (Bun TypeScript)
    src/                         CLI implementation
    AGENTS.md                    Sardar's role and rules for omp
    .omp/extensions/toli.ts      session tracking, background job hand-off, result delivery into the chat
    .omp/skills/toli-*/          Sardar skills (dispatch, projects, deliver, scout, ...)
    .omp/commands/*.md           slash commands
    docs/brief-template.md       template for every jawan brief
    docs/verify-brief-template.md  template for the independent verifier jawan on ship work
    tests/                       bun tests (temp TOLI_ROOT, stubbed ssh/omp/crontab)
    scripts/guard.ts, guard/     hygiene guards; file-size-exceptions.txt ratchets oversized files
    scripts/format.ts            runs every formatter and file-type linter (write, check, lint, tools)
    .githooks/                   pre-commit, commit-msg, pre-push
    .github/workflows/ci.yml     CI: lint, tests with coverage, gitleaks
    biome.json, .gitleaks.toml   formatter/linter and secrets-scan config
    .prettierrc.json, .taplo.toml, .editorconfig, .gitattributes, .bun-version, .vscode/   formatting and editor setup

Private (gitignored, per machine):

    projects/<name>/             project clones
    config/machine.json          this machine's name, role, coordinator
    config/fleet.json            all machines
    config/jobs.json             scheduled jobs
    data/projects.json           registry of this machine's clones
    data/backlog.json            tasks
    data/notes/<project>.md      per-project notes fed into briefs
    data/learnings.md            durable lessons
    data/malik.md                Malik's preferences
    data/reports/<taskId>.md     investigation reports
    data/jobs/<name>/<stamp>.md  job results
    data/archive/                archived memory entries (<file>.md) and old tasks (tasks.json); never loaded
    data/inbox/, data/remote/
    state/                       session.json, jobs.json, acks.json, prune.json, afk flag, outbox/, runs/
    logs/, .env*, .lavish/
