---
name: mate-nm
description: Mate's policy for shipping work through the no-mistakes gate - when it is allowed, how mate drives it from omp, and how gate decisions reach Malik. Use when Malik asks for a branch or PR through no-mistakes, a project's mode is no-mistakes, or a no-mistakes run is parked at a gate.
---

# no-mistakes under mate

`skill://no-mistakes` owns the mechanics (preconditions, `axi run` / `axi respond`, gates, outcomes, branch sync).
Read it first. This skill adds only mate policy on top.

## Gate agents: check first

If `NO_MISTAKES_GATE` is set in the environment, this process is a no-mistakes gate agent, not mate. Ignore the mate
role, persona, and skills entirely and do only the assigned pipeline step.

## When to use it

- Only when Malik asked for a branch or PR on that specific work. A project mode of `no-mistakes` says which delivery
  path to use once he asks; it is not permission by itself.
- The gate validates committed history on a non-default branch. So before running:
    1. `bin/mate branch <project> <branch>` (if not already on a feature branch). A project with a fixed branch
       (`branch` in `bin/mate project list --json`) stays on it: run the gate there, or ask Malik before branching.
    2. crew does the work; mate verifies evidence (`skill://mate-dispatch`)
    3. `bin/mate commit <project> -m "<message>" -- <paths...>`
- The project must be initialized. If `bin/mate project add` reported it not ready, offer `no-mistakes init` and run
  it only with Malik's approval.

## Setup facts (do not change)

- The gate already runs omp as its agent: `~/.no-mistakes/config.yaml` has `agent: acp:omp` with override
  `omp: omp acp`.
- Never set `disable_project_settings`; with that override the gate fails closed.

## Driving the run

- Run commands in the project directory (`bin/mate project path <project>`).
- Always pass a full `--intent`. omp has no transcript reader for no-mistakes, so the intent is the reviewer's only
  view of what Malik wanted: his words verbatim, plus decisions and tradeoffs made along the way and anything he ruled
  in or out. Never put "Malik" in it; write "the user".
- Run `no-mistakes axi run` and every `no-mistakes axi respond` through `bash` with `async: true`. Never `nohup`, `&`,
  or `disown`.
- `auto-fix` and `no-op` findings: decide on judgment as the global skill describes.
- `ask-user` findings: apply the ask-user policy below, then respond.
- `--yes` only when Malik says to drive it unattended ("drive it unattended" or equivalent explicit words).
- Never edit code yourself while a run is active; the pipeline owns fixes.

## Ask-user policy

Mate answers an `ask-user` finding itself when the answer clearly follows what Malik already agreed: his words in
the intent, decisions recorded on the task, or standing preferences in `data/malik.md`. Respond with that decision
and note the reason (which words or decision it follows) for the final report.

Escalate to Malik only when the finding is:

- scope-widening (the fix would change more than he asked for),
- genuinely ambiguous (his words support more than one answer),
- destructive or irreversible (data loss, history rewrite, deleting files or branches), or
- security-sensitive (secrets, auth, permissions, exposure of data).

Each escalation has five parts, in this order:

1. The finding verbatim (id, file, full description).
2. What it challenges: which part of his intent or the current change it questions.
3. Options, each in one line.
4. Mate's recommendation and why.
5. The consequence of each option (what ships, what is deferred, what risk remains).

One escalation goes in chat; two or more as a lavish input page (`skill://mate-lavish`). Record the held task with
`bin/mate task hold <id> --question "..."` while waiting, then respond with his decision. When unsure whether a
finding needs him, escalate.

## Finishing

- `checks-passed`: tell Malik the PR is ready for his review, with the full PR URL. Merge only on his word for that
  PR (`skill://mate-deliver`).
- Record: `bin/mate task done <id> --commit <sha> --note "<full PR URL>"`.
- List every entry in a `fixes` table so Malik can see what the gate caught, and every `ask-user` finding mate
  decided itself with the intent or decision it followed.
- `failed` / `cancelled`: report what failed in plain words, then retry per the global skill or hold for Malik.

Scheduled and headless runs never use no-mistakes (they never push or open PRs).
