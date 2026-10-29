---
name: toli-stow
description: Save what this session learned so future sessions start smarter - durable learnings, Malik's preferences, per-project facts - and reconcile the backlog tasks the session touched. Use for /stow, before ending a session, or when Malik says "remember this", "note that", or "wrap up".
---

# Saving session knowledge (/stow)

## Where things go

| What                                                                                          | File                      |
| --------------------------------------------------------------------------------------------- | ------------------------- |
| Durable lessons about how Sardar should operate (a routing that worked, a pitfall in the CLI) | `data/learnings.md`       |
| Malik's preferences and standing decisions (tone, delivery choices, recurring answers)        | `data/malik.md`           |
| Facts about one project (commands, stack, gotchas, flaky tests, paths)                        | `data/notes/<project>.md` |

All three are private and gitignored. Never write learnings into tracked files (skills, AGENTS.md, README) unless
Malik asks for a change to Sardar itself.

**Never edit a project's committed AGENTS.md, CLAUDE.md, or other docs** as part of stow. Project facts go to
`data/notes/<project>.md`. If a project's own docs are wrong, tell Malik and offer a ship task.

## Project notes sections Sardar reads

Keep these headings exact in `data/notes/<project>.md`; skills look for them by name:

| Heading          | Holds                                                                               | Read by              |
| ---------------- | ----------------------------------------------------------------------------------- | -------------------- |
| `## Local stack` | directory, start/stop/restart/migrate/logs commands, health URLs                    | `toli-stacks`        |
| `## URLs`        | local and staging URLs (staging is read-only)                                       | briefs, `toli-scout` |
| `## Proof`       | screenshot widths and other required evidence                                       | briefs               |
| `## Release`     | integration branch, release notes file, tag format, smoke checks, issue transitions | `toli-release`       |

Record a stack command, URL, or release step only after Malik stated it or a run proved it. Never store passwords,
tokens, or OTPs in notes; point to where Malik keeps them instead.

## What qualifies

Write an entry only if it will change a future decision:

- Keep: "billing-api tests need `DATABASE_URL` from `.env.test`; `bun test` alone fails."
- Keep: "Malik wants PRs for anything touching auth, even when the project mode is commit."
- Drop: anything already in the file, one-off task details, things obvious from the code.

Each entry is one or two lines, dated (`2026-10-29:`), under a short heading. Edit or delete entries that this session
proved wrong instead of appending contradictions. Read the target file first.

Preferences come from what Malik actually said. When unsure whether something is a standing preference or a one-off,
ask him once.

## Reconcile the backlog

    bin/toli task list --json

For every task this session touched:

- Work landed and verified, but still `active`: `bin/toli task done <id> --commit <sha>` or `--report <path>`.
- Waiting on Malik but not recorded: `bin/toli task hold <id> --question "..."`.
- Abandoned by Malik: `bin/toli task drop <id>` (only on his word).
- Jawan still running: leave `active` and mention it.

Do not touch tasks the session did not work on.

## Report

A few lines to Malik: what was saved where, which tasks were closed or held, anything still running.
