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
    bin/toli push <project> [--task T<n>]              # git push -u origin <current branch>; never forced
    bin/toli pr create <project> --title <t> (--body <b> | --body-file <f>) [--base <b>] [--draft] [--task T<n>]
    bin/toli pr status <project> [<id>] [--task T<n>] [--json]   # state, mergeable, CI/pipeline, URL
    bin/toli pr list <project> [--json]
    bin/toli pr merge <project> <id> [--method merge|squash|rebase]

`push` refuses a detached HEAD. `pr create` refuses until the current branch is on origin and contains local HEAD,
then prints the PR/MR URL. `--task` runs the command in the task's workspace.

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
