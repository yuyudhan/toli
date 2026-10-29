# yuyudhan-mate

Mate is a personal orchestrator for omp (Oh My Pi). Malik talks to one omp session started
in this repo; mate turns each request into work for omp `task` subagents (the "crew"), checks their evidence, commits
the result, and reports back in plain words. Mate itself never edits project code.

The repo is cloned on three machines. Rules, skills, slash commands, and the CLI are tracked in git; everything
private (projects, backlog, notes, config, logs) is gitignored and stays on each machine.

    cd ~/code/yuyudhan-mate && omp

## What mate does for you (in simple words)

Think of mate as your personal assistant manager. You talk only to mate; mate hires helpers (omp subagents) to do
the actual work, checks their work, and tells you the result.

1. **One place to talk.** Start `omp` in this folder and just say what you want: "fix the login bug in dhruv",
   "find why the build is slow in varta". Mate answers you as "Malik" and replies "Ji Malik".
2. **Many projects.** All your projects live in `projects/`. Mate figures out which project you mean, and asks once
   if it is not sure.
3. **Helpers do the work, fast.** Mate gives each job a clear written task and hands it to omp subagents. Several
   helpers can work at the same time, even on the same project. Nothing is locked or queued behind each other.
4. **Two kinds of jobs.** "Ship" jobs change code. "Scout" jobs only investigate and write a report in
   `data/reports/`, without touching code.
5. **Proof before done.** A helper must actually run the project's tests or a quick check and show the output.
   Mate checks that proof before it calls the work finished.
6. **Safe by default.** Mate commits on the branch you are already on, and stops there. It never pushes, merges,
   or opens a pull request unless you say so. It never throws away your unsaved work. Branches are created only
   when you ask.
7. **Careful review when you want it.** Ask for a branch or PR and mate can run your `no-mistakes` pipeline
   (review, tests, docs, lint) with omp, and brings any question from it back to you word for word.
8. **Three machines, one team.** The same mate runs on all your machines. Mate checks which machine is free
   (CPU, memory, disk, how busy it is) and sends heavy work there. A machine that is asleep or busy is skipped.
9. **Timed jobs.** Say "every day at 5 pm, check X" and mate runs it on time: inside your open omp session if
   one is running, otherwise in the background. Results from other machines come back to your main machine.
10. **Picture pages for decisions.** When there are several options, mate opens a lavish page in your browser so
    you can tick choices instead of typing.
11. **Memory.** Mate keeps notes per project, your preferences, and lessons learned in `data/`, and uses them in
    every new task.

Everyday commands you type inside omp:

| Command | What it does |
|---|---|
| `/bearings` | "Where did I leave off?" - status of all projects, work in progress, waiting decisions |
| `/ahoy` | Walk through decisions that are waiting for you |
| `/schedule` | Add, list, pause, or remove timed jobs ("every day at 5 pm ...") |
| `/add-project`, `/drop-project` | Add or remove a project |
| `/stow` | Save what was learned this session |
| `/afk` | "I'm away" - keep working through queued tasks and give one summary when you are back |
| `/sync-mate` | Pull the latest mate rules onto this machine (or all machines) |

## First-time setup (each machine)

Requirements: [bun](https://bun.sh), omp, git, `gh` (logged in), and optionally `no-mistakes`.

    git clone https://github.com/yuyudhan/yuyudhan-mate.git ~/code/yuyudhan-mate
    cd ~/code/yuyudhan-mate
    bun install

    # the coordinator (one machine):
    bin/mate init --name <machine> --role coordinator

    # each worker:
    bin/mate init --name <machine> --role worker --coordinator-ssh <host> --coordinator-root <path>

    bin/mate doctor              # checks bun, omp, git, gh auth, no-mistakes, config, clones, fleet, scheduler
    bin/mate schedule install    # runs `bin/mate job tick` every minute (launchd on macOS, crontab on Linux)

List every machine in `config/fleet.json` (on each machine that should see or dispatch to the others):

    {
        "machines": [
            {"name": "<machine>", "ssh": "<host>", "root": "/Users/<you>/code/yuyudhan-mate"}
        ]
    }

Optional per-machine capacity thresholds go in `config/machine.json` (defaults shown; `maxRuns` defaults to
`max(1, floor(cpus / 4))`):

    "capacity": {"maxRuns": 2, "maxLoadPerCpu": 0.8, "minMemAvailableMB": 2048, "minDiskFreeGB": 5}

Note: `~/.omp/agent` is a symlink into the `yuyudhan-dotfiles` project clone. If that clone moves (for example into
`projects/yuyudhan-dotfiles` during the migration below), re-point the symlink, or omp loses its global config and
skills.

## Coordinator and workers

- **Coordinator**: the mate Malik talks to day to day. Sees the whole fleet (`bin/mate digest --fleet`), syncs every
  machine (`bin/mate sync --all`), and receives worker results in its inbox.
- **Worker**: has some projects cloned and runs their work and scheduled jobs. Every job result is also sent to the
  coordinator's inbox; if the coordinator is unreachable, results wait in `state/outbox/` and retry every minute.

Each machine's `data/projects.json` lists only the clones on that machine; a project may be cloned on several.
Mate uses the machines that are free:

    bin/mate resources [--json]               # this machine: load, free memory/disk, active runs, clones, available?
    bin/mate fleet status [--json]            # every machine, probed over ssh in parallel; unreachable is not fatal
    bin/mate pick [--project <p>] [--json]    # best machine for one unit of work; exit 2 with reasons when none
    bin/mate remote auto "<prompt>" --project <p>
    bin/mate remote <machine> "<prompt>" [--project <p>]

`pick` scores each available machine by min(cpu headroom, memory headroom) minus its share of busy run slots; within
0.1 of the best it prefers this machine, then one that already has the clone, then name order. `remote auto` prints
`local` when this machine wins (mate then dispatches crew here); otherwise it runs `bin/mate project ensure` on the
target when the project's URL is known here, then pipes the prompt to `bin/mate exec` there. `exec` and headless job
runs leave a record in `state/runs/` while they run, which is what `activeRuns` counts. Nothing is ever locked or
refused because a machine is busy; availability only steers where work goes.

## Adding projects

In the omp session: `/add-project <name> <git-url>`, or directly:

    bin/mate project add <name> <git-url> [--mode commit|pr|no-mistakes]

This clones into `projects/<name>`, records it, and reports whether the clone is ready for no-mistakes. Mate then
writes a short notes file (`data/notes/<name>.md`: stack, commands, gotchas) that is fed into every crew brief.

About 100 existing clones will be migrated from `~/code/firstmate/projects/` into `projects/` and registered with
`bin/mate project import`.

Other project commands: `bin/mate project list`, `bin/mate project path <name>`,
`bin/mate project set <name> --mode <m>`, `bin/mate project ensure <name> <git-url>` (idempotent: clone and/or
register as needed), `bin/mate project drop <name> [--delete-clone]` (refuses when the clone is dirty or has unpushed
commits).

## Slash commands

| Command | What it does |
|---|---|
| `/bearings [lavish]` | Status overview: work in flight, questions waiting, job results, inbox |
| `/ahoy` | Go through every task waiting on a decision |
| `/stow` | Save session learnings and preferences; tidy the backlog |
| `/afk [off]` | Keep working the queue while away; one report on return |
| `/add-project`, `/drop-project` | Register or remove a project |
| `/schedule add\|list\|pause\|resume\|remove` | Recurring jobs |
| `/sync-mate [--all]` | Update the mate repo (fast-forward only) |

## Periodic jobs

Say it in plain words; mate converts it to cron and confirms:

    /schedule add every day at 5 pm, summarise yesterday's commits in billing-api

becomes

    bin/mate job add billing-daily-summary --cron "0 17 * * *" --prompt "Summarise yesterday's commits..." --project billing-api --shape scout

While the omp session is open, the mate extension checks every minute and runs due jobs inside the session. When no
session is open, the OS ticker runs them headless (`omp -p`) and saves output to `data/jobs/<name>/<stamp>.md`.
Results appear in `/bearings` until acknowledged (`bin/mate job ack`). Scheduled runs never push, merge, open PRs, or
ask questions.

## no-mistakes and lavish

- **no-mistakes** is used only when Malik asks for a branch or PR on a piece of work. Mate creates the branch
  (`bin/mate branch`), commits, and drives the gate with a full intent in Malik's words. The gate runs omp as its agent
  (`~/.no-mistakes/config.yaml`: `agent: acp:omp`, `omp: omp acp`); never set `disable_project_settings`. Mechanics:
  the global `no-mistakes` skill; mate policy: `.omp/skills/mate-nm`.
- **lavish** (`npx -y lavish-axi`) renders review pages for multi-option decisions, batches of questions, and large
  reports. Yes/no questions stay in chat. Pages live in `.lavish/`; `lavish-axi share` is never used. Mechanics: the
  global `lavish` skill; mate policy: `.omp/skills/mate-lavish`.

## Hard rules

- No git worktrees and no tmux/herdr/zellij windows. Crew are omp `task` subagents editing `projects/<name>/` directly.
- Default delivery is a commit on the current branch (`bin/mate commit`). Branches only on request.
- Never push, merge, or open a PR without Malik's explicit word for that specific change.
- Never discard uncommitted work: no `git reset --hard`, `git checkout -- .`, `git stash`, `git clean`, branch
  deletion, or force push.
- Destructive, irreversible, or security-sensitive actions go to Malik first.
- No AI co-author trailers (`bin/mate commit` strips them). Malik's name appears in chat only, never in commits, PRs,
  or code.
- Parallel crew on the same project is allowed, even in the same files; each commits only the paths it changed.
- Scheduled and headless runs never push, merge, open PRs, or ask questions; they write results to files.

## Developing mate

Run `bun run hooks` (or `just hooks`) once per clone to point git at `.githooks/`:

- **pre-commit**: gitleaks over the staged changes, Biome formats staged `.ts`/`.json` files and re-stages them (so
  unstaged hunks in a staged file get committed too; `git stash push --keep-index` first for a partial commit), then
  the guards over the staged files.
- **commit-msg**: subject of at most 72 characters with no trailing period, a blank line before the body, and no AI
  co-author or Generated-by trailers.
- **pre-push**: gitleaks over the pushed commits, then `bun run check`.

Day to day: `bun run check` (tsc, Biome, guards, tests), `bun run format`, `bun run guard`; `just` lists the same
recipes. CI runs lint, `bun test --coverage` (threshold in `bunfig.toml`), and gitleaks on every push and PR.

## File layout

Tracked (shared by all machines):

    bin/mate                     CLI entry point (Bun TypeScript)
    src/                         CLI implementation
    AGENTS.md                    mate's role and rules for omp
    .omp/extensions/mate.ts      in-session job runner and session tracking
    .omp/skills/mate-*/          mate skills (dispatch, projects, deliver, scout, ...)
    .omp/commands/*.md           slash commands
    docs/brief-template.md       template for every crew brief
    tests/                       bun tests (temp MATE_ROOT, stubbed ssh/omp/crontab)
    scripts/guard.ts, guard/     hygiene guards; file-size-exceptions.txt ratchets oversized files
    .githooks/                   pre-commit, commit-msg, pre-push
    .github/workflows/ci.yml     CI: lint, tests with coverage, gitleaks
    biome.json, .gitleaks.toml   formatter/linter and secrets-scan config

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
    data/inbox/, data/remote/, data/afk/
    state/                       session.json, jobs.json, afk flag, outbox/, runs/
    logs/, .env*, .lavish/
