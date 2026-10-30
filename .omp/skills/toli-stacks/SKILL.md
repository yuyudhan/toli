---
name: toli-stacks
description: Start and stop a project's local stack as background services using only the commands declared in its notes file's `## Local stack` section, and route migrations, logs, health checks, and stack failures to jawans. Use when Malik asks to bring a project's services up or down, restart them, run its migrations, check its logs or health, or when jawan evidence needs the stack running.
---

# Local stacks

Sardar never does project work itself. The one scoped exception: when `data/projects/<project>/notes.md` has a `## Local stack`
section, Sardar may start, stop, and restart the stack with exactly the commands declared there, as named background
services. Everything else about the stack (migrations, reading logs, health checks, failure triage) is jawan work
through `skill://toli-dispatch`. A project without that section has no exception at all.

## What the section looks like

Malik's notes file declares the stack; Sardar only reads it. Typical shape:

    ## Local stack
    - Directory: <path relative to the project root, or "root">
    - Start: `<command>`
    - Stop: `<command>`
    - Restart: `<command>`
    - Migrate: `<command>`
    - Logs: `<command>` or <log file path>
    - Health: <local URL> (expect <status or text>)

Any key may be missing. A missing key means nobody has permission for that action.

## What Sardar runs

- `Start`, `Stop`, `Restart` only, verbatim from the declared directory (default: the project root from
  `bin/toli project path <project>`). Never edit, combine, or extend a command, never add flags, and never substitute a
  similar command because the declared one fails.
- Always as a named `bash` service with a short `ready` check (log regex or port), named `<project>-<action>`, so it
  never blocks the chat. Never `nohup`, `&`, or `disown`. A one-shot `Stop` runs as `bash` with `async: true`.
- If it is not ready in time, or a command fails: do not dig into it. Tell Malik in one line and, on his word or when
  a task needs the stack, dispatch a jawan to triage.
- Stopping: stop only what Sardar started or what Malik asked to stop, with the declared `Stop` command.

## What jawans do

Brief a jawan (`sonic` for a plain migrate/health/logs run, `task` for triage) with the declared commands quoted:

- Migrations: only the declared `Migrate` command. Anything that drops, resets, wipes, or reseeds data is not a
  migration; it goes to Malik first even if a declared command would do it.
- Health: request the declared URL (`curl -sS -o /dev/null -w '%{http_code}' <url>` or a headless browser) and compare
  with the declared expectation.
- Logs: read the declared log command or file, report the relevant lines, and never print secrets, tokens, or
  credentials found there (redact them).
- Never change the project's code, config, `.env` files, containers, or data to make the stack work unless Malik
  asked for that fix. A failing command is a finding: report it with the output.

Jawan briefs for other tasks may also tell jawans to use the same declared commands for their evidence (logs
checked, local URL verified).

## Report

One line per action: what ran, the result (up, stopped, migrated, healthy, failed), and, for jawan work, the key log
or health output from its report. On failure, include the exact command and its error output.
