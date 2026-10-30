---
name: toli-afk
description: Keep working through the queued backlog while Malik is away, park anything that needs him, and give one batched report when he returns. Use for /afk, /afk off, when Malik says he is stepping away or going offline, or on any message from Malik while state/afk exists.
---

# Away mode (/afk)

## Going away (`/afk`)

1. Set the flag from the repo root, with the start time in it (away replaces quiet mode; remove its flag):

        date -u +%Y-%m-%dT%H:%M:%SZ > state/afk && rm -f state/quiet

2. Reply in one line: "Ji Malik, I'll keep working through the queue and have one report ready when you're back."

## While away

Work the backlog under the normal rules; being away never loosens them, and Sardar still does no work itself.

    bin/toli task list --json --status queued

- Send the queued tasks out through `skill://toli-dispatch` (ship or scout as recorded), independent tasks together
  in one batched spawn, spread across free machines (`pick` / async `remote auto`). Verifier jawans land ship work as
  usual.
- Delivery is commit-on-the-working-branch only (the project's fixed branch when it has one). No branches, branch
  switches, pushes, merges, PRs, releases, or no-mistakes runs, even if the project mode prefers them; those need
  Malik's word for the specific change.
- Local stacks: only the declared commands (`skill://toli-stacks`), and only when a queued task's evidence needs
  them. Stop what you started before the report.
- Anything needing Malik (an ambiguous spec, a design choice, a destructive or security-sensitive step, gaps after two
  fix rounds) becomes:

        bin/toli task hold <id> --question "<the question in plain words>"

    Then move on to the next task. Never guess on his behalf.

- Scheduled jobs run in the background as usual (`skill://toli-schedule`); their results arrive as `[toli wake]`
  messages and wait for the report.
- Nothing needs writing down along the way: jawans record their own outcomes (`task done` with commit or report,
  `task hold` with the question), so nothing is lost if the session ends.
- When the queue is empty and no jawans are running, stop. Do not invent work.

## Coming back

Malik is back on any message from him, or `/afk off`.

1. Read the start time from `state/afk`, then remove the flag:

        rm state/afk

2. Give one batched report from `bin/toli task list --json` (tasks whose `updatedAt` is after the start time) and
   `bin/toli digest` (job results, inbox), outcome first:

        Ji Malik, welcome back. While you were away:
        Done: <n> tasks - <task, project, commit or report>, one line each.
        Needs your answer: <n> - <task, question>, one line each.
        Still running: <n>.
        Not started: <n>.
        Job results: <one line each, if any>.

3. If two or more tasks need answers, offer `/ahoy`.
4. Then handle whatever his message asked for.
