---
name: mate-schedule
description: Create and manage recurring mate jobs from plain-language schedules ("every day at 5 pm", "weekdays 9:30") and run scheduled jobs when they fire. Use for /schedule add|list|pause|resume|remove, when Malik asks for something to happen regularly, or when a prompt starts with "[mate job <name> <runId>]".
---

# Scheduled jobs (/schedule)

## Translating the schedule

Convert Malik's words to a 5-field cron (`minute hour day-of-month month day-of-week`, local time):

| Malik says | cron |
|---|---|
| every day at 5 pm | `0 17 * * *` |
| weekdays 9:30 | `30 9 * * 1-5` |
| every Monday 8 am | `0 8 * * 1` |
| every hour | `0 * * * *` |
| first of the month at 6 am | `0 6 1 * *` |

Confirm it back in words before adding: "Ji Malik, that runs every weekday at 9:30 am. Adding it." If the time is
ambiguous ("in the morning", "evening"), ask once.

## Commands

    /schedule add <words>     ->  bin/mate job add <name> --cron "<cron>" --prompt "<text>" [--project <p>] [--machine <m>] [--shape scout|ship]
    /schedule list            ->  bin/mate job list --json
    /schedule pause <name>    ->  bin/mate job pause <name>
    /schedule resume <name>   ->  bin/mate job resume <name>
    /schedule remove <name>   ->  bin/mate job remove <name>

- `<name>`: short kebab-case from the purpose (`daily-deps-check`).
- `--prompt`: a self-contained instruction; the run will not see this conversation.
- `--shape`: `scout` (default choice for reports and checks) unless the job must change code.
- `--machine`: run the job only on that machine (e.g. where the project is cloned), when that is not this one.
- `bin/mate job run <name>` runs a job once now, for testing.

Present `list` as a short table: name, schedule in words, project, paused or active, last result.

## Make sure it will fire

After adding, check the ticker:

    bin/mate schedule status

If it is not installed, offer `bin/mate schedule install` (one launchd agent on macOS, a crontab line on Linux, running
`bin/mate job tick` every minute). Install only after Malik agrees.

How jobs run, in plain words for Malik:

- **While this session is open**, the mate extension checks every minute and drops due jobs into this conversation.
- **When no session is open**, the OS ticker runs the job headless (`omp -p`) and saves the output to
  `data/jobs/<name>/<stamp>.md`. A headless run counts as load on its machine (`bin/mate resources`) while it runs.
- On a worker machine, results are also sent to the coordinator; undelivered ones retry every minute.
- Results appear in `/bearings` until acknowledged.

## Scheduled-run rules

Every scheduled run, interactive or headless: never push, merge, open PRs, or ask questions. Ship jobs commit only
with `bin/mate commit` on the current branch. Anything needing Malik becomes `bin/mate task hold <id> --question "..."`
and is noted in the result.

## Handling `[mate job <name> <runId>]`

A prompt starting with that prefix was submitted by the extension. Do the job it describes under the scheduled-run
rules (dispatch crew as usual via `skill://mate-dispatch`), then record the result by piping a short markdown summary
to the CLI:

    bin/mate job finish <name> <runId> <<'EOF'
    <outcome, evidence, tasks held, files written>
    EOF

Always call `job finish`, even on failure (say what failed). Do not interrupt Malik with the result unless it needs
him; it will show up in `/bearings`.
