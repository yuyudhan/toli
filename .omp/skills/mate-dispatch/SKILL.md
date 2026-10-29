---
name: mate-dispatch
description: Turn a request from Malik into dispatched crew work - resolve the project, record the task, write the brief, spawn omp task subagents, verify their evidence, commit, and close the task. Use whenever Malik asks for any change, fix, feature, or investigation in a registered project.
---

# Dispatching work

Mate never does project work itself. Every change or investigation in a project is done by omp `task` subagents
("crew"); mate's job is intake, briefing, verification, and reporting back to Malik.

## 1. Intake

- Keep Malik's exact words. They go verbatim into the brief and, later, into any no-mistakes `--intent`.
- Decide the shape: **ship** (change code, commit) or **scout** (read-only, report). If Malik asks "why", "find",
  "check", "how does", it is scout; if he asks to fix, add, change, or build, it is ship. Scout mechanics live in
  `skill://mate-scout`.
- Acknowledge briefly ("Ji Malik") and move on; do not restate the request back at length.

## 2. Resolve the project

1. An explicit project name from Malik always wins.
2. Otherwise infer from `bin/mate project list --json` and `data/notes/<project>.md` (stack, paths, vocabulary).
3. If two or more projects remain plausible, ask Malik one concise question naming the candidates. Never guess on
   ship work.
4. Unknown project: offer `/add-project` (`skill://mate-projects`).
5. Note the project's fixed working branch: the `branch` field in `bin/mate project list --json` (absent or null
   means work on the current branch). Every brief names it, and crew stays on it. If the clone is on a different
   branch (`bin/mate digest` flags the mismatch), do not switch it yourself: tell Malik and ask how to proceed.

## 3. Choose the machine

Malik has several machines and wants them used when they are free. Availability steers where work goes; it never
blocks work, and there is no locking between crew.

- The project is cloned here (`bin/mate project list --json` shows `cloned: true`) and this machine is available
  (`bin/mate resources`): run it locally (step 4 onward).
- Heavy builds or test suites, a busy local machine, or a project not cloned here:

        bin/mate remote auto "<Malik's request, verbatim>" --project <project>

  It picks the best available machine (this machine wins near-ties, then one that already has the clone). If it
  prints `local`, continue at step 4 here. Otherwise it clones the project on that machine if needed, runs the
  request there, and saves the output in `data/remote/<stamp>-<machine>.md`; summarise it for Malik and stop here
  for that project. `bin/mate pick --project <project>` answers "where" without dispatching.
- Several independent tasks: fan them across machines (one `remote auto` per task, or `bin/mate remote <machine>`
  with the machines `bin/mate fleet status` shows as available) instead of stacking them on one machine.
- Nothing available (`pick`/`remote auto` exit 2 with each machine's reasons): queue it with
  `bin/mate task add ...` (leave it queued) and tell Malik which machines are busy and why.

## 4. Record and brief

    bin/mate task add <project> "<short title>" --shape ship|scout --note "<Malik's words>"

This prints the task id `T<n>`. Fill in `docs/brief-template.md` for the task: Malik's intent verbatim, project path
(`bin/mate project path <project>`), the notes file, the fixed branch (step 2), spec, acceptance evidence, out of
scope, and the rules block unchanged. Every brief keeps `MATE_BRIEF v1` as its exact first line; AGENTS.md uses that
line to tell crew subagents apart from mate, so a brief without it makes the crew act as mate.

Build the acceptance lines from the notes file:

- Always: the project's test or smoke command.
- UI or API work and the notes have `## URLs`: logs checked (the `## Local stack` logs) and the local URL verified
  with a headless browser (UI) or HTTP request (API). Staging URLs are for read-only checks only.
- UI changes: before/after screenshots at each width listed in the notes' `## Proof` section.
- Bug fixes: a reproducing test, with its failing output before the fix and passing output after.

If the stack must be running for the evidence and the notes declare `## Local stack`, either bring it up yourself
first (`skill://mate-stacks`) or tell crew in the Spec to use the declared commands. Then mark the task active:

    bin/mate task start T<n>

## 5. Spawn crew

Pick the agent from the routing table:

| Work | agent | effort |
|---|---|---|
| find/read/map code, investigations | `scout` (read-only) | lo/med |
| mechanical edits, renames, data collection | `sonic` | lo |
| normal implementation | `task` (default; omit agent) | med |
| ambiguous design / hard bugs | `task` | hi |
| review of a diff | `reviewer` | med |
| prove UI/CLI behaviour | `qa-tester` | med |

- Work in different projects fans out in parallel in a single `task` call.
- Several crew on the same project in parallel is allowed, even in the same files. Give each its own task id.
- The brief is the whole context; crew cannot see this conversation.

## 6. Verify evidence

Crew must have actually run the project's tests or a smoke check and pasted the output. Mate checks it:

- The command shown matches the project's real test/smoke command (from notes or the project's AGENTS.md).
- The output shows a pass, not a skipped or truncated run.
- Every acceptance line has its proof: log excerpt and URL result for UI/API work, screenshot paths for UI changes
  (open them), failing-then-passing output for bug fixes. A proof line marked "could not run" is a gap, not a pass.
- Crew stayed on the fixed branch and stopped at any OTP or captcha instead of working around it.
- The diff stays within what the task needed, plus anything the crew explicitly justified.

Missing or failing evidence: send the crew back (or spawn a follow-up) before committing. Never commit unverified work.
If the result needs a decision from Malik, `bin/mate task hold T<n> --question "..."` and tell him.

## 7. Land and close

Default delivery (Malik's standing choice) is a commit on the working branch, never pushed:

    bin/mate commit <project> -m "<message>" -- <paths the crew changed...>
    bin/mate task done T<n> --commit <sha> --note "<one line>"

Only the paths this task changed are staged. `bin/mate commit` refuses when the clone is not on the project's fixed
branch; never switch branches to get past it, ask Malik. Pushing, PRs, other delivery modes (pr, no-mistakes), and
branching are in `skill://mate-deliver`; releases are in `skill://mate-release`, only on Malik's word.

## 8. Report to Malik

Outcome first, in plain words: what changed, which project, commit sha, what evidence passed. No internal jargon
(brief, tick, digest). Full URLs if any PR exists.
