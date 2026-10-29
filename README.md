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

1. **One place to talk.** Start `omp` in this folder and just say what you want: "fix the login bug in billing-api",
   "find why the build is slow in web-app". Mate answers you as "Malik" and replies "Ji Malik".
2. **Many projects.** All your projects live in `projects/`. Mate figures out which project you mean, and asks once
   if it is not sure.
3. **Helpers do the work, fast.** Mate gives each job a clear written task and hands it to omp subagents. Several
   helpers can work at the same time, even on the same project. Nothing is locked or queued behind each other.
4. **Two kinds of jobs.** "Ship" jobs change code. "Scout" jobs only investigate and write a report in
   `data/reports/`, without touching code.
5. **Proof before done.** A helper must actually run the project's tests or a quick check and show the output.
   When your notes for a project list its URLs, the helper also checks the logs and opens the local page in a
   headless browser; UI changes come with before/after screenshots at your chosen widths, and bug fixes show the
   test failing first and passing after. Staging is only looked at, never changed, and helpers stop at any OTP.
   Mate checks that proof before it calls the work finished.
6. **Safe by default.** Mate commits on the branch you are already on (or the project's fixed branch, if you set
   one), and stops there. It never pushes, merges, releases, or opens a pull request unless you say so. It never
   throws away your unsaved work. Branches are created only when you ask.
7. **Careful review when you want it.** Ask for a branch or PR and mate can run your `no-mistakes` pipeline
   (review, tests, docs, lint) with omp. Mate settles review questions that clearly follow what you already agreed
   and brings you only the ones that widen scope, are unclear, destructive, or touch security.
8. **Three machines, one team.** The same mate runs on all your machines. Mate checks which machine is free
   (CPU, memory, disk, how busy it is) and sends heavy work there. A machine that is asleep or busy is skipped.
9. **Timed jobs.** Say "every day at 5 pm, check X" and mate runs it on time: inside your open omp session if
   one is running, otherwise in the background. Results from other machines come back to your main machine.
10. **Picture pages for decisions.** When there are several options, mate opens a lavish page in your browser so
    you can tick choices instead of typing.
11. **Memory.** Mate keeps notes per project, your preferences, and lessons learned in `data/`, and uses them in
    every new task.
12. **Local stacks.** If a project's notes list how to start, stop, migrate, and read logs of its local stack, mate
    runs exactly those commands itself. Nothing else.
13. **Quiet or away.** `/quiet` keeps mate to results, failures, and decisions while you are here; `/afk` lets it
    work the queue while you are gone. After half an hour without a message from you, mate's next reply starts with
    what needs you, what finished, and what is still running.

Everyday commands you type inside omp:

| Command | What it does |
|---|---|
| `/bearings` | "Where did I leave off?" - status of all projects, work in progress, waiting decisions |
| `/ahoy` | Walk through decisions that are waiting for you |
| `/schedule` | Add, list, pause, or remove timed jobs ("every day at 5 pm ...") |
| `/add-project`, `/drop-project` | Add or remove a project |
| `/stow` | Save what was learned this session |
| `/afk` | "I'm away" - keep working through queued tasks and give one summary when you are back |
| `/quiet` | "I'm here, keep it short" - only results, failures, and decisions |
| `/sync-mate` | Pull the latest mate rules onto this machine (or all machines) |

## First-time setup (each machine)

Requirements: [bun](https://bun.sh), omp, git, `gh` (logged in), and optionally `no-mistakes`. For GitLab projects,
`glab` logged in to each GitLab host in use; for Bitbucket Cloud projects, `BITBUCKET_USERNAME` and
`BITBUCKET_API_TOKEN` (environment or the gitignored `.env` in this repo) or a bitbucket.org login in the git credential
helper.

    git clone https://github.com/yuyudhan/yuyudhan-mate.git ~/code/yuyudhan-mate
    cd ~/code/yuyudhan-mate
    bun install

    # the coordinator (one machine):
    bin/mate init --name <machine> --role coordinator

    # each worker:
    bin/mate init --name <machine> --role worker --coordinator-ssh <host> --coordinator-root <path>

    bin/mate doctor              # checks bun, omp, git, forge auth (gh/glab/bitbucket), no-mistakes, config, clones, fleet, scheduler
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
`bin/mate project set <name> [--mode <m>] [--branch <b>|none] [--forge github|gitlab|bitbucket|none]
[--forge-host <host>|none]`, `bin/mate project ensure <name> <git-url>` (idempotent: clone and/or register as needed),
`bin/mate project drop <name> [--delete-clone]` (refuses when the clone is dirty or has unpushed commits).

A project can have a fixed working branch (`--branch`): `bin/mate commit` then refuses to commit when the clone is on
any other branch, and `bin/mate digest` flags the mismatch. Mate switches or creates branches only on Malik's word.

## Forges, push and pull requests

GitHub (`gh`), GitLab (`glab`, gitlab.com or self-hosted) and Bitbucket Cloud (REST API) are detected from the clone's
`origin` URL. For an ssh endpoint such as `git@gitlab-ssh.<host>:group/repo.git`, the GitLab host comes from glab's
config (the host whose `ssh_host` matches); `project set --forge/--forge-host` override detection.

    bin/mate forge <project> [--json]                  # forge, host, repo path, CLI/credential readiness
    bin/mate push <project>                            # git push -u origin <current branch>; never forced
    bin/mate pr create <project> --title <t> (--body <b> | --body-file <f>) [--base <b>] [--draft]
    bin/mate pr status <project> [<id>] [--json]       # state, mergeable, CI/pipeline, URL (default: current branch)
    bin/mate pr list <project> [--json]
    bin/mate pr merge <project> <id> [--method merge|squash|rebase]

`push` refuses a detached HEAD. `pr create` refuses until the current branch is on origin and contains local HEAD,
then prints the PR/MR URL. Pushing, opening and merging all need Malik's word for that change.

## Slash commands

| Command | What it does |
|---|---|
| `/bearings [lavish]` | Status overview: work in flight, questions waiting, job results, inbox |
| `/ahoy` | Go through every task waiting on a decision |
| `/stow` | Save session learnings and preferences; tidy the backlog |
| `/afk [off]` | Keep working the queue while away; one report on return |
| `/quiet [off]` | Only outcomes, failures, and decisions while present |
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
