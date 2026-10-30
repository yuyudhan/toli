# Command reference

Two kinds of commands: **slash commands** you type in the lead's chat, and the **`bin/toli` CLI** the lead and
jawans use for bookkeeping. You rarely need the CLI yourself; saying what you want in plain words is enough.

## Slash commands

| Command                                      | What it does                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `/setup`                                     | Finish first-run setup ("set up toli" works too) ([setup.md](setup.md))                 |
| `/bearings [lavish]`                         | Status overview: work in flight, questions waiting, job results, inbox                  |
| `/ahoy`                                      | Go through every task waiting on a decision                                             |
| `/add-project`, `/drop-project`              | Register (clone or link) or remove a project ([projects.md](projects.md))               |
| `/setup-project <name>\|--all`               | Review a project's setup and fill what is missing                                       |
| `/schedule add\|list\|pause\|resume\|remove` | Recurring jobs in plain words ([jobs.md](jobs.md))                                      |
| `/stow`                                      | Save what was learned; re-check stale memory; tidy the backlog ([memory.md](memory.md)) |
| `/afk [off]`                                 | You are away: keep working the queue, one report on return                              |
| `/quiet [off]`                               | You are here: only outcomes, failures, and decisions                                    |
| `/sync-toli [--all]`                         | Update toli on this machine, or every machine ([fleet.md](fleet.md))                    |

They exist in every harness that supports project commands; `bin/toli harness sync` links them
([harnesses.md](harnesses.md)).

## `bin/toli`

`bin/toli --help` prints the synopsis; every line of it is below, grouped by topic. Most commands take `--json` for
machine-readable output. Exit code 0 is success, 1 a failure with the reason on stderr, 2 an unknown command or, for
`pick`, no machine available.

### Setup and status

    init --name <machine> --role coordinator|worker [--coordinator-ssh <host> --coordinator-root <path>]
    setup status [--json] | notice [--json] | snooze | seed-local
    doctor [--json]
    digest [--json] [--fleet]
    version [--json]
    upgrade [vX.Y.Z|--latest] [--check]
    update check [--due] [--json] | status [--json] | snooze <vX.Y.Z> | off | on

- `init`: write this machine's `config/machine.json` and seed `local/`; re-running keeps the other settings.
- `setup`: the first-run checklist, the told-once notice, snoozing it, and seeding `local/` ([setup.md](setup.md)).
- `doctor`: check tools, harnesses, forge auth, config, clones, fleet, scheduler, and memory budget.
- `digest`: the session-start summary; `--fleet` adds every machine.
- `version`, `upgrade`: the installed release and moving to another one ([install.md](install.md)).
- `update`: the 3-day check for a new release, snoozing a version, switching the check off
  ([install.md](install.md#update-check)).

### Projects

    project add <name> <git-url> [--mode commit|pr|no-mistakes]
    project ensure <name> <git-url> [--mode commit|pr|no-mistakes]
    project link <name> <path> [--mode commit|pr|no-mistakes]
    project list [--json] | path <name>
    project set <name> [--mode <m>] [--branch <b>|none] [--forge github|gitlab|bitbucket|none] [--forge-host <h>|none]
                [--workspace same-branch|branch-per-task|worktree-per-task] [--standing-push yes|no] [--standing-pr yes|no]
    project set --all --workspace <strategy>
    project drop <name> [--delete-clone] [--delete-data] | import [--dir projects]
    project setup <name> [--json] | setup --all [--json]

- `add` clones into `projects/<name>`; `link` registers an existing checkout through a symlink; `ensure` is the
  idempotent form used for remote work; `import` registers clones already in `projects/`.
- `set` records delivery, branch, forge, workspace strategy, and standing grants ([delivery.md](delivery.md),
  [projects.md](projects.md#workspace-strategy)). `--branch <b>` also switches a clean clone to `<b>`, or prints the
  `git -C <clone> switch <b>` command when it cannot ([delivery.md](delivery.md#delivery-modes)).
- `drop` keeps the clone and data unless asked; it refuses a dirty clone or unpushed commits.
- `setup` is the per-project checklist ([projects.md](projects.md#setting-up-an-existing-project)).

### Tasks

    task add <project> "<title>" [--shape ship|scout] [--note "..."]
    task list [--json] [--status queued|active|held|done|dropped]
    task start <id> [--agent <id>] | done <id> [--report <path>] [--commit <sha>] [--note "..."]
    task hold <id> --question "..." [--option "<choice> => <what happens then>"]... [--recommend <n|choice>] [--blocks "..."]
    task answer <id> "<answer>" | drop <id>
    needs [--json]

Every request becomes a task (`data/backlog.json`). `start` records which jawan carries it; `hold` parks it on a
question for you, with 2-4 options (each with what happens next), a recommendation, and what it blocks; `answer`
records your reply verbatim in the project's `decisions.md` and prints `unblocked: dispatch T<n>`
([how-it-works.md](how-it-works.md#a-request-start-to-finish)). `needs` is the Needs-you queue: every held task,
grouped by project, blocking and oldest first, with a one-line reply hint each; the digest opens with the same list,
flags holds with no question, and re-surfaces a hold unanswered for `needs.staleDays` days (`config/machine.json`,
default 7) once.

### Landing work

    commit <project> [--task T<n>] -m "<message>" -- <path>...
    branch <project> <branch>
    workspace prepare T<n> [--json] | list [--project <p>] [--json] | prune [--project <p>] [--force] [--json]
    forge <project> [--json]
    push <project> [--task T<n>]
    pr create <project> --title <t> (--body <b> | --body-file <f>) [--base <b>] [--draft] [--task T<n>]
    pr status <project> [<id>] [--task T<n>] [--json] | list <project> [--json]
    pr merge <project> <id> [--method merge|squash|rebase]

- `commit` stages only the named paths, strips AI trailers, and refuses on the wrong branch.
- `branch` creates a new branch in the clone and switches to it.
- `workspace` prepares, lists, and prunes per-task branches and worktrees
  ([projects.md](projects.md#workspace-strategy)).
- `forge`, `push`, `pr`: GitHub, GitLab, and Bitbucket Cloud; never forced, and only on your word or a standing
  grant ([delivery.md](delivery.md#forges-push-and-pull-requests)).

### Jawans and harnesses

    spawn --brief <file> [--harness omp|claude|codex|cursor|grok|pi] [--task T<n>] [--project <p>] [--model <m>]
          [--work scout|ship|verify] [--cwd <dir>] [--max-time <minutes>] [--json]
    runs [--json] [--active] | run status <id> [--json] | run log <id> [--lines <n>] | run kill <id>
    harness sync [--check] [--json] | status [--json]
    hook claude-pre-tool|claude-prompt|claude-session-start (hook JSON on stdin)
    guidance
    session start|end --pid <n>

- `spawn` starts a jawan in the background on any harness and returns a run id; `runs` and `run` follow it.
- `harness sync` links skills and commands into every harness; `harness status` shows installed CLIs and logins.
- `hook`, `guidance`, `session`: called by the harness integrations (Claude Code hooks, the omp extension), not by
  hand. `guidance` prints the lead reminder they inject; `session` registers the live lead session.

Details: [harnesses.md](harnesses.md).

### Scheduled jobs and results

    job add <name> --cron "<m h dom mon dow>" --prompt "<text>" [--project <p>] [--machine <m>] [--shape scout|ship]
    job list [--json] | pause|resume|remove <name> | due [--json] | run <name> | run-due | tick
    job begin <name> --via session|headless [--json] | finish <name> <runId> [--status ok|failed] (result on stdin)
    job results [--unseen] [--json] | ack
    schedule install|uninstall|status
    inbox add --from <machine> --title "<t>" (body on stdin) | list [--json] [--unseen] | ack
    wake [--json]

- `job due` lists due jobs; `run-due` runs them (the live session); `tick` is the per-minute OS ticker; `begin` and
  `finish` claim a run and record its result.
- `schedule` installs the ticker (launchd on macOS, crontab elsewhere).
- `inbox` holds messages from jawans and other machines; `wake` takes everything new once, for the chat.

Details: [jobs.md](jobs.md).

### Machine helpers

    helper list [--json] | install <name>|--all | uninstall <name>|--all | run <name> | status [<name>] [--json]

Private per-machine scripts on launchd, systemd, or crontab ([helpers.md](helpers.md)).

### Memory and cleanup

    memory [--json] | stale [--json] | archive <file> <line-or-id> --reason "<text>" [--force]
    prune [--apply] [--json]
    migrate [--dry-run] [--json]

Budget, ageing, and retention rules: [memory.md](memory.md). `migrate` moves data from older layouts
([projects.md](projects.md#moving-data-from-the-old-layout)).

### Machines

    sync [--all]
    resources [--json]
    fleet status [--json]
    pick [--project <name>] [--json]
    exec [--from <machine>] [--task <id>] (prompt on stdin)
    remote <machine|auto> "<prompt>" [--project <name>]

- `sync`: `git pull --ff-only` here, or on every machine with `--all`.
- `resources`, `fleet status`, `pick`: capacity of this machine, of all machines, and the best one for a task.
- `remote` runs a prompt on another machine; `exec` is what it runs there (headless omp, up to an hour).

Details: [fleet.md](fleet.md).

### Working on toli itself

    self prepare T<n> [--json] | list [--json] | land T<n> [--json]

Changes to toli are made in a worktree (`projects/.worktrees/toli/T<n>`, from `develop`), never in the live checkout;
`land` runs `just check` there and fast-forwards `develop` (or, without a local `develop`, the live checkout's branch)
only when it passes ([development.md](development.md)).
