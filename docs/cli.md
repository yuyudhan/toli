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
- `doctor`: check tools, harnesses, forge auth, config, clones (and the git hooks each declares but has not
  installed), fleet, scheduler, and memory budget.
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
  `projects/`. `add` and `ensure` also install the git hooks the repo declares where toli can tell how, and print the
  command for the rest ([projects.md](projects.md#git-hooks)).
- `set` records delivery, branch, forge, workspace strategy, and standing grants ([delivery.md](delivery.md),
  [projects.md](projects.md#workspace-strategy)). `--branch <b>` also switches a clean clone to `<b>`, or prints the
  `git -C <clone> switch <b>` command when it cannot ([delivery.md](delivery.md#delivery-modes)). `--live-stack yes`
  puts the project in live-stack mode ([projects.md](projects.md#live-stack-mode)).
- `drop` keeps the clone and data unless asked; it refuses a dirty clone or unpushed commits.
- `setup` is the per-project checklist ([projects.md](projects.md#setting-up-an-existing-project)); for one named
  project it first installs the repo's declared git hooks like `ensure` does.

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
    delegation receive|update|link [--from <machine>] (JSON on stdin)
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
which serves wakes in headless turns when no lead session is open ([sardars.md](sardars.md)); with `lead.dispatch:
"subagents"` (`config/machine.json`, default `"spawn"`) those turns start no jawan and leave that work unread for
the interactive Sardar's subagents.

### Landing work

    commit <project> [--task T<n>] -m "<message>"... [--merge <ref> [--resolved]] [--patch <file>]... [--allow-revert <sha>]... [-- <path>...]
    branch <project> <branch>
    workspace prepare T<n> [--json] | list [--project <p>] [--json] | prune [--project <p>] [--json]
    forge <project> [--json]
    push <project> [--task T<n>] [--gate "<recipe>"] [--by <machine>] [--for T<n>] [--word "<owner's word>"] [--no-hooks-ok]
    gate run <project> [--task T<n>] --recipe "<shell command>" [--stall <minutes>] [--json]
    gate check <project> [--task T<n>] [--sha <commit>] --recipe "<shell command>" [--json] | status <project> [--json]
    push-log add <project> [--branch <b>] [--old <sha>] [--new <sha>] [--by <machine>] [--for T<n>] [--word "..."]
    push-log list [--json]
    pr create <project> --title <t> (--body <b> | --body-file <f>) [--base <b>] [--draft] [--task T<n>]
    pr status <project> [<id>] [--task T<n>] [--json] | list <project> [--json]
    pr merge <project> <id> [--method merge|squash|rebase]

- `commit` builds a private index from the branch tip and commits only the named paths and `--patch` hunks (`--patch`
  repeats; the files apply in the order given, and one that does not apply is named and commits nothing); it
  refuses secrets (gitleaks), lock files that do not parse, a revert of one of the last 20 commits, the wrong branch,
  a branch that moved twice meanwhile, and a message the project's `commit-msg` hook rejects, and strips AI trailers.
  `toli` as the project commits toli itself on `develop`
  ([development.md](development.md#working-on-toli-itself-in-place-landed-with-bintoli-commit)).
- `branch` creates a new branch in the clone and switches to it.
- `workspace` prepares, lists, and prunes per-task branches and worktrees
  ([projects.md](projects.md#workspace-strategy)).
- `forge`, `push`, `pr`: GitHub, GitLab, and Bitbucket Cloud; never forced, and only on your word or a standing
  grant ([delivery.md](delivery.md#forges-push-and-pull-requests)). Bitbucket calls authenticate with
  `BITBUCKET_EMAIL` (the Atlassian account email) and `BITBUCKET_API_TOKEN`; an HTTP 401 says what to set.
- `push` logs each push that moved origin's branch in this machine's `data/pushes.jsonl` (old..new sha, the issuing
  machine and task, the owner's quoted word; inside `exec`, the issuing machine and task by default), and `digest`
  shows the last week's. `push-log add` records a raw `git push` made here from `origin/<branch>`'s reflog. `push`
  refuses when the repo declares a pre-push hook git would not run (`--no-hooks-ok` pushes anyway) and warns about
  any other declared hook that is not installed ([projects.md](projects.md#git-hooks)).
- `gate run` runs a long verification command (a gate, such as `just verify all`) once per tree and recipe: a gate
  that already passed on HEAD's tree (at any commit with the same files) is skipped, a running one is waited on instead
  of started twice, and a new one runs in the background so it survives its caller, in one heavy-build slot at one
  slot's share of the cores. It never times out; only a gate with no new output, checkout change or CPU use for
  `--stall` minutes (`capacity.gateStallMinutes`, default 30) is stopped. `gate check` exits 0 only when this machine's
  gate runner recorded a sealed pass of the recipe on the tree (HEAD's, which must be exactly the checkout, or
  `--sha`'s commit), for pre-push hooks; a record edited or copied by hand is refused. `gate status` lists a project's
  gates, newest first. `push --gate "<recipe>"` runs the gate first and pushes only once it passed; a push whose
  project has a pre-push hook runs in one heavy-build slot ([delivery.md](delivery.md#gates-long-checks-run-once-per-tree)).

### Jawans and harnesses

    spawn --brief <file> [--harness omp|claude|codex|cursor|grok|pi] [--task T<n>] [--project <p>] [--model <m>]
          [--tier light|standard|deep] [--work scout|mechanical|ship|verify|release] [--cwd <dir>] [--max-time <minutes>]
          [--now] [--replace] [--dry-run] [--json]
    runs [--json] [--active] | run status <id> [--json] | run log <id> [--lines <n>] | run kill <id>
    resume <run> [--note "<text>"] [--max-time <minutes>] [--now] [--json]
    harness sync [--check] [--json] | status [--json]
    hook claude-pre-tool|claude-prompt|claude-session-start (hook JSON on stdin) | lead-build-env
    guidance
    session start|end --pid <n>

- `spawn` starts a jawan in the background on any harness and returns a run id; `runs` and `run` follow it. With
  every jawan slot busy (`capacity.maxRuns`, shared with the lead's native subagents) the run is queued and starts
  when one frees; `--now` starts it anyway.
  A task with a live run refuses a second `spawn --task`; `--replace` stops the live run and starts the new one.
  Runs have no time limit unless given `--max-time`; a run that shows no progress for `capacity.stallMinutes`
  (default 30), or uses its explicit limit, without a report is resumed in the same omp session
  (`capacity.autoResume`, default 3). `resume` lets the lead continue any finished run's session. Under
  `lead.dispatch: "subagents"`, `spawn`, `resume` and queued-run starts refuse in a headless lead turn.
- `harness sync` links skills and commands into every harness; `harness status` shows installed CLIs and logins.
- `hook`, `guidance`, `session`: called by the harness integrations (Claude Code hooks, the omp extension), not by
  hand. `guidance` prints the lead reminder they inject; `session` registers the live lead session.

Details: [harnesses.md](harnesses.md).

### Scheduled jobs and results

    job add <name> --cron "<m h dom mon dow>" --prompt "<text>" [--project <p>] [--machine <m>] [--shape scout|ship] [--tier light|standard|deep]
    job list [--json] | pause|resume|remove <name> | due [--json] | run <name> | run-due | tick
    job begin <name> --via session|headless [--json] | finish <name> <runId> [--status ok|failed] (result on stdin)
    job results [--unseen] [--json] | ack [--through <stamp>]
    schedule install|uninstall|status
    inbox add --from <machine> --title "<t>" [--via "<how it arrived>"] (body on stdin) | list [--json] [--unseen] | ack [--through <stamp>]
    outbox pull [--json] | pending --for <machine> (its fleet export on stdin) | ack --for <machine> (JSON on stdin)
    outbox list [--to <machine>] [--cancelled] [--json] | cancel <id>|--to <machine> [--why "..."] | expire --older <N>d
    wake [--json]

- `job due` lists due jobs; `run-due` runs them (the live session); `tick` is the per-minute OS ticker; `begin` and
  `finish` claim a run and record its result.
- `schedule` installs the ticker (launchd on macOS; a systemd user timer on Linux when `systemctl --user` works,
  else crontab).
- `inbox` holds messages from jawans and other machines; `wake` takes everything new once, for the chat.
- `outbox pull` is what the minute tick runs on a machine that takes no inbound ssh (`inbound: false`): it fetches
  what every other machine queued for it (`outbox pending` there), applies it here and acknowledges it (`outbox ack`
  there), so each item is applied once ([fleet.md](fleet.md#machines-that-take-no-inbound-ssh)). Run by hand, it also
  tries the machines the tick backs off ([fleet.md](fleet.md#unreachable-machines)).
- `outbox list` shows what waits to be sent (to whom, kind, age; `--cancelled` what was given up and why); `outbox
cancel` and `outbox expire` move items to `state/outbox/cancelled/` with an inbox note. Nothing is dropped
  silently, and nothing expires by itself ([peers.md](peers.md#the-queue)).

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

### Peers (HTTP messaging)

    peer init | status [--json] | list [--json] | apply (envelopes on stdin)
    peer serve | listen on|off | set [--port <n>] [--bind private|<ip,...>] [--interfaces <name,...>|none]
      [--ssh-fallback on|off]
    peer add <host[:port]> [--code NNNN] [--by owner|sardar] [--why "..."] | requests [--json]
    peer accept <request> [--by owner|sardar] [--why "..."] | decline <request> [--why "..."]
    peer allow|deny <peer> <talk|delegate|share|answer|status> [--why "..."] | remove <peer> [--why "..."]
    peer flush <peer>|--all [--json] | pull [--json] | stats [--peer <p>] [--json] | ask <peer> status [--json] | rotate
    peer scan [--netbird] [--tailscale] [--subnet <cidr>] [--port <n>] [--json]

- `peer init` makes this installation's identity (an Ed25519 key and a TLS certificate in `config/peer/`); `upgrade`
  and the listener run it too. `peer status` shows the fingerprint to compare when pairing; `peer list` the paired
  peers with their permissions and addresses.
- `peer apply` is the ssh transport's receiver: signed envelopes on stdin, one receipt each on stdout, with the same
  checks as over HTTPS ([peers.md](peers.md#the-envelope)).
- `peer serve` runs the HTTPS listener in the foreground; the lead service starts it by itself while `peer.listen`
  is on (the default). `peer listen off` stops it and keeps it off (this machine then pulls from its peers); `peer
set` changes the port (47123), the bind (`private`, the default, or a list of addresses) and whether a paired peer
  may still get messages over ssh when HTTPS fails ([peers.md](peers.md#the-listener)).
- `peer add <host>` asks that machine to pair; there `peer accept <request>` prints the code on its own line,
  `Pairing code: NNNN (tell this to <name>'s requester)` (2 minutes, one use, 3 tries), and the fingerprint apart in
  colon-joined groups of eight; its owner or Sardar relays only the `Pairing code:` digits, and
  `peer add <host> --code NNNN` finishes. Pairing
  grants every permission; `peer deny|allow` revokes or restores one, `peer remove` revokes the peer. The Sardar runs
  these only with `--why`, and every one is logged with who and why ([peers.md](peers.md#pairing)).
- `peer flush` sends what waits for a peer now (the tick does it every minute), `peer pull` takes what peers hold
  for this machine when its listener is off, `peer stats` compares how long HTTPS and ssh deliveries took,
  `peer ask <peer> status` asks a peer what `resources` and its task list say there, and `peer rotate` replaces this
  machine's key and certificate ([peers.md](peers.md#delivery)).
- `peer scan` lists the toli listeners that answer on NetBird's and Tailscale's peers and an optional private
  `--subnet` (at most a /22); it never pairs ([peers.md](peers.md#finding-peers)).

Details: [peers.md](peers.md).

### Working on toli itself

    self sync [--json] | status [--json]

- Changes to toli are made in place, in this checkout on `develop`, and land with `bin/toli commit toli` after
  `just check` ([development.md](development.md)); there are no worktrees.
- `self sync` installs the checkout's HEAD as the runtime the live session runs (a snapshot under `~/.toli/runtime/`,
  named by `state/runtime`), only after the snapshot loads; `commit toli`, `sync` and `upgrade` do it themselves when
  a runtime is installed, except `commit toli --merge`: run `just check` on the merge, then `self sync`.
  `self status` says which code `bin/toli` runs ([development.md](development.md#the-live-session-runs-an-installed-runtime)).
