---
name: toli-nm
description: Sardar's policy for shipping work through the no-mistakes gate - when it is allowed, how a gate jawan drives it from omp, and how gate decisions reach Malik. Use when Malik asks for a branch or PR through no-mistakes, a project's mode is no-mistakes, or a no-mistakes run is parked at a gate.
---

# no-mistakes under Sardar

`skill://no-mistakes` owns the mechanics (preconditions, `axi run` / `axi respond`, gates, outcomes, branch sync).
This skill adds Sardar policy on top. Sardar never drives the gate itself: a gate jawan (`task`, effort med) does,
with this policy and the global skill named in its brief. Sardar takes Malik's decisions and relays outcomes.

## Gate agents: check first

If `NO_MISTAKES_GATE` is set in the environment, this process is a no-mistakes gate agent, not Sardar. Ignore the Sardar
role, persona, and skills entirely and do only the assigned pipeline step.

## When to use it

- Only when Malik asked for a branch or PR on that specific work, or the project has a standing push+pr grant
  (`standing` in `bin/toli project list --json`, set only on his explicit word) and a per-task strategy. A project
  mode of `no-mistakes` says which delivery path to use; it is not permission by itself.
- The gate validates committed history on a non-default branch. So before running:
    1. Per-task strategies (`branch-per-task` / `worktree-per-task`): the task is already on its own
       `toli/<T-id>-<slug>` branch, prepared by `bin/toli spawn --task` or `bin/toli workspace prepare <T-id>`; the gate
       jawan runs in that workspace (the clone, or `projects/.worktrees/<project>/<T-id>`). Same-branch projects:
       `bin/toli branch <project> <branch>` (if not already on a feature branch), as the first step of the
       implementer's brief. A project with a fixed branch (`branch` in `bin/toli project list --json`) stays on it:
       run the gate there, or ask Malik before branching.
    2. jawans do the work; a verifier jawan checks it and commits (`skill://toli-dispatch`, step 6).
- The project must be initialized. If `bin/toli project add` reported it not ready, offer `no-mistakes init`; on
  Malik's approval a jawan runs it.

## Setup facts (do not change)

- The gate already runs omp as its agent: `~/.no-mistakes/config.yaml` has `agent: acp:omp` with override
  `omp: omp acp`.
- Never set `disable_project_settings`; with that override the gate fails closed.

## The gate jawan's brief

The brief (`docs/brief-template.md`, Landing "land yourself", with Malik's branch/PR request quoted, or the standing
grant named, in place of the "Never push" rule) tells the jawan to:

- Run commands in the task's workspace: `bin/toli project path <project>` for same-branch projects, else the path
  recorded on the task (`bin/toli task list --json`, `workspace.path`).
- Always pass a full `--intent`. omp has no transcript reader for no-mistakes, so the intent is the reviewer's only
  view of what was wanted: Malik's words verbatim, plus decisions and tradeoffs made along the way and anything he
  ruled in or out. Never put "Malik" in it; write "the user". Sardar writes this intent into the brief.
- Run `no-mistakes axi run` and every `no-mistakes axi respond` through `bash` with `async: true`. Never `nohup`, `&`,
  or `disown`.
- Decide `auto-fix` and `no-op` findings on judgment as the global skill describes.
- Apply the ask-user policy below to `ask-user` findings: answer what clearly follows the intent, and for anything
  that must escalate, leave the run parked, record `bin/toli task hold <id> --question "..."` with the five-part
  escalation, and report.
- Use `--yes` only when the brief quotes Malik saying to drive it unattended ("drive it unattended" or equivalent).
- Never edit code itself while a run is active; the pipeline owns fixes.
- On `checks-passed`, record `bin/toli task done <id> --commit <sha> --note "<full PR URL>"` and report the `fixes`
  table and every `ask-user` finding it decided, with the intent or decision it followed.

Spawn it in the background and end the turn (the async rule in `skill://toli-dispatch`).

## Ask-user policy

An `ask-user` finding is answered without Malik when the answer clearly follows what Malik already agreed: his words
in the intent, decisions recorded on the task, or standing preferences in `data/preferences.md` (Sardar copies the relevant
ones into the brief). The response notes the reason (which words or decision it follows) for the final report.

Escalate to Malik only when the finding is:

- scope-widening (the fix would change more than he asked for),
- genuinely ambiguous (his words support more than one answer),
- destructive or irreversible (data loss, history rewrite, deleting files or branches), or
- security-sensitive (secrets, auth, permissions, exposure of data).

Each escalation has five parts, in this order:

1. The finding verbatim (id, file, full description).
2. What it challenges: which part of his intent or the current change it questions.
3. Options, each in one line.
4. The recommendation and why.
5. The consequence of each option (what ships, what is deferred, what risk remains).

Sardar relays one escalation in chat; two or more go on a lavish input page built by a jawan (`skill://toli-lavish`).
Record his answer with `bin/toli task answer <id> "<answer>"`, then dispatch a gate jawan to `axi respond` with it and
carry the run on. When unsure whether a finding needs him, escalate.

## Finishing

- `checks-passed`: tell Malik the PR is ready for his review, with the full PR URL. Merge only on his word for that
  PR (`skill://toli-deliver`).
- Relay the `fixes` table so Malik can see what the gate caught, and every `ask-user` finding decided without him.
- `failed` / `cancelled`: report what failed in plain words, then dispatch a retry per the global skill or hold for
  Malik.

Scheduled and headless runs never use no-mistakes (they never push or open PRs).
