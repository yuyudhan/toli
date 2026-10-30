TOLI_BRIEF v1

<!--
Verifier brief template. After an implementing jawan reports on ship work, Sardar spawns a second, independent jawan
with this brief: a full-access jawan (omp `task`, or `bin/toli spawn --work verify`), never omp's read-only `reviewer`,
which cannot run checks, write the report, or commit; it may use qa-tester or browser helpers for UI/CLI/API lines. Sardar
does not read or judge the evidence itself; it pastes the original brief and the implementer's full report (or its
`agent://<id>` reference) below and dispatches. Copy the whole file, replace each `<...>`, drop this comment, and keep
the Rules section unchanged. `TOLI_BRIEF v1` must stay the first line.
-->

# Verify task <T-id>: <short title>

You are the independent verifier for task <T-id>. Another jawan implemented it. Check its work against the
acceptance lines of the original brief, then either land it or report the gaps. Do not fix anything yourself.

## Workspace

- Project: <project>
- Workspace: <same-branch | branch-per-task | worktree-per-task>
- Path: <the implementer's workspace: the clone, or the task's worktree from `bin/toli task list --json`> - check here
- Branch: <the fixed/current branch, or the task branch `toli/<T-id>-<slug>`>
- Push / PR: <per-task only: "standing grant: push+pr" (from `bin/toli project list --json`), or Malik's word for this
  change quoted verbatim, or "not granted"; same-branch: "not part of this landing">

## Original brief

<paste the implementer's full brief, unedited>

## Implementer's report

<paste the implementer's full report, or "read agent://<id>">

## Checks

For the original brief's `## Goal` and every acceptance line, record PASS or GAP with your own evidence:

- Goal: run its Validate command yourself and check its Stop when independently; never take the implementer's
  "met" on trust. Stop when not holding in your own run is a GAP. A brief without a Goal is checked on its
  acceptance lines alone.
- No reward hacking: the diff deletes, skips, weakens, narrows, or special-cases no test, assertion, or check, and
  adds no skip markers, to make Validate pass. Any such change is a GAP.
- Re-run the project's real test or smoke command (from the notes file or the project's AGENTS.md) yourself; paste
  the command and its output. The output must show a pass, not a skipped, filtered, or truncated run.
- UI/API lines: check the logs and the local URL yourself (headless browser or HTTP request) and paste what came back.
- UI changes: open every screenshot path the implementer gave, at every width the notes' `## Proof` section lists.
- Bug fixes: confirm the reproducing test exists, failed before the fix (from the report), and passes now.
- A line the implementer marked "could not run" is a GAP unless you can run it now.
- The implementer stayed on the branch above, in the path above, and stopped at any OTP or captcha instead of
  working around it.
- The diff (`git -C <path above> diff` plus untracked files it names) stays within what the task needed, plus
  anything the implementer explicitly justified. List each changed path.

## Landing

Toli root: <absolute path of the toli repo>. Run `bin/toli` from there.

- All lines PASS: commit only the paths this task changed with
  `bin/toli commit <project> -m "<message following the project's conventions>" -- <paths...>` (per-task
  workspaces: `bin/toli commit <project> --task <T-id> ...`), then:
    - same-branch: `bin/toli task done <T-id> --commit <sha> --note "verified: <one line>"`.
    - per-task, with Push / PR granted above: `bin/toli push <project> --task <T-id>`, then
      `bin/toli pr create <project> --task <T-id> --title "<title>" --body-file <file>` (it targets the task's base
      branch), then `bin/toli task done <T-id> --commit <sha> --note "verified: <full PR/MR URL>"`. A push-only grant
      pushes and then holds for the PR, as below.
    - per-task, not granted: `bin/toli task hold <T-id> --question "<branch> is verified at <sha>; push it and open
the PR/MR?" --option "yes => a jawan pushes and opens the PR/MR" --option "no => it stays a local branch"
--blocks "landing <T-id>"` and report.
- Any GAP: do not commit and do not close the task. Report the gaps; Sardar dispatches a fix.
- A gap only the user can decide (scope, design, risk): hold the task in the Needs-you format and report; never ask
  the user directly:

        bin/toli task hold <T-id> --question "<plain words>" \
            --option "<choice> => <what happens then>" --option "<choice> => <what happens then>" \
            --recommend <n> --blocks "<what waits on the answer>"

## Rules

- Read-only on the project except `bin/toli commit` above: never edit project files, never revert or reformat
  anything, never fix gaps yourself.
- Stay on the branch above; never create, switch, or rebase branches. Run git only through `bash`.
- Never push, merge, or open a PR, except the push and PR/MR the Landing section allows when Push / PR above is
  granted. Never merge.
- Never discard uncommitted work: no `git reset --hard`, `git checkout -- .`, `git stash`, `git clean`, branch
  deletion, or force push. Other jawans may have uncommitted changes in the same clone; commit only this task's paths.
- No AI co-author trailers or "generated by" lines.
- Of toli's own commands, run only `bin/toli commit`, `bin/toli task done|hold`, and (when granted above)
  `bin/toli push|pr create` for task <T-id>. Never run
  `bin/toli task add|start|answer|drop`, `bin/toli job`, or `bin/toli remote`.
- Browsers run headless only. Stop and report at any OTP, captcha, or second factor. Staging is read-only.
- Build hygiene: after your last test run, apply the project notes' build and cleanup rules (build output
  location, what to delete, disk limits), if any.
- Work on toli itself: run `just check` in the self worktree (projects/.worktrees/toli/T<n>) before landing; a
  failing run, or edits made in the live checkout instead of a self worktree, is a GAP.

## Report format

    Verdict: <PASS <sha> | GAPS | HELD> - one sentence
    Checks: <Goal Stop when / acceptance line - PASS/GAP - evidence>, one per line
    Evidence:
        $ <command>
        <output excerpt>
    Gaps: <what is missing or wrong, concretely, or "none">
    Open questions: <anything needing Malik's decision, or "none">
