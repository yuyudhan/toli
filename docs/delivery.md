# Delivery: how work lands

Every project records how finished work lands. The lead asks when the project is registered
([projects.md](projects.md#registering-a-project)); `/setup-project` asks again for a project that never answered.
Whatever the mode, the default is safe: commit, and stop there.

## Who lands the work

For ship work the implementing jawan never commits. A second, independent **verifier** jawan
([verify-brief-template.md](verify-brief-template.md)) checks the implementer's evidence against the acceptance lines,
re-runs the checks, then commits with `bin/toli commit` and closes the task, or reports the gaps and the lead sends
a fix. Pushes, PRs, merges, and tags are carried out by a jawan whose brief quotes your word for that specific
action.

    bin/toli commit <project> [--task T<n>] -m "<message>" -- <path>...

`bin/toli commit` stages only the named paths (parallel jawans on one project never commit each other's work),
strips AI co-author trailers, and refuses on the wrong branch.

## Delivery modes

| Choice                                  | `bin/toli project set <name> ...`   | What jawans do                                            |
| --------------------------------------- | ----------------------------------- | --------------------------------------------------------- |
| (a) pull/merge requests                 | `--mode pr --branch none`           | branch per change, commit, then push + PR on your word    |
| (b) commit on the checked-out branch    | `--mode commit --branch none`       | commit on whatever branch the clone is on; never push     |
| (c) commit on a fixed branch            | `--mode commit --branch <b>`        | commit only on `<b>`; `bin/toli commit` refuses elsewhere |
| (a) or (c) through the no-mistakes gate | `--mode no-mistakes [--branch <b>]` | the gate validates, pushes, and opens the PR on your word |

- A fixed branch (`--branch`) also makes `bin/toli digest` flag a clone that is on another branch. The lead switches
  or creates branches only on your word.
- `project set <p> --branch <b>` also switches the clone (or linked checkout) to `<b>`: `git switch <b>`, or a new
  local branch tracking `origin/<b>` when only origin has it (from the refs already fetched; it never fetches). It
  leaves the clone where it is when the clone has uncommitted changes, a live task holds it on its task branch, `<b>`
  exists neither locally nor on origin, or `git switch` fails. Then it says why and prints the command to run
  (`git -C <clone> switch <b>`, or the fetch/create commands for a missing branch). Either way `<b>` stays recorded,
  so `digest` flags the mismatch until the clone is switched.
- `--mode` or `--branch` records when the choice was made (`deliverySetAt` in `project list --json`). A project
  without it only has the default (`commit`, no fixed branch), and `project setup` asks for a real answer.
- The mode chooses the path; it is never permission. Pushing, opening a PR, merging, and releasing still need your
  word for each change, except under a standing grant.
- With a per-task [workspace strategy](projects.md#workspace-strategy) (`branch-per-task`, `worktree-per-task`) each
  task has its own task branch (`toli/<machine>/<T-id>-<slug>`, or the project's `--task-branch` pattern). Under
  `pr` or `no-mistakes` landing means pushing that branch and opening its PR/MR; under `commit` it means pushing the
  branch for the machine that cuts releases to merge. A strategy never changes the mode.

## Standing grants

By default the verifier commits and then holds the task with the question "push and open the PR?". If you want a
project's task branches pushed and their PRs/MRs opened without asking each time, grant it once, explicitly:

    bin/toli project set <p> --standing-push yes --standing-pr yes

A PR grant needs the push grant. Grants are set only on your word and are shown as `standing` in
`bin/toli project list --json`. Merging and releasing are never covered by a grant.

## Forges, push, and pull requests

GitHub (`gh`), GitLab (`glab`, gitlab.com or self-hosted), and Bitbucket Cloud (REST API) are detected from the
clone's `origin` URL. For an ssh endpoint such as `git@gitlab-ssh.<host>:group/repo.git`, the GitLab host comes from
glab's config (the host whose `ssh_host` matches). Override only when detection fails:
`bin/toli project set <p> --forge github|gitlab|bitbucket --forge-host <host>` (`none` clears either).

Credentials: `gh` logged in for GitHub; `glab` logged in to each GitLab host in use; for Bitbucket Cloud,
`BITBUCKET_EMAIL` (the Atlassian account email, not the Bitbucket username) and `BITBUCKET_API_TOKEN` (an Atlassian
API token with Bitbucket scopes), each from the environment or else the gitignored `.env` in toli's root. Instead of
`BITBUCKET_API_TOKEN`, the token may be the bitbucket.org password in the git credential helper; the REST API still
needs `BITBUCKET_EMAIL` unless the helper's username is the email. `BITBUCKET_USERNAME` is not used. A 401 from
Bitbucket prints where the credentials came from and what to set. `bin/toli doctor` and `bin/toli forge <p>` check
them.

    bin/toli forge <project> [--json]                  # forge, host, repo path, CLI/credential readiness
    bin/toli branch <project> <branch>                 # create a new work branch in the clone and switch to it
    bin/toli push <project> [--task T<n>] [--tag <name> | --gate "<recipe>" [--gate-wait <minutes>]] [--by <machine>] [--for T<n>] [--word "<owner's word>"]
                                                       # git push -u origin <current branch>; never forced; logged in
                                                       # data/pushes.jsonl, shown in bin/toli digest
    bin/toli push-log add <project> [--by <machine>] [--for T<n>] [--word "..."]   # log a raw git push made here
    bin/toli push-log list [--json]
    bin/toli pr create <project> --title <t> (--body <b> | --body-file <f>) [--base <b>] [--draft] [--task T<n>]
    bin/toli pr status <project> [<id>] [--task T<n>] [--json]   # state, mergeable, CI/pipeline, URL
    bin/toli pr list <project> [--json]
    bin/toli pr merge <project> <id> [--method merge|squash|rebase]

`push` refuses without `--word` (the user's word for this push, quoted) unless the project has a standing push grant
on the machine whose clone pushes (`bin/toli project set <p> --standing-push yes` there); nothing is pushed. It also
refuses a detached HEAD. `pr create` refuses until the current branch is on origin and contains local HEAD, then prints
the PR/MR URL. `--task` runs the command in the task's workspace.

## Gates: long checks run once per tree

A gate is a project's long verification command, such as `just verify all`, that must pass before a push. It can
take hours, so toli runs it at most once per tree (the git tree of the commit: the exact files, whatever the commit's
parents, message or author):

    bin/toli gate run <project> [--task T<n>] --recipe "just verify all" [--stall <minutes>] [--json]
    bin/toli gate check <project> [--task T<n>] [--sha <commit>] --recipe "just verify all" [--json]
    bin/toli gate status <project> [--json]
    bin/toli gate stop <sha|id>
    bin/toli push <project> --gate "just verify all"

- `gate run` works in the same checkout as `push` and keys the result on the tree of its HEAD commit and the exact
  recipe text, so an amended, rebased or empty commit that holds the same files shares the result. The record and the
  full output live in `state/gates/<project>/`; every decision (skip, attach, start, stall, outcome, proof use) is
  also one line in `logs/gates.log`.
- Already passed on this tree: it says so (`already passed at <sha> on tree <tree> ...; skipping the re-run`) and exits 0
  without running. A failed, stalled or killed gate is never reused: the next `gate run` runs it again.
- Already running on this tree (another jawan or hook started it): it waits for that run and exits with its result.
  It never starts a second copy.
- Otherwise it starts the gate in a background runner of its own, then waits for it. The record lists every process
  waiting on the gate (`callers`: each `gate run` or `push --gate` that started or joined it, by pid and start time).
  The runner outlives a caller that comes back: a hook being killed, Ctrl-C or a dropped ssh session leave the gate
  running, and a `gate run` (or `push --gate`) within a minute joins it, as `gate check` later reads its result. Once
  every caller has been gone for a minute, nothing waits on the gate any more (a cancelled push, a push that landed
  another way), so the runner stops it rather than hold a heavy-build slot for nobody: waiting in line, it leaves the
  line and its recipe never runs; running, its recipe's whole process group and every process it started get SIGTERM,
  then SIGKILL after 10 seconds, and the slot is free. The gate is recorded `killed` with the reason (`nothing waits
on it any more: ... is gone`), and a `callers-gone` line goes to `logs/gates.log`. A caller is known by its pid and
  start time, so a pid the system has since handed to another process does not keep the gate alive, and a caller is
  never signalled. A jawan ending is a second case, below.
- A gate has no fixed time limit. It is stopped when it makes no progress for `--stall` minutes (default
  `capacity.gateStallMinutes` in `config/machine.json`, 30 when unset): its log did not grow, its checkout did not
  change and its processes burned under 10 CPU seconds, the same check that finds a stuck jawan run. It is then
  recorded `stalled` with the reason, once all its processes are gone: SIGTERM first, SIGKILL after 10 seconds to
  any that outlive it (a child ignoring SIGTERM after its shell died). A gate that keeps printing, or keeps working
  silently (a build linking for half an hour before any test prints), runs as long as it needs; a hung one (no
  output, no CPU) is stopped.
- A runaway gate is stopped the same way and recorded `runaway`, with the reason, instead of being left to finish. Both
  decisions are `runaway` lines in `logs/gates.log`, and neither counts time waiting for a heavy-build slot: not the
  wait before the recipe starts, nor, in a project set `--slot-at-heavy-step yes`, the time its first heavy step waits
  in line partway through (the record's `slotWaitMs`; `recipeMs`, which the estimate is the median of, leaves it out).
- Runaway on time: the recipe has run over 3 times its estimate and then printed nothing for 5 minutes. The estimate is
  the median time of the recipe's last 5 passes in that project (`estimateMs` in the record; at least one minute; a
  recipe that never passed has no estimate). A recipe that grew past 3 times but keeps printing is never stopped on
  time: it passes, and its time joins the median, so the estimate catches up within a few passes. To start the
  estimate afresh at once, remove the recipe's passed records (`state/gates/<project>/*-<recipe hash>.json`, the hash
  being the last part of the id `gate status` shows; it costs only the cached passes of other trees) or change the
  recipe's text, which makes it a new recipe without passes.
- Runaway on failures: the gate has printed failure lines for 30 minutes, none more than 10 minutes apart. A failure
  line is one a test runner or compiler prints, anchored where it prints it: a per-test failure (Vitest/Jest
  `FAIL <file>` or `× <test>`, nextest `FAIL [<time>] <test>`, cargo `test <name> ... FAILED`, pytest
  `FAILED <file>::<test>`, bun `(fail) <test>`), a final summary with a nonzero count (`test result: FAILED.`,
  `Tests  <n> failed`, `Tests: <n> failed`, `=== <n> failed ... ===`, Playwright's `<n> failed`), or a compile error
  (`error[E<n>]:`, `<file>(<line>,<col>): error TS<n>:`). Retried attempts (`(retry ...)`, nextest `TRY <n> FAIL`,
  `FLAKY`), expected failures (pytest `XFAIL`), `FAIL` inside a word and counts in free text never count; a log with no
  such line is never stopped for failing.
- A gate started by a `bin/toli spawn` jawan belongs to that jawan: the record lists the runs that started or joined
  it (`owners`). When the last of them ends (it finished, failed, was killed with `bin/toli run kill`, or its session
  ended) and no run continues it (an automatic resume after a stall, time limit or network fault, or the run that
  replaced it with `spawn --replace`; a later `bin/toli resume` comes too late to keep it), nobody waits on the gate
  any more, so toli stops its runner and every process the runner started: SIGTERM, then SIGKILL after 20 seconds.
  Before it signals anything it re-reads the record under its lock: if a jawan joined the gate since, it leaves the
  gate running; otherwise it marks it `stopping` in that same write. A `gate run` that finds a `stopping` gate never
  joins it: it says so, waits for it to end and then starts its own. It records the gate `killed` with the reason
  (`stopped by toli: its jawan (<run>) ended`), writes a `stopped` line in `logs/gates.log` and a line in the run's log.
  The run's supervisor does this as the run ends; the minute tick catches a run whose supervisor died. A gate anyone
  else started or joined (a person, the lead, a hook outside a jawan) has no owners and is never stopped this way.
- toli signals a recorded runner only while its pid still is that runner: the same pid, started when the record says
  (`pidStartedAt`), running `gate runner <its record>`. A pid the system has since handed to another process is never
  signalled; the record is then marked `killed` (its runner is gone), so nothing attaches to it.
- `gate stop <sha|id>` stops one such gate by hand: a running gate named by its id (the last column of `gate status`)
  or a prefix of its commit or tree. It stops only a runner toli recorded that nothing needs any more: one whose
  jawans are all gone, the way the supervisor would, or one whose callers are all gone, at once rather than after the
  runner's minute (the way to cancel a gate: stop its push or `gate run`, then `gate stop`). It refuses, changing
  nothing, a gate a live jawan owns (naming the run and its task) or a live caller waits on (naming its pid), a gate no
  jawan owns whose callers were never recorded (an older record), and a selector that matches no running gate or
  several. It is for toli's own recorded runners only; every other process stays under hard rule 2 of AGENTS.md.
- A checkout that is not exactly its commit (changed tracked files, or untracked files that are not ignored) is
  refused: the result would not belong to any commit. A pass also counts only if the checkout is still exactly that
  commit when the gate ends; if HEAD moved or files changed while it ran, it is recorded `failed` with the reason.
- The runner runs the recipe in one of the machine's heavy-build slots, waiting for one while all are busy, with
  `CARGO_BUILD_JOBS` and the test harnesses' worker variables (`RUST_TEST_THREADS`, `NEXTEST_TEST_THREADS`,
  Vitest's) at one slot's share of the cores ([fleet.md](fleet.md#heavy-build-slots)), so a recipe that calls cargo
  or Vitest directly (through `just`, without toli's cargo shim) cannot take every core. A live-stack project's gate
  skips the slot, still at one slot's share, and pauses the project's stack auto-rebuild while it runs
  ([projects.md](projects.md#pausing-the-stack-during-a-build)).
- `push --gate "<recipe>"` runs the gate this way first and pushes only if it passed on HEAD's tree. In a shared
  same-branch clone the checkout differs from HEAD whenever another jawan has an edit it has not committed yet, and a
  gate run on that tree proves nothing about the commit: a pushed file may lean on an edit that is not in it (a new
  function, a fixed test), and the pass would still be recorded for HEAD's tree. Checking only whether the dirty
  paths overlap the pushed commit's files cannot catch that, and running the gate on a copy of HEAD would need a
  second checkout. So the push waits instead: it re-reads the checkout every few seconds for up to `--gate-wait`
  minutes (default 30; 0 refuses at once, as `gate run` always does) until every edit is committed and the checkout is
  exactly HEAD again, then runs the gate; when HEAD or the checkout changes under a run, it waits and runs it again on
  the new tree. At the end of the wait it refuses, naming the paths. The push's hooks
  see `TOLI_GATE_PROJECT`, `TOLI_GATE_SHA`, `TOLI_GATE_TREE` and `TOLI_GATE_RECIPE`: information, not proof. In a
  project with a pre-push hook, `bin/toli push` (with or without `--gate`) runs `git push` in one heavy-build slot the
  same way, since the hook may run the long check itself; a `bin/toli gate run` the hook starts runs inside that slot.
  A hook with an escape hatch that skips its heavy steps declares it in a comment line, one per condition:
  `# toli-light-push: VERIFY_SKIP=1`. A push whose environment meets one (`VERIFY_SKIP=1 bin/toli push <p>`) prints
  `toli: the pre-push hook declares no heavy step with VERIFY_SKIP=1: pushing without a heavy-build slot` and never
  queues for a slot; every other push keeps its slot. The declaration is the project's word about its own hook, so
  keep it next to the check it names. A hook whose only heavy steps are gates it guards with `gate check` (below)
  declares their recipes instead, one per line: `# toli-light-push-after-gate: <recipe>`, the recipe's exact text.
  Before queueing, `bin/toli push` looks for a sealed pass of each on the tree of HEAD. When every one has one it
  says so (`toli: the pre-push hook <path> declares no heavy step once its gate passed, ...`), pushes exactly that
  commit's sha (setting the upstream as `-u` would) and runs the hook, every step of it, without a slot. A missing or
  stale pass prints `toli: the pre-push hook takes a heavy-build slot: no sealed pass of <recipe> on tree ...` and
  the push takes its slot as before. toli's own hook declares `bun run check` (its working-tree fallback takes a slot
  itself). A hook whose sealed-pass check is more than one recipe's pass (one of several recipes, chosen by what the
  push carries) runs every heavy step through `bin/toli build-slot --` and declares `# toli-push-slot-at-heavy-step`
  instead: `bin/toli push` (branch or tag) runs it without a slot, saying
  `toli: the pre-push hook <path> takes a heavy-build slot only at its first heavy step, if it reaches one`, so a
  hook that takes the sealed pass ends without queueing and one that runs its gate takes a slot at that step and
  holds it to the push's end (T2408). A project
  whose gate recipes and hook run their heavy steps through `bin/toli build-slot --` sets
  `project set <p> --slot-at-heavy-step yes`: its gates and pushes then run their cheap steps without a slot and take
  one at the first heavy step, holding it to the end ([fleet.md](fleet.md#heavy-build-slots)).
- A pass is sealed with an HMAC over its project, tree, recipe text and end time, keyed by `state/gate-key` (made once
  per installation, owner-only). Only the gate runner writes it, and `gate run` and `gate check` count a record only
  when its proof verifies for the tree and recipe asked about: a record edited to say `passed`, copied to another
  tree's file, or invented gets a `forged` line in `logs/gates.log` and is ignored. A hook must therefore ask
  `gate check`; reading `TOLI_GATE_*` (which anyone can set) proves nothing. Records made before the tree key
  (named by commit sha, no proof) are never reused; each gate runs once more. A key that is a symlink, owned by
  another user or readable by group or others is refused (`gate check` fails, a finished run is recorded `failed`):
  delete it and the next gate makes a fresh one.
- `push --gate "<recipe>"` skips a pre-push hook that would only repeat the gate it just passed. When the active
  hook is a plain shell script whose one command (comments, blank lines, `set` options and an `exec` prefix aside)
  is exactly the recipe's text, toli skips it itself, but only after checking, right before the push, that HEAD is
  still the gated commit, the checkout is exactly HEAD (no changed or untracked files) and a sealed pass of that
  recipe exists for HEAD's tree. It then pushes that commit's sha (not the branch, which could move meanwhile) with
  `git push --no-verify`, sets the branch's upstream as `-u` would, prints `push: skipping the pre-push hook <path>:
it runs only <recipe>, which passed on <sha> (tree ..., proof ...)` and logs a `hook-skip` line in
  `logs/gates.log`. Otherwise it prints
  `push: running the pre-push hook: <why>` and the hook runs as usual: a hook that does more than the gate (a secret
  scan, a second check), runs another command, is not a shell script, or comes through a hook manager, a moved HEAD,
  a dirty checkout, or no sealed pass. A failed gate pushes nothing, so the hook never runs. For a hook that is not
  only the gate, the reason also says what happens to its gate step: when the hook asks `gate check`, it is skipped
  where the hook asks `bin/toli gate check <project> --sha <pushed sha> --recipe "<recipe>"`; when it never asks, the
  reason says `so a gate step in it reruns` and names that guard.
- `push <p> --tag <name>` pushes one local tag and nothing else: the object the tag names now, to origin's
  `refs/tags/<name>`, never `--tags`, never forced (a tag origin already holds is left alone; one it holds at another
  object is refused, since a pushed tag is never moved). It runs no gate (`--gate` beside it is refused): gate the
  commit before tagging it. A release tag usually lands on a tree the gate already passed, the gated release commit or
  a merge of exactly it, and a hook that runs the project's full check on every tag would rerun hours of checks on
  that tree. So a hook declares the gate recipes that are everything it checks on a push of tags alone, one per line:
  `# toli-tag-push-after-gate: <recipe>`, the recipe's exact text. When the push carries only tags, the hook declares
  at least one such recipe, and each has a sealed pass on the tree of the tagged commit, toli prints
  `push: skipping the pre-push hook <path>: the push carries only tags, and <recipe> on tree ... passed, ...`, logs a
  `hook-skip` line in `logs/gates.log` and pushes exactly that tag with `git push --no-verify`.
  Otherwise it prints `push: running the pre-push hook: <why>` (no declaration, a tree no gate passed on) and the hook
  runs as on a branch push: without a slot when it declares itself light, else in a heavy-build slot. The declaration
  is the project's word that its hook checks nothing else on a tag push, so a hook whose tag path also runs a secret
  scan or a tag-name check must not declare it. The push is recorded in the push log under `refs/tags/<name>`.

A project whose own pre-push hook runs the same long check skips that step, and only that step, when toli already
passed it on the trees the push lands; the hook's other steps (a secret scan, a quick lint) run on every push. toli
cannot skip part of a hook itself: it would have to rewrite or partly run the project's script, and only the hook
knows which of its steps is the gate. So the hook guards its gate step with `gate check`, which answers from the
sealed pass alone, whoever runs the push (`bin/toli push`, plain `git push`, another tool). git feeds the hook one
line per pushed ref (`<local ref> <local sha> <remote ref> <remote sha>`) on stdin, which the hook reads once; put
the guard around the check (`app` is the project's toli name, the recipe the exact text given to `gate run` /
`push --gate`):

```sh
refs=$(cat)
# ... the hook's other steps, which always run (they may read "$refs" too)
# bin/toli of the install this clone (<toli>/projects/app) or task worktree (<toli>/projects/.worktrees/app/<task>)
# belongs to: both share the clone's git directory, <toli>/projects/app/.git.
common="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)"
toli="${common%/projects/*}/bin/toli"
zero=0000000000000000000000000000000000000000
total=0
passed=0
while read -r _ sha _ _; do
    [ -n "$sha" ] || continue
    total=$((total + 1))
    if [ "$sha" = "$zero" ] ||
        { [ -x "$toli" ] && "$toli" gate check app --sha "$sha" --recipe "just verify all" >/dev/null 2>&1; }; then
        passed=$((passed + 1))
    fi
done <<EOF
$refs
EOF
if [ "$total" -gt 0 ] && [ "$passed" -eq "$total" ]; then
    echo "pre-push: just verify all already passed on every pushed tip (bin/toli gate); skipping it"
else
    just verify all
fi
```

The hook keeps working outside toli: without `bin/toli`, with no ref lines, or with a failed check it runs the full
check. A hook whose only step is the check may `exit 0` where this one skips it. Ask `gate check` with the exact
recipe text the push gates with (`push --gate "just verify push --piece"` is a different recipe from `just verify
push`), and find `bin/toli` through the git common directory as above, never from the checkout's own path
(`$(git rev-parse --show-toplevel)/../../bin/toli`): that path is right only in the clone, and in a task worktree it
names no toli, so every push from a worktree silently reruns the check. `--sha` names that commit's tree and ignores
the checkout. A pass on a ref's new tip covers the whole push of that ref, however many commits it carries (a fix and
a merge of main): the tip's tree is exactly what the branch holds after the push, and `push --gate` gates exactly that
tree. The commits between the remote's old sha and the tip are not checked one by one, by design; none of them is what
lands, and the gate passes only trees it ran on, so a hook that asks for a pass on every commit in the range reruns
the check for any push of two or more commits. A hook that checks the checkout instead (no stdin, no `--sha`) runs
`gate check <project> --recipe ...` without `--sha`, which also requires the checkout to be exactly HEAD: a changed
or untracked file, or a tree that never passed, runs the check in full. A passing check logs one `proof` line
(recipe, tree, the commit it passed at, the proof's first 12 hex digits) in `logs/gates.log`, so every skipped re-run
can be traced to a gate that really ran.

toli's own pre-push hook (`.githooks/pre-push`) works this way for `bun run check`: a pushed commit that already
passed is not checked again, and a checkout that is exactly the pushed commit runs the checks as a gate, so the
result is kept for that commit. Any other checkout (other agents' uncommitted work, or a pushed commit other than
HEAD) gets the checks on its working tree, as before, after the hook lists how it differs; that result is not
recorded, since it is not the pushed commit's. Exact-commit testing happens only when the checkout is clean or the
commit already passed, because no copy of the code is made.

## The no-mistakes gate

[no-mistakes](https://github.com/kunchenguid/no-mistakes) runs review, tests, docs, and lint over a branch before it
is pushed. toli uses it only when the project's mode is `no-mistakes` or you ask for a branch or PR through the gate
on a piece of work (or the project has a standing push+PR grant and a per-task strategy).

A jawan puts the work on a branch, the verifier commits, and a gate jawan drives the gate with a full intent written
from your own words. Review questions that clearly follow what you already agreed are settled by the gate jawan; only
the ones that widen scope, are unclear, destructive, or touch security come back to you. The gate runs omp as its
agent (`~/.no-mistakes/config.yaml`: `agent: acp:omp`, `omp: omp acp`). Policy: `.omp/skills/toli-nm`.

## Releasing a project

A project's release follows its own recipe in the `## Release` section of its notes
(`data/projects/<p>/notes.md`): integration branch, version rule, release notes, merge method, staging smoke,
issue-tracker updates. Without a section the lead asks you for the steps once and a jawan writes them down. Jawans
run it in two phases with your word in between: **prepare** (read-only on remotes) and **ship** (only the actions you
approved: merge, tag, push). Policy: `.omp/skills/toli-release`. Releasing toli itself: [releasing.md](releasing.md).
