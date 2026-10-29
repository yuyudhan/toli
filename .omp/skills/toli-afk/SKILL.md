---
name: toli-afk
description: Keep working through the queued backlog while Malik is away, park anything that needs him, and give one batched report when he returns. Use for /afk, /afk off, when Malik says he is stepping away or going offline, or on any message from Malik while state/afk exists.
---

# Away mode (/afk)

## Going away (`/afk`)

1. Set the flag from the repo root (away replaces quiet mode; remove its flag):

        touch state/afk && rm -f state/quiet

2. Note the start time; the report file will be `data/afk/<stamp>.md` (stamp like `2026-10-29T1730`).
3. Reply in one line: "Ji Malik, I'll keep working through the queue and have one report ready when you're back."

## While away

Work the backlog under the normal rules; being away never loosens them.

    bin/toli task list --json --status queued

- Take queued tasks oldest first and run them through `skill://toli-dispatch` (ship or scout as recorded).
- Delivery is commit-on-the-working-branch only (the project's fixed branch when it has one). No branches, branch
  switches, pushes, merges, PRs, releases, or no-mistakes runs, even if the project mode prefers them; those need
  Malik's word for the specific change.
- Local stacks: only the commands a project's notes declare (`skill://toli-stacks`), and only when a queued task's
  evidence needs them. Stop what you started before the report.
- Anything needing Malik (an ambiguous spec, a design choice, a destructive or security-sensitive step, failing
  evidence with no clear fix) becomes:

        bin/toli task hold <id> --question "<the question in plain words>"

    Then move on to the next task. Never guess on his behalf.

- Scheduled jobs that fire meanwhile are handled as usual (`skill://toli-schedule`).
- Append each outcome to `data/afk/<stamp>.md` as it happens, so nothing is lost if the session ends:

        ## T12 billing-api: fix retry cap
        Landed: commit abc1234. Evidence: `bun test` 48 passed.

- When the queue is empty, stop. Do not invent work.

## Coming back

Malik is back on any message from him, or `/afk off`.

1. Remove the flag:

        rm state/afk

2. Give one batched report from `data/afk/<stamp>.md`, outcome first:

        Ji Malik, welcome back. While you were away:
        Done: <n> tasks - <task, project, commit or report>, one line each.
        Needs your answer: <n> - <task, question>, one line each.
        Not started: <n>.
        Job results: <one line each, if any>.

3. If two or more tasks need answers, offer `/ahoy`.
4. Then handle whatever his message asked for.
