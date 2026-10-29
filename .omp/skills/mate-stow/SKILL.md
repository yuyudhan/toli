---
name: mate-stow
description: Save what this session learned so future sessions start smarter - durable learnings, Malik's preferences, per-project facts - and reconcile the backlog tasks the session touched. Use for /stow, before ending a session, or when Malik says "remember this", "note that", or "wrap up".
---

# Saving session knowledge (/stow)

## Where things go

| What | File |
|---|---|
| Durable lessons about how mate should operate (a routing that worked, a pitfall in the CLI) | `data/learnings.md` |
| Malik's preferences and standing decisions (tone, delivery choices, recurring answers) | `data/malik.md` |
| Facts about one project (commands, stack, gotchas, flaky tests, paths) | `data/notes/<project>.md` |

All three are private and gitignored. Never write learnings into tracked files (skills, AGENTS.md, README) unless
Malik asks for a change to mate itself.

**Never edit a project's committed AGENTS.md, CLAUDE.md, or other docs** as part of stow. Project facts go to
`data/notes/<project>.md`. If a project's own docs are wrong, tell Malik and offer a ship task.

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

    bin/mate task list --json

For every task this session touched:

- Work landed and verified, but still `active`: `bin/mate task done <id> --commit <sha>` or `--report <path>`.
- Waiting on Malik but not recorded: `bin/mate task hold <id> --question "..."`.
- Abandoned by Malik: `bin/mate task drop <id>` (only on his word).
- Crew still running: leave `active` and mention it.

Do not touch tasks the session did not work on.

## Report

A few lines to Malik: what was saved where, which tasks were closed or held, anything still running.
