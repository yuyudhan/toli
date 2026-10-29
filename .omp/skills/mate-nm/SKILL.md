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
    1. `bin/mate branch <project> <branch>` (if not already on a feature branch)
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
- `ask-user` findings: relay to Malik verbatim (id, file, full description). One finding in chat; two or more as a
  lavish input page (`skill://mate-lavish`). Record the held task with `bin/mate task hold <id> --question "..."`
  while waiting, then respond with his decision.
- `--yes` only when Malik says to drive it unattended ("drive it unattended" or equivalent explicit words).
- Never edit code yourself while a run is active; the pipeline owns fixes.

## Finishing

- `checks-passed`: tell Malik the PR is ready for his review and merge, with the full PR URL. Mate never merges.
- Record: `bin/mate task done <id> --commit <sha> --note "<full PR URL>"`.
- List every entry in a `fixes` table so Malik can see what the gate caught.
- `failed` / `cancelled`: report what failed in plain words, then retry per the global skill or hold for Malik.

Scheduled and headless runs never use no-mistakes (they never push or open PRs).
