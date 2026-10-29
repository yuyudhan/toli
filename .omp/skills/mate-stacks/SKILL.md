---
name: mate-stacks
description: Run a project's local stack (start, stop, restart, migrate, logs, health checks) using only the commands declared in its notes file's `## Local stack` section. Use when Malik asks to bring a project's services up or down, restart them, run its migrations, check its logs or health, or when crew evidence needs the stack running.
---

# Local stacks

Mate never does project work itself. The one scoped exception: when `data/notes/<project>.md` has a `## Local stack`
section, mate may run exactly the commands declared there and read exactly the logs declared there. A project
without that section has no exception: stack work goes to crew through `skill://mate-dispatch`.

## What the section looks like

Malik's notes file declares the stack; mate only reads it. Typical shape:

    ## Local stack
    - Directory: <path relative to the project root, or "root">
    - Start: `<command>`
    - Stop: `<command>`
    - Restart: `<command>`
    - Migrate: `<command>`
    - Logs: `<command>` or <log file path>
    - Health: <local URL> (expect <status or text>)

Any key may be missing. A missing key means mate has no permission for that action.

## Rules

- Run the declared command verbatim from the declared directory (default: the project root from
  `bin/mate project path <project>`). Never edit, combine, or extend it, never add flags, and never substitute a
  similar command because the declared one fails.
- Long-running commands (a `start` that stays in the foreground, a log follow) run as a named `bash` service with a
  `ready` check (log regex or port), never with `nohup`, `&`, or `disown`. Name it `<project>-<action>`.
- Migrations: only the declared `Migrate` command. Anything that drops, resets, wipes, or reseeds data is not a
  migration; it goes to Malik first even if a declared command would do it.
- Health: request the declared URL (`curl -sS -o /dev/null -w '%{http_code}' <url>` or a headless browser) and compare
  with the declared expectation.
- Logs: read the declared log command or file, report the relevant lines, and never print secrets, tokens, or
  credentials found there (redact them).
- Never change the project's code, config, `.env` files, containers, or data to make the stack work. A failing
  command is a finding: report it to Malik with the output, or dispatch crew to fix it on his word.
- Stopping: stop only what mate started or what Malik asked to stop, with the declared `Stop` command.

## Crew and the stack

Crew briefs may tell crew to use the same declared commands for evidence (logs checked, local URL verified). Crew
follows the brief; this skill governs only what mate runs itself.

## Report

One line per action: what ran, the result (up, healthy, migrated, failed), and the key log or health output. On
failure, include the exact command and its error output.
