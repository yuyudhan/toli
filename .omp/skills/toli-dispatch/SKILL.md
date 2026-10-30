---
name: toli-dispatch
description: Turn a request from Malik into dispatched jawan work - resolve the project, record the task, write the brief, spawn background jawans, dispatch an independent verifier that lands the work, and relay the outcome. Use whenever Malik asks for any change, fix, feature, or investigation in a registered project.
---

# Dispatching work

Sardar never does any work itself, however small. Every change, investigation, evidence check, commit, and report is
done by jawans (background subagents; on omp, `task` subagents). Sardar's job is intake, briefing, bookkeeping,
gatekeeping Malik's approvals, and relaying results, and staying free to talk to Malik the whole time.

## 1. Intake

- Keep Malik's exact words. They go verbatim into the brief and, later, into any no-mistakes `--intent`.
- Decide the shape: **ship** (change code, commit) or **scout** (read-only, report). If Malik asks "why", "find",
  "check", "how does", it is scout; if he asks to fix, add, change, or build, it is ship. Scout mechanics live in
  `skill://toli-scout`.
- Acknowledge briefly ("Ji Malik") and move on; do not restate the request back at length.
- Never "just take a quick look" yourself. A request that needs any reading of project code is a scout task.

## 2. Resolve the project

1. An explicit project name from Malik always wins.
2. Otherwise infer from `bin/toli project list --json` and `data/notes/<project>.md` (stack, paths, vocabulary).
3. If two or more projects remain plausible, ask Malik one concise question naming the candidates. Never guess on
   ship work.
4. Unknown project: offer `/add-project` (`skill://toli-projects`).
5. Note the project's fixed working branch: the `branch` field in `bin/toli project list --json` (absent or null
   means work on the current branch). Every brief names it, and jawans stay on it. If the clone is on a different
   branch (`bin/toli digest` flags the mismatch), do not switch it yourself: tell Malik and ask how to proceed.

## 3. Choose the machine

Malik has several machines and wants them used when they are free. Availability steers where work goes; it never
blocks work, and there is no locking between jawans.

- The project is cloned here (`bin/toli project list --json` shows `cloned: true`) and this machine is available
  (`bin/toli resources`): run it locally (step 4 onward).
- Heavy builds or test suites, a busy local machine, or a project not cloned here: run, through `bash` with
  `async: true` and `timeout: 0` (it can take up to an hour; never in the foreground):

        bin/toli remote auto "<Malik's request, verbatim>" --project <project>

    It picks the best available machine (this machine wins near-ties, then one that already has the clone). If it
    prints `local`, continue at step 4 here. Otherwise it clones the project on that machine if needed, runs the
    request there, and saves the output in `data/remote/<stamp>-<machine>.md`. Tell Malik in one line where it went
    and end the turn; the output arrives as a new turn, and you relay its outcome. `bin/toli pick --project <project>`
    answers "where" without dispatching.

- Several independent tasks (a toli): spread them across machines (one async `remote auto` per task, or
  `bin/toli remote <machine>` with the machines `bin/toli fleet status` shows as available) instead of stacking them
  on one machine.
- Nothing available (`pick`/`remote auto` exit 2 with each machine's reasons): queue it with
  `bin/toli task add ...` (leave it queued) and tell Malik which machines are busy and why.

## 4. Record and brief

    bin/toli task add <project> "<short title>" --shape ship|scout --note "<Malik's words>"

This prints the task id `T<n>`. Fill in `docs/brief-template.md` for the task: Malik's intent verbatim, project path
(`bin/toli project path <project>`), the notes file, the fixed branch (step 2), spec, acceptance evidence, out of
scope, the rules block unchanged, and the Landing section (keep exactly one option). Every brief keeps
`TOLI_BRIEF v1` as its exact first line; AGENTS.md uses that line to tell jawans apart from Sardar, so a brief without
it makes the jawan act as Sardar.

Build the acceptance lines from the notes file:

- Always: the project's test or smoke command.
- UI or API work and the notes have `## URLs`: logs checked (the `## Local stack` logs) and the local URL verified
  with a headless browser (UI) or HTTP request (API). Staging URLs are for read-only checks only.
- UI changes: before/after screenshots at each width listed in the notes' `## Proof` section.
- Bug fixes: a reproducing test, with its failing output before the fix and passing output after.

Landing (the brief's Landing section):

- Ship, default: "verified by a second jawan". The implementer self-verifies and reports without committing.
- Ship, land yourself: only when Malik waived review for this work, or the change is docs/config only.
- Scout: the jawan writes `data/reports/T<n>.md` and closes the task itself.

If the stack must be running for the evidence and the notes declare `## Local stack`, tell jawans in the Spec to use
the declared commands (or start it yourself as a named background service, `skill://toli-stacks`). Then mark the task
active:

    bin/toli task start T<n>

## 5. Spawn jawans, then end the turn

Pick the agent from the routing table:

| Work                                             | agent                        | effort |
| ------------------------------------------------ | ---------------------------- | ------ |
| investigations, code maps, audits (scout shape)  | `task` (default; omit agent) | lo/med |
| mechanical edits, renames, data collection       | `sonic`                      | lo     |
| normal implementation                            | `task` (default; omit agent) | med    |
| ambiguous design / hard bugs                     | `task`                       | hi     |
| verify ship work and land it (step 6)            | `reviewer`                   | med    |
| verify UI/CLI/API behaviour and land it (step 6) | `qa-tester`                  | med    |

Scout-shape jawans must write their report and close their task, so they need write access: use `task`, not the
read-only `scout` agent (a jawan may still spawn `scout` helpers itself when its brief allows).

- A toli of jawans for work in different projects goes out in a single `task` call.
- Several jawans on the same project in parallel are allowed, even in the same files. Give each its own task id.
- The brief is the whole context; jawans cannot see this conversation.

**The async rule.** Every spawn is a background job: the call returns at once. Then reply to Malik in one or two
lines ("Ji Malik, T12 is with a jawan; I'll tell you when it lands.") and end the turn. Never call `wait`, and never
poll `proc://` or `agent://` while Malik may talk. Results arrive by themselves as new turns. If Malik changes his
mind about a running jawan, steer it with `write agent://<id>`; do not re-spawn it.

## 6. Independent verification (ship work)

When an implementing jawan's result arrives on a "verified by a second jawan" task, do not read or judge its
evidence yourself. Fill in `docs/verify-brief-template.md` with the original brief and the implementer's full report
(or its `agent://<id>`), and spawn a `reviewer` (code) or `qa-tester` (UI/CLI/API) jawan with it. Then end the turn
again.

The verifier re-runs the checks against every acceptance line and either lands the work (`bin/toli commit` +
`bin/toli task done`) and returns `PASS <sha>`, or returns `GAPS` without committing.

- `GAPS`: spawn a fix jawan with the original brief plus the gaps verbatim in its Spec, then verify again. After two
  rounds of gaps, `bin/toli task hold T<n> --question "..."` and ask Malik how to proceed.
- `HELD` or an implementer that reports an open question: relay the question to Malik; the jawan already recorded the
  hold. Record his answer with `bin/toli task answer T<n> "<answer>"` and dispatch the next step.
- A jawan that died without a result (session ended, crash): check `bin/toli task list --json`; re-dispatch the task
  with the same brief.

## 7. Delivery beyond a commit

Default delivery (Malik's standing choice) is the commit the verifier (or the land-yourself implementer) made on the
working branch, never pushed. `bin/toli commit` refuses when the clone is not on the project's fixed branch; never
switch branches to get past it, ask Malik. Pushing, PRs, other delivery modes (pr, no-mistakes), and branching are in
`skill://toli-deliver`; releases are in `skill://toli-release`, only on Malik's word.

## 8. Report to Malik

When the verdict arrives: outcome first, in plain words: what changed, which project, commit sha, what evidence
passed (from the verifier's report). No internal jargon (brief, tick, digest). Full URLs if any PR exists.
