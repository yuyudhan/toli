---
name: toli-stow
description: Save what this session learned so future sessions start smarter - durable learnings, Malik's preferences, per-project facts - keep always-loaded memory within its token budget by re-checking and archiving stale entries, and reconcile the backlog tasks the session touched. Use for /stow, before ending a session, or when Malik says "remember this", "note that", or "wrap up".
---

# Saving session knowledge (/stow)

## Who does what

Only Sardar knows what this session learned, and only Sardar may take Malik's word, but Sardar never edits files.
So Sardar writes one `TOLI_BRIEF v1` brief for a `task` jawan (effort lo) and ends the turn:

- the candidate entries from this session, each with its target file and tier, and Malik's exact words for any
  `data/malik.md` change (adding, changing, or dropping a pinned entry);
- the memory pass below, the "What qualifies" rules, and "never archive a `data/malik.md` entry the brief does not
  name with Malik's word";
- the task ids from "Reconcile the backlog" that landed but are still `active`, with their sha or report path, for
  `bin/toli task done`;
- the report: what was saved where, tokens before -> after, what was archived or moved, and any shortfall.

Everything below describes that jawan's work unless it says Sardar.

## Where things go

| What                                                                                          | File                      | Tier   |
| --------------------------------------------------------------------------------------------- | ------------------------- | ------ |
| Malik's preferences and standing decisions (tone, delivery choices, recurring answers)        | `data/malik.md`           | pinned |
| Durable lessons about how Sardar should operate (a routing that worked, a pitfall in the CLI) | `data/learnings.md`       | aging  |
| Facts about one project (commands, stack, gotchas, flaky tests, paths)                        | `data/notes/<project>.md` | aging  |

All private and gitignored. Never write learnings into tracked files (skills, AGENTS.md, README) unless Malik asks
for a change to Sardar itself. **Never edit a project's committed AGENTS.md, CLAUDE.md, or other docs** as part of
stow; if they are wrong, tell Malik and offer a ship task.

`data/malik.md` and `data/learnings.md` load into every session and count against the budget; notes load only into
briefs for their project.

## Entries and lifetimes

An entry is a top-level bullet (with its indented lines) or a `## YYYY-MM-DD ...` heading section. Date it right
after the marker: `- 2026-10-29: billing-api tests need DATABASE_URL from .env.test`. The date is when it was last
confirmed.

- **pinned** (`data/malik.md`): never ages. Change only when Malik says so.
- **aging** (learnings, notes): stale 30 days after its date.
- **perishable**: an aging-file entry with a checkable end condition, `(until: PR #12 merges)` or
  `(until: v2 ships)`; stale after 7 days. No checkable condition means it is aging, not perishable.

Re-confirming = changing the date to today. Undated aging entries are listed as stale until /stow dates them.

## The memory pass (every /stow, even with nothing new)

1. **Measure:** `bin/toli memory`. Note the total and budget (`memoryBudgetTokens` in `config/machine.json`,
   default 7500; tokens = UTF-8 bytes / 3).
2. **Add new knowledge** (see "What qualifies"), dated today, after reading the target file.
3. **Re-check stale entries:** `bin/toli memory stale`. For each one:
    - This session (or a quick check now: file exists, command works, PR state) confirms it: update the date to today.
    - Perishable: condition still open -> refresh the date; resolved or no longer checkable -> archive.
    - Otherwise archive it:
      `bin/toli memory archive <file> <line-or-id> --reason "unreinforced 45d"`
    - Undated entry still true: date it today (one-time grace). Clearly wrong or obsolete: archive.
4. **Merge duplicates** in every memory file: keep one current line; archive the superseded wording
   (`--reason "merged into <id>"`) unless the kept line preserves all of it.
5. **Still over budget?** In this order, re-measuring after each step:
    1. Archive the oldest stale aging entries first (`--reason "budget oldest-first"`).
    2. Move conditional, project-specific facts from `data/learnings.md` into `data/notes/<project>.md` (they then
       load only into that project's briefs). Write the note first, then remove the learnings line.
    3. Still over: tell Malik the shortfall and the largest pinned sections; offer raising `memoryBudgetTokens` or
       trimming named entries. Never trim `data/malik.md` on your own.
6. **Measure again** and report before -> after totals.

Archive never means delete: `memory archive` moves the entry to `data/archive/<file>.md` under a `## YYYY-MM-DD`
heading with its source, original date, and reason. Recovery is copy-back. Never delete memory lines by hand.

**Pinned entries are never archived automatically.** `bin/toli memory archive malik <line> --force` only when Malik
explicitly says to drop that specific entry.

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
- Drop: anything already in a file, one-off task details, things obvious from the code.

One or two lines per entry, under a short heading. Fix entries this session proved wrong instead of appending
contradictions. Preferences come from what Malik actually said; when unsure whether it is standing or one-off, ask
him once.

## Reconcile the backlog

    bin/toli task list --json

For every task this session touched:

- Work landed and verified, but still `active`: the stow jawan runs `bin/toli task done <id> --commit <sha>` or
  `--report <path>`.
- Waiting on Malik but not recorded: Sardar runs `bin/toli task hold <id> --question "..."`.
- Abandoned by Malik: Sardar runs `bin/toli task drop <id>` (only on his word).
- Jawans still running: leave `active` and mention it.

Do not touch tasks the session did not work on. Old records (job results, finished tasks, logs) are `bin/toli prune`'s
job, not stow's; run `prune --apply` only when Malik says so.

## Report

From the jawan's report, a few lines to Malik: what was saved where, memory tokens before -> after (and budget), what
was archived or moved, which tasks were closed or held, anything still running.
