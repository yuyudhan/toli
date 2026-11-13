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
  task has its own `toli/<T-id>-<slug>` branch, and landing means pushing that branch and opening its PR/MR. A
  per-task strategy moves a `commit`-mode project to `pr`.

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
    bin/toli push <project> [--task T<n>] [--gate "<recipe>" [--gate-wait <minutes>]] [--by <machine>] [--for T<n>] [--word "<owner's word>"]
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
    bin/toli push <project> --gate "just verify all"

- `gate run` works in the same checkout as `push` and keys the result on the tree of its HEAD commit and the exact
  recipe text, so an amended, rebased or empty commit that holds the same files shares the result. The record and the
  full output live in `state/gates/<project>/`; every decision (skip, attach, start, stall, outcome, proof use) is
  also one line in `logs/gates.log`.
- Already passed on this tree: it says so (`already passed at <sha> on tree <tree> ...; skipping the re-run`) and exits 0
  without running. A failed, stalled or killed gate is never reused: the next `gate run` runs it again.
- Already running on this tree (another jawan or hook started it): it waits for that run and exits with its result.
  It never starts a second copy.
- Otherwise it starts the gate in a background runner of its own, then waits for it. The runner outlives whoever
  started it: a jawan ending, a hook being killed, Ctrl-C or a dropped ssh session leave the gate running, and the
  next `gate run` (or `gate check`) picks up its result.
- A gate has no time limit. It is stopped only when it makes no progress for `--stall` minutes (default
  `capacity.gateStallMinutes` in `config/machine.json`, 30 when unset): its log did not grow, its checkout did not
  change and its processes burned under 10 CPU seconds, the same check that finds a stuck jawan run. It is then
  recorded `stalled` with the reason, once all its processes are gone: SIGTERM first, SIGKILL after 10 seconds to
  any that outlive it (a child ignoring SIGTERM after its shell died). A gate that keeps printing, or keeps working
  silently (a build linking for half an hour before any test prints), runs as long as it needs; a hung one (no
  output, no CPU) is stopped.
- A checkout that is not exactly its commit (changed tracked files, or untracked files that are not ignored) is
  refused: the result would not belong to any commit. A pass also counts only if the checkout is still exactly that
  commit when the gate ends; if HEAD moved or files changed while it ran, it is recorded `failed` with the reason.
- The runner runs the recipe in one of the machine's heavy-build slots, waiting for one while all are busy, with
  `CARGO_BUILD_JOBS`, `RUST_TEST_THREADS` and `NEXTEST_TEST_THREADS` at one slot's share of the cores
  ([fleet.md](fleet.md#heavy-build-slots)), so a recipe that calls cargo directly (through `just`, without toli's
  cargo shim) cannot take every core. A live-stack project's gate skips the slot, still at one slot's share.
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
- A pass is sealed with an HMAC over its project, tree, recipe text and end time, keyed by `state/gate-key` (made once
  per installation, owner-only). Only the gate runner writes it, and `gate run` and `gate check` count a record only
  when its proof verifies for the tree and recipe asked about: a record edited to say `passed`, copied to another
  tree's file, or invented gets a `forged` line in `logs/gates.log` and is ignored. A hook must therefore ask
  `gate check`; reading `TOLI_GATE_*` (which anyone can set) proves nothing. Records made before the tree key
  (named by commit sha, no proof) are never reused; each gate runs once more. A key that is a symlink, owned by
  another user or readable by group or others is refused (`gate check` fails, a finished run is recorded `failed`):
  delete it and the next gate makes a fresh one.

A project whose own pre-push hook runs the same long check can skip it when toli already passed it on the tree it is
about to push. Put this at the top of the hook, before the check (`project` is the project's toli name, `toli` the
path to toli's `bin/toli`, and the recipe the exact text given to `gate run` / `push --gate`):

```sh
toli=/path/to/toli/bin/toli
if [ -x "$toli" ] && "$toli" gate check <project> --recipe "just verify all" >/dev/null 2>&1; then
    echo "pre-push: just verify all already passed on this tree (bin/toli gate); skipping it"
    exit 0
fi
```

The hook keeps working outside toli: without `bin/toli` (or with a failed check) it falls through to the full check.
`gate check` without `--sha` also requires the checkout to be exactly HEAD, since the hook tests the working tree;
a changed or untracked file, or a tree that never passed, runs the check in full. A hook that decides per pushed ref
(git's stdin lines) passes `--sha <local sha>`, which names that commit's tree and ignores the checkout, as toli's own
hook does. A passing check logs one `proof` line (recipe, tree, the commit it passed at, the proof's first 12 hex
digits) in `logs/gates.log`, so every skipped re-run can be traced to a gate that really ran.

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
