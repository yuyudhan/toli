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
`pick`, no machine reachable or qualifying.

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
                [--live-stack yes|no]
    project set --all --workspace <strategy>
    project drop <name> [--delete-clone] [--delete-data] | import [--dir projects]
    project setup <name> [--json] | setup --all [--json]

- `add` clones into `projects/<name>`; `link` registers an existing checkout through a symlink; `ensure` is the
  idempotent form a delegated task's jawan runs on a machine without the clone; `import` registers clones already in
  `projects/`.
- `set` records delivery, branch, forge, workspace strategy, and standing grants ([delivery.md](delivery.md),
  [projects.md](projects.md#workspace-strategy)). `--branch <b>` also switches a clean clone to `<b>`, or prints the
  `git -C <clone> switch <b>` command when it cannot ([delivery.md](delivery.md#delivery-modes)). `--live-stack yes`
  puts the project in live-stack mode ([projects.md](projects.md#live-stack-mode)).
- `drop` keeps the clone and data unless asked; it refuses a dirty clone or unpushed commits.
- `setup` is the per-project checklist ([projects.md](projects.md#setting-up-an-existing-project)).

### Tasks

    task add <project> "<title>" [--shape ship|scout] [--tier light|standard|deep] [--note "..."]
    task list [--json] [--status queued|active|held|done|dropped] [--project <p>] [--fleet [--cached]]
    task start <id> [--agent <id>] | done <id> [--report <path>] [--commit <sha>] [--note "..."]
    task wait <id> --on "<what it waits on>"
    task pin <id> [--reason "..."] | unpin <id>
    task hold <id> --question "..." [--option "<choice> => <what happens then>"]... [--recommend <n|choice>] [--blocks "..."] [--reversible]
    task answer <id|machine/T<n>> "<answer>" [--from <machine>] | drop <id>
    task link <id> <machine>/T<n> | escalate <machine>/T<n> | handback <id> --reason "..." [--full]
    delegate <machine> "<title>" --brief <file> [--project <p>] [--note "..."] [--for T<n>] [--shape ship|scout] [--tier <t>]
    delegation receive|update|link (JSON on stdin)
    talk <machine> ["<words>"]
    share "<learning>" [--to <machine>]... [--all] [--project <p>] [--source "..."] [--from-user] | share --list [--json]
    share answer <id> adopt|adapt|decline [--into learnings|preferences|notes] [--text "..."] [--note "..."]
    share receive (JSON on stdin)
    lead install|uninstall | status [--json] | run [--once] | attach | full [--reason "..."] [--until 30m|2h|<time>] | full --clear|--status
    needs [--json]

Every request becomes a task (`data/backlog.json`). `start` records which jawan carries it; `hold` parks it on a
question for you, with 2-4 options (each with what happens next), a recommendation, and what it blocks; `answer`
records your reply verbatim in the project's `decisions.md`, prints `unblocked: dispatch T<n>`, and names every task
waiting on it (those its hold's `--blocks` names, holds whose question names it, and the project's active tasks no
live run works on), each with its brief, and posts the same as one inbox item, so the lead re-dispatches them all in
the same turn ([how-it-works.md](how-it-works.md#a-request-start-to-finish)). An active task whose recorded run
ended `oversight.staleTaskMinutes` ago (default 15) heads the digest's Next block with the run's last report line
and any answer recorded since; the tick posts it to the inbox once ([fleet.md](fleet.md#oversight)). `needs` is the
Needs-you queue: every held task, grouped by project, blocking and oldest first, with a one-line reply hint each; the
digest opens with the same list, flags holds with no question, and re-surfaces a hold unanswered for
`needs.staleDays` days (`config/machine.json`, default 7) once. `hold --reversible` marks a hold whose recommended
option is safe to undo, so an installation may apply it when the hold stays unanswered past its own timeout
(recorded with `task answer`); it needs `--recommend` and is refused when the hold mentions push, merge, main,
MR/PR, tag, release, a destructive step, security or money.

Task ids are unique across the fleet as `<machine>/T<n>`; a bare `T<n>` is this machine's. `task list --fleet` shows
every machine's open tasks (refreshed over ssh, `--cached` reads the last copies). `task answer <machine>/T<n>` is
forwarded to the owning machine. `delegate` hands a task to another machine's lead (it lands in that machine's
backlog, and every change to it is written back onto the `--for` task here: notes, done with commit and report,
dropped; a question wakes this lead, who answers it or `task escalate`s it to the Needs-you queue); `task link`
attaches a delegation made without `--for`; `delegation receive|update|link` is what runs on the other side. `talk`
attaches to a machine's lead conversation, or sends it words. `share` sends a learning to other leads, who adopt,
adapt or decline it (the answer comes back; `share --list` shows them). `lead` manages this machine's lead service,
which serves wakes in headless turns when no lead session is open ([sardars.md](sardars.md)).

### Landing work

    commit <project> [--task T<n>] -m "<message>"... [--merge <ref> [--resolved]] [--patch <file>] [--allow-revert <sha>]... [-- <path>...]
    branch <project> <branch>
    workspace prepare T<n> [--json] | list [--project <p>] [--json] | prune [--project <p>] [--force] [--json]
    forge <project> [--json]
    push <project> [--task T<n>] [--gate "<recipe>"] [--by <machine>] [--for T<n>] [--word "<owner's word>"]
    gate run <project> [--task T<n>] --recipe "<shell command>" [--stall <minutes>] [--json]
    gate check <project> [--task T<n>] [--sha <commit>] --recipe "<shell command>" [--json] | status <project> [--json]
    push-log add <project> [--branch <b>] [--old <sha>] [--new <sha>] [--by <machine>] [--for T<n>] [--word "..."]
    push-log list [--json]
    pr create <project> --title <t> (--body <b> | --body-file <f>) [--base <b>] [--draft] [--task T<n>]
    pr status <project> [<id>] [--task T<n>] [--json] | list <project> [--json]
    pr merge <project> <id> [--method merge|squash|rebase]

- `commit` builds a private index from the branch tip and commits only the named paths and `--patch` hunks; it
  refuses secrets (gitleaks), lock files that do not parse, a revert of one of the last 20 commits, the wrong branch,
  a branch that moved twice meanwhile, and a message the project's `commit-msg` hook rejects, and strips AI trailers.
  `toli` as the project commits toli itself on `develop`
  ([development.md](development.md#working-on-toli-itself-in-place-landed-with-bintoli-commit)).
- `branch` creates a new branch in the clone and switches to it.
- `workspace` prepares, lists, and prunes per-task branches and worktrees
  ([projects.md](projects.md#workspace-strategy)).
- `forge`, `push`, `pr`: GitHub, GitLab, and Bitbucket Cloud; never forced, and only on your word or a standing
  grant ([delivery.md](delivery.md#forges-push-and-pull-requests)).
- `push` logs each push that moved origin's branch in this machine's `data/pushes.jsonl` (old..new sha, the issuing
  machine and task, the owner's quoted word; inside `exec`, the issuing machine and task by default), and `digest`
  shows the last week's. `push-log add` records a raw `git push` made here from `origin/<branch>`'s reflog.
- `gate run` runs a long verification command (a gate, such as `just verify all`) once per commit and recipe: a gate
  that already passed at HEAD is skipped, a running one is waited on instead of started twice, and a new one runs in
  the background so it survives its caller. It never times out; only a gate with no new output, checkout change or
  CPU use for `--stall` minutes (`capacity.gateStallMinutes`, default 30) is stopped. `gate check` exits 0 only when
  HEAD already passed the recipe (for pre-push hooks); `gate status` lists a project's gates, newest first.
  `push --gate "<recipe>"` runs the gate first and pushes only once it passed
  ([delivery.md](delivery.md#gates-long-checks-run-once-per-commit)).

### Jawans and harnesses

    spawn --brief <file> [--harness omp|claude|codex|cursor|grok|pi] [--task T<n>] [--project <p>] [--model <m>]
          [--tier light|standard|deep] [--work scout|mechanical|ship|verify|release] [--cwd <dir>] [--max-time <minutes>]
          [--now] [--replace] [--dry-run] [--json]
    runs [--json] [--active] | run status <id> [--json] | run log <id> [--lines <n>] | run kill <id>
    resume <run> [--note "<text>"] [--max-time <minutes>] [--now] [--json]
    harness sync [--check] [--json] | status [--json]
    hook claude-pre-tool|claude-prompt|claude-session-start (hook JSON on stdin)
    guidance
    session start|end --pid <n>

- `spawn` starts a jawan in the background on any harness and returns a run id; `runs` and `run` follow it. With
  every jawan slot busy (`capacity.maxRuns`) the run is queued and starts when one frees; `--now` starts it anyway.
  A task with a live run refuses a second `spawn --task`; `--replace` stops the live run and starts the new one.
  Runs have no time limit unless given `--max-time`; a run that shows no progress for `capacity.stallMinutes`
  (default 30), or uses its explicit limit, without a report is resumed in the same omp session
  (`capacity.autoResume`, default 3). `resume` lets the lead continue any finished run's session.
- `harness sync` links skills and commands into every harness; `harness status` shows installed CLIs and logins.
- `hook`, `guidance`, `session`: called by the harness integrations (Claude Code hooks, the omp extension), not by
  hand. `guidance` prints the lead reminder they inject; `session` registers the live lead session.

Details: [harnesses.md](harnesses.md).

### Scheduled jobs and results

    job add <name> --cron "<m h dom mon dow>" --prompt "<text>" [--project <p>] [--machine <m>] [--shape scout|ship] [--tier light|standard|deep]
    job list [--json] | pause|resume|remove <name> | due [--json] | run <name> | run-due | tick
    job begin <name> --via session|headless [--json] | finish <name> <runId> [--status ok|failed] (result on stdin)
    job results [--unseen] [--json] | ack
    schedule install|uninstall|status
    inbox add --from <machine> --title "<t>" (body on stdin) | list [--json] [--unseen] | ack
    outbox pull [--json] | pending --for <machine> (its fleet export on stdin) | ack --for <machine> (JSON on stdin)
    wake [--json]

- `job due` lists due jobs; `run-due` runs them (the live session); `tick` is the per-minute OS ticker; `begin` and
  `finish` claim a run and record its result.
- `schedule` installs the ticker (launchd on macOS; a systemd user timer on Linux when `systemctl --user` works,
  else crontab).
- `inbox` holds messages from jawans and other machines; `wake` takes everything new once, for the chat.
- `outbox pull` is what the minute tick runs on a machine that takes no inbound ssh (`inbound: false`): it fetches
  what every other machine queued for it (`outbox pending` there), applies it here and acknowledges it (`outbox ack`
  there), so each item is applied once ([fleet.md](fleet.md#machines-that-take-no-inbound-ssh)).

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
    build-slot -- <command...>
    disk keep [--dry-run] [--floor <GB>] [--json]
    disk alert
    fleet status [--json]
    fleet queues [--json]
    fleet export | sync
    fleet check [--json] [--wake] [--local]
    pick [--project <name>] [--json]
    exec [--task <id>] (prompt on stdin; runs here only)

- `sync`: `git pull --ff-only` here, or on every machine with `--all`.
- `resources`, `fleet status`: capacity and queue of this machine and of all machines. `fleet queues`, `pick`:
  machines ranked by queue depth, shortest first, and the one for a task
  ([fleet.md](fleet.md#capacity-and-picking-a-machine)).
- `fleet check`: idle machines (no active run) with queued work for a project cloned there, and active tasks no
  live run works on, on every reachable machine; `--wake` posts the findings as one inbox item; `--local` reports
  this machine's own backlog (what the coordinator reads over ssh). The coordinator's tick runs it every
  `oversight.fleetCheckMinutes` (default 60), away mode included ([fleet.md](fleet.md#oversight)).
- `build-slot -- <command...>`: run a heavy build in one of this machine's heavy-build slots (`capacity.buildSlots`),
  waiting while all are busy; jawans' cargo goes through it on its own ([fleet.md](fleet.md#heavy-build-slots)).
- `disk keep`: free rebuildable build output, oldest first, when the disk is under its floor (`capacity.diskKeepGB`,
  capped at 15% of the disk) and until it is back there; still under it after the normal steps, every `target/` goes,
  in use or not. It also runs before every jawan start, and every tick starts it detached (the tick never waits on
  it), so low disk never stops work; a live pid in
  `state/disk-keep.pause` pauses it for up to 2 hours after the file was last written ([disk.md](disk.md)). With
  `capacity.diskKeep: false` it runs only by hand: before jawan starts and in the tick toli deletes nothing and only
  alerts the inbox, once per 6 hours, when free disk is under 10 GB (or the emergency level).
- `disk alert`: post that low-disk alert now, naming the biggest build folders.
- `exec` runs a prompt in headless omp on this machine and refuses one from another machine; `remote` (any form)
  refuses and points to `pick` and `delegate` ([sardars.md](sardars.md)).

Details: [fleet.md](fleet.md).

### Working on toli itself

    self sync [--json] | status [--json]

- Changes to toli are made in place, in this checkout on `develop`, and land with `bin/toli commit toli` after
  `just check` ([development.md](development.md)); there are no worktrees.
- `self sync` installs the checkout's HEAD as the runtime the live session runs (a snapshot under `~/.toli/runtime/`,
  named by `state/runtime`), only after the snapshot loads; `commit toli`, `sync` and `upgrade` do it themselves when
  a runtime is installed, except `commit toli --merge`: run `just check` on the merge, then `self sync`.
  `self status` says which code `bin/toli` runs ([development.md](development.md#the-live-session-runs-an-installed-runtime)).
