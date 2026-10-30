# Memory and pruning

toli remembers in plain Markdown files, and every new brief carries what matters. The always-loaded part stays small:
it has a token budget, entries age, and old ones are archived, never silently deleted.

## What is remembered

| File                             | Holds                                                    | Loaded                         |
| -------------------------------- | -------------------------------------------------------- | ------------------------------ |
| `data/preferences.md`            | your preferences ("always use pnpm", "short replies")    | every session                  |
| `data/learnings.md`              | lessons that hold across projects                        | every session                  |
| `data/projects/<p>/notes.md`     | the project's stack, commands, local stack, URLs, proof  | in every brief for the project |
| `data/projects/<p>/decisions.md` | held questions and your answers                          | kept as the project's record   |
| `data/archive/<file>.md`         | archived entries, with source, original date, and reason | never                          |

Say `/stow` (or let the lead do it before a session reset) to save what was learned in the session and keep memory
within its budget. Knowledge is never written into a project's committed `AGENTS.md` or `CLAUDE.md`; only wrong
facts there are corrected, as a normal task.

## Budget and ageing

    bin/toli memory [--json]          # always-loaded memory in estimated tokens vs budget; notes listed separately
    bin/toli memory stale [--json]    # entries past their lifetime: file, line, id, date, age, tier
    bin/toli memory archive <file> <line-or-id> --reason "<why>" [--force]   # move one entry to data/archive/<file>.md

- Tokens are estimated as UTF-8 bytes / 3. The budget for `data/preferences.md` + `data/learnings.md` is
  `memoryBudgetTokens` in `config/machine.json` (default 7500); `bin/toli doctor` warns when memory is over it.
- Entries are dated (`- 2026-10-29: ...`); the date is when the entry was last confirmed.
- `data/learnings.md` and project notes entries go stale after 30 days, or 7 days when marked `(until: <condition>)`.
  `/stow` re-checks stale entries: confirmed ones get a fresh date, the rest are archived.
- `data/preferences.md` is pinned: it never ages, and archiving one of its entries needs `--force` and your word.

## Pruning

    bin/toli prune [--apply] [--json]   # dry run by default

| Pruned by `bin/toli prune --apply`                    | Default rule                                  | What happens                       |
| ----------------------------------------------------- | --------------------------------------------- | ---------------------------------- |
| Job results `data/jobs/<name>/*.md`                   | older than 30 days; the newest 5 per job stay | deleted                            |
| Done or dropped tasks in `data/backlog.json`          | finished more than 90 days ago                | moved to `data/archive/tasks.json` |
| Files in `logs/`                                      | not written for 14 days                       | deleted                            |
| Inbox items `data/inbox/*.md`                         | acknowledged and older than 14 days           | deleted                            |
| Reports `data/reports/`, `data/projects/<p>/reports/` | never                                         | kept                               |

Override any rule in `config/machine.json`:

```json
{ "retention": { "jobResultsDays": 30, "jobResultsKeep": 5, "tasksDays": 90, "logsDays": 14, "inboxDays": 14 } }
```

Once a week the ticker posts the dry-run listing to the inbox (a worker sends it to the coordinator's inbox); it
never applies it. Nothing is removed until you say "prune".

## Moving old data

Installs from before the per-project layout move their files with `bin/toli migrate [--dry-run]`
([projects.md](projects.md#moving-data-from-the-old-layout)).
