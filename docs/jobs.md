# Scheduled jobs

Say it in plain words; the lead turns it into a cron schedule and confirms:

    /schedule add every day at 5 pm, summarise yesterday's commits in billing-api

becomes

    bin/toli job add billing-daily-summary --cron "0 17 * * *" --prompt "Summarise yesterday's commits..." --project billing-api --shape scout

`/schedule list|pause|resume|remove` manage them the same way.

## Defining a job

    bin/toli job add <name> --cron "<m h dom mon dow>" --prompt "<text>" [--project <p>] [--machine <m>] [--shape scout|ship] [--max-minutes <n>|none]

- `--shape scout` (the default) reads and reports only; `ship` may commit on the current branch with
  `bin/toli commit`.
- `--machine` pins the job to one machine; without it every machine that has the job in its `config/jobs.json`
  runs it.
- `--max-minutes` is the deadline of each headless run (`maxMinutes` in the job's entry; default 30 minutes, `none`
  for no deadline; edit `config/jobs.json` to change it for an existing job).
- Jobs live in `config/jobs.json` on each machine.

    bin/toli job list [--json] # schedule, shape, project, machine, running, last result
    bin/toli job pause|resume|remove <name>
    bin/toli job run <name> # run once now, headless, regardless of the schedule

## When and where jobs run

Jobs never run inside your chat. Every minute something checks for due jobs and starts each in its own headless
`omp -p` session in the background:

- while a lead session is open on omp, the toli extension does it (`bin/toli job run-due`);
- otherwise the OS ticker does (`bin/toli job tick`, installed by `bin/toli schedule install`: a launchd agent
  `com.toli.tick` on macOS; on Linux and WSL2 the systemd user units `toli-tick.service` + `toli-tick.timer` when
  `systemctl --user` works, else a crontab line tagged `# toli tick`; `TOLI_SCHEDULER` forces one). The ticker
  leaves due jobs to a live session when there is one. Installing (or, on systemd, uninstalling) the launchd or
  systemd tick also removes a `# toli tick` crontab line, such as the one a v0.1.0 Linux machine got; until then
  `schedule status`, doctor and the setup checklist warn about the leftover line (two ticks a minute). The tick and
  helpers record the bun and PATH found at install time, skipping bun's `bun-node-*` temp dirs (a reboot deletes
  them); those three also warn when the tick's recorded bun no longer exists (`bin/toli schedule install` fixes it).
  `toli-tick.service` is `KillMode=process`, so the disk keeper, update check and `fleet check --wake` the tick
  starts in the background keep running after it exits; a unit written before T1128 kills them with the tick, and
  `bin/toli schedule install` rewrites it.

A machine that was asleep through a scheduled minute runs the job once to catch up, not once per missed window. A
claimed job is never run twice, and a run still marked running after 3 hours is recorded as failed so the schedule
resumes. Each headless run is stopped at its job's deadline (`maxMinutes`, 30 minutes unless set; a rate-limit retry
counts against the same deadline) and sooner when it shows no progress for `capacity.stallMinutes`. A run stopped at
its deadline that never called `job finish` records the result `status: timed-out`, never `ok` (a slow or swapping
machine once kept a 4-minute job running for 2 hours). A job whose
`maxMinutes` is not a whole number of minutes (or `null`) is refused before it starts.

Scheduled runs follow fixed rules: never push, merge, or open a PR, and never ask questions; anything that needs
your decision goes into the result. The run finishes with `bin/toli job finish <name> <runId>`, which writes the
result to `data/jobs/<name>/<stamp>.md`. On a worker machine the result is also sent to the coordinator's inbox
([fleet.md](fleet.md)).

A run that found nothing to do and changed nothing (an idle tick of a frequent job) finishes with
`bin/toli job finish <name> <runId> --quiet`. The result is written and the run counts as usual (last run, last
status, run history, `job results`), but it is never unseen: it does not wake the lead, does not show in the digest
and is not sent to the coordinator. `--quiet` applies only to an `ok` run: with `--status failed` the result posts as
usual.

## Rate and usage limits

A headless run that stops on a provider's rate or usage limit retries once on another model when one is allowed
([harnesses.md](harnesses.md)). When the limit names its reset (a reset time, `retry-after-ms`, `retry-after` in
seconds), toli records it for that harness and model (the model name carries its provider or account) in
`state/job-limits.json`. Until the reset, every job on that model skips its due runs, unless its retry model is free
of a limit; each such job posts one inbox item, `job <name> paused until <time>`, and nothing else. After the reset
the job runs once to catch up and carries on as usual; a run on the model that gets through lifts the pause early.
`bin/toli job run <name>` always runs. The run that hit the limit still posts its failed result, and a limit that
names no reset pauses nothing: the next due run tries again.

## Results reach you

On the same minute, `bin/toli wake` picks up new job results and inbox items, and the harness brings them into the
chat (how each harness does it: [how-it-works.md](how-it-works.md#results-find-you)); with no lead session open,
the lead service takes them in a headless turn ([sardars.md](sardars.md)). The lead relays what matters in plain
words and dispatches any follow-up work to jawans. Results stay in `/bearings` and `bin/toli digest` until
acknowledged:

    bin/toli job results [--unseen] [--json]
    bin/toli job ack [--through <stamp>]
    bin/toli inbox list [--json] [--unseen]
    bin/toli inbox ack [--through <stamp>]

An ack covers only what a reader was shown, so a result that arrives while the lead is busy is never acknowledged
unseen. Each wake ends with the exact commands for the items it showed (`--through` the newest one per stream), and
the digest's Next block gives the same for the results it lists. A plain `ack` covers up to the newest item a wake,
`inbox list` or `job results` has shown; anything newer stays unread and wakes the lead again. The shown mark is one
per machine, not per session: with two sessions open, one may have shown what the other has not, so ack with the
`--through` commands your own wake or digest printed. Results delivered by a toli that predates the mark wake the
lead once more after the upgrade, then ack as usual.

## The ticker

    bin/toli schedule install      # run bin/toli job tick every minute
    bin/toli schedule status
    bin/toli schedule uninstall

Besides due jobs, every tick retries the outbox (results, alerts, delegations, delegated-task reports and `talk`
messages waiting for an unreachable machine), marks stale runs as failed, once a week posts the
`bin/toli prune` dry run to the inbox ([memory.md](memory.md#pruning)), and every 3 days starts the update check in
the background ([install.md](install.md#update-check)). It also runs oversight that no job prompt can switch off,
away mode included: an active task whose jawan died (a reboot, a dead lead session) is re-dispatched once and held
when that dies too, other active tasks no live run works on go to the inbox once, and on the coordinator `bin/toli
fleet check --wake` runs hourly to name idle machines with waiting work ([fleet.md](fleet.md#oversight)). A job's prompt
never skips itself because the user is away (`state/afk`): away mode changes who is asked, not what is checked.
Optional `pre-tick` and `post-tick` hooks in `local/hooks/` run around it ([helpers.md](helpers.md#hooks)). Tick
output goes to `logs/tick.log`.

For a machine's own recurring chores (disk cleanup, backups) that do not need an agent, use a
[helper](helpers.md) instead of a job.
