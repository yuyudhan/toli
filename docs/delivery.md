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
`BITBUCKET_USERNAME` and `BITBUCKET_API_TOKEN` (environment or the gitignored `.env` in toli's root) or a
bitbucket.org login in the git credential helper. `bin/toli doctor` and `bin/toli forge <p>` check them.

    bin/toli forge <project> [--json]                  # forge, host, repo path, CLI/credential readiness
    bin/toli branch <project> <branch>                 # create a new work branch in the clone and switch to it
    bin/toli push <project> [--task T<n>] [--gate "<recipe>"] [--by <machine>] [--for T<n>] [--word "<owner's word>"]
                                                       # git push -u origin <current branch>; never forced; logged in
                                                       # data/pushes.jsonl, shown in bin/toli digest
    bin/toli push-log add <project> [--by <machine>] [--for T<n>] [--word "..."]   # log a raw git push made here
    bin/toli push-log list [--json]
    bin/toli pr create <project> --title <t> (--body <b> | --body-file <f>) [--base <b>] [--draft] [--task T<n>]
    bin/toli pr status <project> [<id>] [--task T<n>] [--json]   # state, mergeable, CI/pipeline, URL
    bin/toli pr list <project> [--json]
    bin/toli pr merge <project> <id> [--method merge|squash|rebase]

`push` refuses a detached HEAD. `pr create` refuses until the current branch is on origin and contains local HEAD,
then prints the PR/MR URL. `--task` runs the command in the task's workspace.

## Gates: long checks run once per commit

A gate is a project's long verification command, such as `just verify all`, that must pass before a push. It can
take hours, so toli runs it at most once per commit:

    bin/toli gate run <project> [--task T<n>] --recipe "just verify all" [--stall <minutes>] [--json]
    bin/toli gate check <project> [--task T<n>] [--sha <commit>] --recipe "just verify all" [--json]
    bin/toli gate status <project> [--json]
    bin/toli push <project> --gate "just verify all"

- `gate run` works in the same checkout as `push` and keys the result on its HEAD commit and the exact recipe text.
  The record and the full output live in `state/gates/<project>/`; every decision (skip, attach, start, stall,
  outcome) is also one line in `logs/gates.log`.
- Already passed at this commit: it says so (`already passed at <sha> ...; skipping the re-run`) and exits 0
  without running. A failed, stalled or killed gate is never reused: the next `gate run` runs it again.
- Already running at this commit (another jawan or hook started it): it waits for that run and exits with its result.
  It never starts a second copy.
- Otherwise it starts the gate in a background runner of its own, then waits for it. The runner outlives whoever
  started it: a jawan ending, a hook being killed, Ctrl-C or a dropped ssh session leave the gate running, and the
  next `gate run` (or `gate check`) picks up its result.
- A gate has no time limit. It is stopped only when it prints nothing for `--stall` minutes (default
  `capacity.gateStallMinutes` in `config/machine.json`, 30 when unset); it is then recorded `stalled` with the reason.
  A gate that keeps printing runs as long as it needs.
- A checkout that is not exactly its commit (changed tracked files, or untracked files that are not ignored) is
  refused: the result would not belong to any commit. A pass also counts only if the checkout is still exactly that
  commit when the gate ends; if HEAD moved or files changed while it ran, it is recorded `failed` with the reason.
- `push --gate "<recipe>"` runs the gate this way first and pushes only if it passed at HEAD. The push's hooks see
  `TOLI_GATE_SHA` and `TOLI_GATE_RECIPE`.

A project whose own pre-push hook runs the same long check can skip it when toli already passed it on that commit.
Put this at the top of the hook, before the check (`project` is the project's toli name, `toli` the path to toli's
`bin/toli`):

```sh
toli=/path/to/toli/bin/toli
if [ -x "$toli" ] && "$toli" gate check <project> --recipe "just verify all" >/dev/null 2>&1; then
    echo "pre-push: just verify all already passed on this commit (bin/toli gate); skipping it"
    exit 0
fi
```

Use `gate check`, not the `TOLI_GATE_*` variables alone, to decide: the check reads the recorded result for the
commit itself.

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
