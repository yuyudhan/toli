---
name: toli-schedule
description: Create and manage recurring Sardar jobs from plain-language schedules ("every day at 5 pm", "weekdays 9:30") and run scheduled jobs when they fire. Use for /schedule add|list|pause|resume|remove, when Malik asks for something to happen regularly, or when a prompt starts with "[toli job <name> <runId>]".
---

# Scheduled jobs (/schedule)

## Translating the schedule

Convert Malik's words to a 5-field cron (`minute hour day-of-month month day-of-week`, local time):

| Malik says                 | cron           |
| -------------------------- | -------------- |
| every day at 5 pm          | `0 17 * * *`   |
| weekdays 9:30              | `30 9 * * 1-5` |
| every Monday 8 am          | `0 8 * * 1`    |
| every hour                 | `0 * * * *`    |
| first of the month at 6 am | `0 6 1 * *`    |

Confirm it back in words before adding: "Ji Malik, that runs every weekday at 9:30 am. Adding it." If the time is
ambiguous ("in the morning", "evening"), ask once.

## Commands

    /schedule add <words>     ->  bin/toli job add <name> --cron "<cron>" --prompt "<text>" [--project <p>] [--machine <m>] [--shape scout|ship]
    /schedule list            ->  bin/toli job list --json
    /schedule pause <name>    ->  bin/toli job pause <name>
    /schedule resume <name>   ->  bin/toli job resume <name>
    /schedule remove <name>   ->  bin/toli job remove <name>

- `<name>`: short kebab-case from the purpose (`daily-deps-check`).
- `--prompt`: a self-contained instruction; the run will not see this conversation.
- `--shape`: `scout` (default choice for reports and checks) unless the job must change code.
- `--machine`: run the job only on that machine (e.g. where the project is cloned), when that is not this one.
- `bin/toli job run <name>` runs a job once now, for testing. It takes as long as the job (up to 45 minutes), so run
  it only through `bash` with `async: true` and `timeout: 0`, then end the turn; its result arrives as a new turn.

Present `list` as a short table: name, schedule in words, project, paused or active, last result.

## Make sure it will fire

After adding, check the ticker:

    bin/toli schedule status

If it is not installed, offer `bin/toli schedule install` (one launchd agent on macOS; on Linux a systemd user timer
when `systemctl --user` works, else a crontab line; running `bin/toli job tick` every minute). Install only after
Malik agrees.

How jobs run, in plain words for Malik:

- Jobs never run inside this conversation, so Sardar stays free to talk.
- **While this session is open**, the Sardar extension checks every minute and starts due jobs in the background
  (`bin/toli job run-due`), each in its own headless `omp -p` run.
- **When no session is open**, the OS ticker does the same.
- Either way the output is saved to `data/jobs/<name>/<stamp>.md`, and a headless run counts as load on its machine
  (`bin/toli resources`) while it runs.
- On a worker machine, results are also sent to the coordinator; undelivered ones retry every minute.
- New results reach an open session as a `[toli wake]` message (each result once). Relay the outcome and any
  decision to Malik in plain words, dispatch follow-up work to jawans, then `bin/toli job ack` / `bin/toli inbox ack`.
  Results also appear in `/bearings` until acknowledged.

## Scheduled-run rules

Every scheduled run: never push, merge, open PRs, or ask questions. Ship jobs commit only with `bin/toli commit` on
the current branch. Anything needing Malik becomes `bin/toli task hold <id> --question "..."` and is noted in the
result.

## Handling `[toli job <name> <runId>]`

A prompt starting with that prefix is a headless job run (`omp -p`), not the live Sardar chat. Do the job it
describes under the scheduled-run rules (dispatch jawans as usual via `skill://toli-dispatch`; nobody is chatting
with this run, so it may wait for its jawans to finish), then record the result by piping a short markdown summary
to the CLI:

    bin/toli job finish <name> <runId> <<'EOF'
    <outcome, evidence, tasks held, files written>
    EOF

Always call `job finish`, even on failure (say what failed). The live session relays the result to Malik.
