# Scheduled jobs

Say it in plain words; the lead turns it into a cron schedule and confirms:

    /schedule add every day at 5 pm, summarise yesterday's commits in billing-api

becomes

    bin/toli job add billing-daily-summary --cron "0 17 * * *" --prompt "Summarise yesterday's commits..." --project billing-api --shape scout

`/schedule list|pause|resume|remove` manage them the same way.

## Defining a job

    bin/toli job add <name> --cron "<m h dom mon dow>" --prompt "<text>" [--project <p>] [--machine <m>] [--shape scout|ship]

- `--shape scout` (the default) reads and reports only; `ship` may commit on the current branch with
  `bin/toli commit`.
- `--machine` pins the job to one machine; without it every machine that has the job in its `config/jobs.json`
  runs it.
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
  leaves due jobs to a live session when there is one.

A machine that was asleep through a scheduled minute runs the job once to catch up, not once per missed window. A
claimed job is never run twice, and a run still marked running after 3 hours is recorded as failed so the schedule
resumes. Each headless run has a 45-minute limit.

Scheduled runs follow fixed rules: never push, merge, or open a PR, and never ask questions; anything that needs
your decision goes into the result. The run finishes with `bin/toli job finish <name> <runId>`, which writes the
result to `data/jobs/<name>/<stamp>.md`. On a worker machine the result is also sent to the coordinator's inbox
([fleet.md](fleet.md)).

## Results reach you

On the same minute, `bin/toli wake` picks up new job results and inbox items, and the harness brings them into the
chat (how each harness does it: [how-it-works.md](how-it-works.md#results-find-you)). The lead relays what matters
in plain words and dispatches any follow-up work to jawans. Results stay in `/bearings` and `bin/toli digest` until
acknowledged:

    bin/toli job results [--unseen] [--json]
    bin/toli job ack
    bin/toli inbox list [--json] [--unseen]
    bin/toli inbox ack

## The ticker

    bin/toli schedule install      # run bin/toli job tick every minute
    bin/toli schedule status
    bin/toli schedule uninstall

Besides due jobs, every tick retries the worker outbox, marks stale runs as failed, once a week posts the
`bin/toli prune` dry run to the inbox ([memory.md](memory.md#pruning)), and every 3 days starts the update check in
the background ([install.md](install.md#update-check)). Optional `pre-tick` and `post-tick` hooks
in `local/hooks/` run around it ([helpers.md](helpers.md#hooks)). Tick output goes to `logs/tick.log`.

For a machine's own recurring chores (disk cleanup, backups) that do not need an agent, use a
[helper](helpers.md) instead of a job.
