# Projects

A project is a git repository the lead (Sardar) can dispatch jawans into. Each machine clones the projects it works on
into `projects/<name>/` and records them in `data/projects.json`; everything toli keeps about a project lives in one
directory, `data/projects/<name>/`.

## Registering a project

In the lead session:

    /add-project <name> <git-url | path> [machine]

Before anything is cloned, the lead asks one batched, multiple-choice question (full text in the `toli-projects`
skill): checkout (`clone` fresh, or `link <path>` to an existing checkout), workspace strategy (`same-branch
[<branch>]`, recommended, `branch`, or `worktree`; default from `defaults.workspace` in `config/machine.json`), PR or
MR (per-task strategies), the no-mistakes gate, the test/smoke command, and an optional standing push/PR grant. Reply
like `clone, same-branch, no, detect` or `link ~/code/shop, branch, mr, yes, bun test`.

With the answer, a jawan clones the repo (`bin/toli project add`) or links it (`bin/toli project link`), records the
choices (`bin/toli project set`), checks the forge and its auth (`bin/toli forge <name>`), and seeds
`data/projects/<name>/notes.md` from the repo's README, agent docs, and build files. Anything it cannot detect (an
unknown forge, no test command) comes back to the user as one follow-up question.

What each delivery choice means: [delivery.md](delivery.md).

Without a lead session, the same steps by hand:

    bin/toli project add <name> <git-url>        or   bin/toli project link <name> <path>
    bin/toli project set <name> --workspace same-branch --mode commit --branch main
    bin/toli project setup <name>

`bin/toli project link <name> <path>` registers a checkout the user already has: it checks it is a git repo,
reports its origin, forge and branch, and makes `projects/<name>` a symlink to it; `project drop --delete-clone`
removes only that symlink, never the checkout, and `project setup`/digest flag a link whose checkout moved.
`bin/toli project ensure <name> <git-url>` is the idempotent form used when work is sent to another machine;
`bin/toli project import` registers clones copied into `projects/` by hand.

## Workspace strategy

Each project records where its jawans work (`workspace` in `bin/toli project list`; asked at registration and by
`/setup-project`; new projects start on the machine default, `defaults.workspace` in `config/machine.json`, which is
`same-branch` when unset):

| Strategy            | Where jawans work                                                         | Landing                    |
| ------------------- | ------------------------------------------------------------------------- | -------------------------- |
| `same-branch`       | the one clone, on the project's (fixed or checked-out) branch             | per the delivery mode      |
| `branch-per-task`   | the one clone, switched to the task branch before the jawan starts        | task branch pushed + PR/MR |
| `worktree-per-task` | `projects/.worktrees/<project>/<T-id>`, a worktree on its own task branch | task branch pushed + PR/MR |

A task branch is `toli/<machine>/<T-id>-<slug>` by default: task ids are numbered per machine, so two machines
working one project each have a `T12`, and the machine part keeps their branches apart on the shared origin.
`bin/toli project set <name> --task-branch "<pattern>"` names them another way, from `<project>`, `<machine>`, `<id>`
(required) and `<slug>` around literal text (for example `shop/<machine>/<id>-<slug>`); `--task-branch none` goes
back to the default. A task keeps the branch it was prepared on.

Under `--mode pr` or `no-mistakes` a per-task strategy lands each task branch through a PR/MR. Under `--mode commit`
the task branch is committed and pushed (on the user's word or a standing push grant) for the machine that cuts the
project's releases to merge, with no PR/MR; setting a strategy never changes the mode.

`same-branch` is the recommended default: many jawans work in one clone at once, each `bin/toli commit` builds its
commit from the branch tip in a private index with only its own paths, and refuses when the branch moved twice, a
recent commit would be reverted, a lock file does not parse, or a secret is staged
([cli.md](cli.md#landing-work)). That scales to many fast parallel agents; a worktree per task does not (a full
checkout, dependency install and build per task, and merges at the end). `worktree-per-task` stays an opt-in for a
project whose owner wants a branch and PR/MR per task with tasks side by side; toli never picks it by default, and
toli itself never uses worktrees.

- `bin/toli spawn --task T<n>` prepares the workspace (or `bin/toli workspace prepare T<n>` for native subagents)
  and records it on the task; the brief carries the strategy, path, and branch, and the verifier reuses it.
  Task branches start from the base branch: the project's `--base-branch`, else its `--branch`, else origin's default
  branch (origin/HEAD, asked of origin when the clone has no record of it, else `main` or `master`; never the branch
  the clone happens to be checked out on), as origin has it: `git fetch origin <base>` runs first and the branch
  starts from `origin/<base>` with no upstream, so a clone whose own base is behind never seeds a stale task (without
  that ref on origin it starts from the local base, with a warning). A project whose fixed `--branch` is a per-machine
  nightly or release branch whose tasks should start from the mainline sets `--base-branch main`. A live task prepared
  under an earlier strategy keeps its recorded workspace when the project switches strategy; the new one applies to
  tasks prepared afterwards, and switching never touches the clone. A live task with no recorded workspace (dispatched
  before the switch) whose clone is checked out on a branch
  naming it (`T375` in `shop/m1/T375-e2e-proof`) keeps the clone: `workspace prepare`, `commit --task` and
  `push --task` record it as its workspace on that branch, unless another live task records the clone.
  Never toggle a project's strategy to land such a task: nothing needs it. A switch from a per-task strategy to
  `same-branch` while a live task still works in its per-task workspace counts as such a toggle: `project set` says
  so, and `workspace prepare` (so `spawn --task`) refuses every task without a workspace of its own until the project
  switches back, naming the command, since a task prepared then would be recorded on the shared clone for good. When
  the switch is meant to stay, on the user's word, `project set <p> --workspace same-branch --keep` ends the toggle
  and new tasks get the clone. `project set --workspace` waits for a `workspace prepare` in progress (they share the
  project's workspace lock), so a prepare never mixes the old strategy and the new one.
  `bin/toli workspace prepare T<n> --reset` re-derives a live task's workspace from the project's current strategy
  when it was recorded under another one; it refuses while the recorded task branch holds commits its base lacks or
  uncommitted changes, leaves the clone's files as they are, and removes a recorded worktree only when git finds it
  clean.
- `branch-per-task` refuses to switch the clone while another active or held task of the project uses it on a
  different branch, or while the clone has uncommitted changes; use `same-branch` for parallel tasks.
- On macOS, preparing a worktree excludes `projects/.worktrees/<project>/` from Spotlight (a `.metadata_never_index`
  file) and Time Machine (the sticky exclusion attribute `tmutil addexclusion` sets), so each worktree's `target/`,
  `node_modules/` and `dist/` are never indexed or backed up. A failed exclusion only warns.
- `bin/toli commit|push|pr create <project> --task T<n>` act in the task's workspace (commands run from inside a
  task worktree find it themselves). Per-task projects refuse a commit without `--task`.
- A release train on a per-task project: its one long-lived task works in the clone on the project's fixed
  `--branch` (a nightly or release branch) while every other task gets its own task branch.
  `bin/toli workspace prepare T<n> --same-branch` (on the user's word) pins that task to the clone, whatever the
  strategy and the task's status; spawn prepares it there, and `bin/toli commit <p> --task T<n>` commits there with
  the fixed-branch check. Pinning refuses while the task's own worktree or task branch holds unlanded work, and
  removes a clean worktree; `workspace prepare T<n> --reset` drops the pin. So the other tasks start from the
  mainline rather than the release branch, `bin/toli project set <p> --base-branch main` names the branch task
  branches start from and PR/MRs target (the name as on origin, never `origin/main`); `--base-branch none` goes back
  to `--branch`. A task keeps the base it was prepared from.
- Pushing the task branch and opening its PR/MR need the user's word for that change, unless the project carries an
  explicit standing grant ([delivery.md](delivery.md#standing-grants)). Without one, the verifier commits and holds
  the task with the question.
- `bin/toli workspace list [--project p]` shows each task worktree with its task status, branch, merged state and
  cleanliness. `bin/toli workspace prune [--project p]` removes worktrees of done/dropped tasks whose HEAD is
  reachable from the base (local or origin, fetched first) and that have no uncommitted or untracked (non-ignored)
  files, then deletes the task branch at that tip. It keeps live worktrees and never removes unlanded work, with no
  flag to override it: such a worktree prints `kept: <path>: N unlanded commits / M dirty files` and goes at a later
  prune once it is landed and clean. Squash-merged branches count as unlanded; land or remove them by hand, on the
  user's word.
- `bin/toli project set --all --workspace <s>` applies one strategy to every project; each keeps its mode.
- Pre-strategy projects keep their behaviour: `bin/toli migrate` records `branch-per-task` for `pr` and branchless
  `no-mistakes` projects, `same-branch` for the rest.

Examples:

    # blog: everyone on the one clone, committing on the fixed branch nightly
    bin/toli project set blog --workspace same-branch --mode commit --branch nightly

    # shop: a worktree and branch per task, published as a GitLab merge request; push/MR only on the user's word
    bin/toli project set shop --workspace worktree-per-task --mode pr --branch main --standing-push no --standing-pr no

For shop, `bin/toli spawn --task T42 ...` creates `projects/.worktrees/shop/T42` on
`toli/T42-<slug>` from `main`; after verification the verifier holds T42 asking to push and open the MR, and on the
user's word a jawan runs `bin/toli push shop --task T42 --word "<the user's word>"` and
`bin/toli pr create shop --task T42 ...`. Without `--word` or a standing push grant, `bin/toli push` refuses.

## Live-stack mode

A `same-branch` project whose dev stack rebuilds itself on save (a backend under a file watcher, a hot-reloading
frontend dev server) can run many jawans at once, 8 to 16 per machine, against that one running stack instead of each
jawan building and testing on its own:

    bin/toli project set app --live-stack yes      # --live-stack no turns it off

`live-stack=yes` shows in `bin/toli project list` (`liveStack` in `--json`). For such a project:

- The notes carry a `## Live stack mode` section with the exact start, logs and health commands (the stack runs as
  a long-lived service on each machine: detached, with a restart policy, so it outlives the session and comes back
  with the machine's container runtime after a reboot).
- Every code brief keeps the `## Live stack` section of [brief-template.md](brief-template.md): write code in the
  shared checkout, never run your own full build/test/lint while coding, commit only your own paths, follow the live
  logs and fix every compile or runtime error your change caused (other jawans' errors are theirs: tell them by agent
  message), and once the stack is green with your change in it, run your browser tests against it and your own scoped
  tests. The full check runs once per machine, at integration or before a push. `bin/toli spawn` warns when a
  live-stack project's code brief has no `## Live stack` section.
- Its spawned jawans run without the heavy-build slot shim (src/jawans/env.ts): the machine's one build is the
  stack's; their scoped test builds share the checkout's build folder, where cargo's own lock already runs them one
  at a time, still capped at `capacity.cargoJobs`. Its gates and pushes skip the slot too, at the same cap
  ([fleet.md](fleet.md#heavy-build-slots)), and every heavy build on the machine pauses the stack's auto-rebuild
  while it runs (below).
- The machine's jawan cap must fit the team: set `capacity.maxRuns` in `config/machine.json` to the number of
  jawans the machine runs at once (16 for 8-16 jawans; the default is a quarter of the cores, [fleet.md](fleet.md)).
  Spawns beyond it queue.

### Pausing the stack during a build

A heavy build anywhere on the machine (a gate, a push check, `bin/toli build-slot -- <command>`, a cargo through the
shim or the rustc wrapper, in this checkout or in any other project's) compiles beside the stack's own recompile, and
together they can take the machine far past its cores and memory. So while any such build runs, toli pauses the
auto-rebuild of every live-stack project's stack the way its notes declare, and resumes each when the last build on
the machine ends, whether it passed, failed, was stopped or timed out:

    ## Live stack mode
    - Start: `docker compose up -d`
    - Pause: `docker compose pause backend`
    - Resume: `docker compose unpause backend`

    ## Local stack
    - Pause during builds: app-frontend
    - Stop during builds: app-backend

`- Pause:` and `- Resume:` (in `## Live stack mode`, each command in backticks, both or neither) run with `sh -c` in
the checkout; the `## Local stack` `- Pause during builds:` containers are paused with `docker pause`, and the
`- Stop during builds:` ones stopped with `docker stop` and started again with `docker start`. Any of them may be
declared. A paused container keeps its memory, which a build near its memory cap may need: stop the ones that hold
much (a dev server, a backend under its watcher); a container named on both lines is stopped. Name only the services
that rebuild, never a database: toli touches only the containers named, and never removes one. With nothing declared
the builds run beside the rebuilds, and toli says so once (`toli: <project>: live-stack mode, but its notes declare
no way to pause its stack ...`).

Several builds count as one pause: the first pauses, the last resumes, each counted by its pid in
`state/build-slots/live-<project>.json`, which also keeps the resume command and the paused and stopped containers,
so a resume never needs the notes. A build killed outright (SIGKILL, a crash) cannot resume: the next build's end,
any freed slot or the minute tick sees its pid gone and resumes the stack. A failed pause is warned about and the
build runs anyway; a failed resume prints the command that fixes it and is retried at those same moments.

A command in this checkout that is not cargo (browser tests through `bin/toli build-slot`, a gate or push check) uses
the stack, so toli keeps it running for that command: it resumes the stack if another build paused it, and no build
pauses it until the command ends ([fleet.md](fleet.md#dev-stacks-and-heavy-builds)).

## Dev stacks that rebuild on save

A project that is not in live-stack mode can still have a dev container that recompiles on every save. Left alone it
competes with the heavy builds that hold a build slot (a gate, `just verify`, a jawan's cargo). Declare it in the
notes' `## Local stack` section and toli pauses or stops it for as long as a build holds a slot:

    ## Local stack
    - Start: `docker compose up -d`
    - Pause during builds: app-frontend
    - Stop during builds: app-backend

List only the watch or dev containers (never a database): they are paused with `docker pause` or stopped with
`docker stop`, and unpaused or started again afterwards, data kept, never removed. A paused container keeps its
memory; a stopped one frees it. The details, and what happens when a resume fails, are in
[fleet.md](fleet.md#dev-stacks-and-heavy-builds), as is why a project's own browser tests, gate or push check keep its
stack running. A live-stack project's declaration is used for every heavy build on the machine instead
([above](#pausing-the-stack-during-a-build)).

A container's cargo never sees toli's cargo shim, rustc wrapper or `CARGO_BUILD_JOBS`: it compiles with the
container's own environment, at one job per core of the machine. While a build holds a slot it is paused or stopped
as above; while it rebuilds and no build holds a slot, a build that wants one counts it as busy (on Linux, where the
host sees a container's processes) and waits for it to finish ([fleet.md](fleet.md#builds-outside-the-slots)). To cap
its width too, give the container one slot's share in its own environment: `CARGO_BUILD_JOBS` in its compose file at
the machine's `capacity.cargoJobs` ([fleet.md](fleet.md#heavy-build-slots)).

## Verify-only machines

A machine whose lead reviews a project's work but no longer builds or ships it (too small for the project's build, or
kept as its code-review verifier) marks that project verify-only, on that machine:

    bin/toli project set app --role verify-only      # --role full takes ship work again

`role=verify-only` shows in `bin/toli project list` (`"role": "verify-only"` in `--json`). The role is this
machine's own choice, kept in its `data/projects.json`, and published with its resources (`verifyOnly` in
`bin/toli resources --json`, `verify-only <p>` in `fleet status`), so every other machine sees it. No ship task for
the project is then placed on it; scout, review and verify work still is. Verify work (a verifier checking ship work
another machine made, `docs/verify-brief-template.md`) is marked explicitly: `bin/toli delegate <machine> "Verify
..." --brief <file> --project app --for T<n> --verify`. It is ship shape, so a lead forwarding a delegated verify
task on keeps the mark (`--for` that task), and the receiving lead dispatches a verifier (`spawn --work verify`). A
title starting with "Verify" without `--verify` is ship work like any other. For ship work of the project:

- `bin/toli pick --project app` (ship by default; `--shape scout` for review work) passes it over with
  `verify-only for app: it takes no ship work for it`.
- `bin/toli fleet queues` shows `verify-only app` on its row, and a suggestion to hand work to it says it takes no
  ship work for app.
- The balancing offers (`queue: offer work to <machine>`) list no ship task of app for it; a scout task's command
  carries `--shape scout`, a verify task's `--verify`. Its own ask for work names the projects it takes no ship work
  for.
- `bin/toli delegate <machine> ... --project app` with ship work (the default shape, or the `--for` task's when
  `--shape` is not given), including a lead forwarding a delegated task on, is refused before anything is sent:
  `not sent: <machine> is verify-only for app (it takes no ship work for it); next by queue: <other machine> (...);
verify work goes with --verify; --force sends it anyway`. `--force` sends it anyway; the receiving task then notes
  that it came with `--force`.
- A delegation that still reaches it (sent while it was unreachable, or by an older toli without `--verify`) is
  handed back on arrival (`bin/toli task handback`, docs/sardars.md), with a reason that ends `verify work goes with
bin/toli delegate --verify`: its task is dropped there with the reason, and the delegator's `--for` task goes back
  to queued, never dropped, even when the work was forwarded through another machine first. The hand-back reaches
  that task even when it arrives (by peer message) before the delegation's own receipt: the task records the
  delegation as `sending` from the moment it is sent ([sardars.md](sardars.md)).

## Release catch-up

Every machine works on its projects' latest release. When a project's main carries a new `vX.Y.Z` tag, each machine
with the clone merges that release into its long-lived branches, so work in flight never drifts hundreds of commits
behind main between releases.

- **Trigger.** The tick starts `bin/toli catch-up scan` in the background every 10 minutes (log:
  `logs/catch-up.log`). It fetches each project's main and tags from origin and takes the newest `vX.Y.Z` tag on
  `origin/<main>` (main: the project's `--base-branch`, else origin's default branch). A Sardar that hears of a
  release (another machine's notice) can run `bin/toli catch-up scan <project>` at once.
- **Branches.** The project's fixed `--branch` (a same-branch project without one: the branch its clone is on), and
  the branch of each active or held task of the project (branch-per-task, worktree-per-task, a task pinned to the
  clone). Never main itself. A branch that already contains the tag needs nothing. A branch whose tip is already on
  `origin/<main>` (its task's work landed) is `skipped: already on origin/<main> (<tip>)` by the scan and by the
  merge: no jawan starts and nothing is merged; once it gets new work it is caught up again.
- **One jawan.** For the branches behind the tag, the scan writes `data/projects/<p>/briefs/catch-up-<tag>.md` and
  starts one catch-up jawan through the normal `bin/toli spawn` path (queued while every jawan slot is busy; on a
  machine whose `lead.dispatch` is `subagents`, the brief goes to the lead's inbox instead). While that run is live
  no second one starts, whatever new tag appears; each branch is handed to one run per release. A machine marked
  full starts none until it is not. state/catch-up.json keeps what was handed out.
- **Checked out and free, or skipped.** The jawan runs in the project clone and touches only branches checked out on
  this machine. A branch that is not (a same-branch clone switched to another branch, say a release train's) is
  `skipped: not checked out here`: no jawan starts for it, nothing is merged, checked, built or pushed, and the next
  scan tries again. A branch is held, skipped by the scan and again by the jawan and tried on the next scan, while:
  another live jawan works in its checkout (a running spawn run's directory, or a live subagent's task workspace; a
  queued run works nowhere yet), or a live run works in the project clone itself; a live native subagent is recorded
  on an active task of the project (`task start --agent`, the same signal `capacity.maxRuns` counts), wherever it
  works; its checkout has uncommitted changes to tracked files, or commits on neither `origin/<branch>` nor main other
  than earlier catch-up merges (`1 commit on <b> not on origin/<b>`; a branch origin lacks is judged by its changes
  alone); or an open (queued or active) task of the project already plans this merge: its title or brief
  (`briefs/T<n>.md`) names the tag, or a catch-up note handed it the merge. A catch-up dispatched on a task passes
  `--task <T-id>` (a spawn run's `TOLI_TASK` counts), so that task's own jawan never holds it.
- **The merge.** The jawan runs `bin/toli catch-up merge <p> --tag <tag>`: per branch, a `git merge-tree` dry run
  first; a conflict merges nothing, leaves the work as it was, notes the conflicting files on the branch's task (its
  owner merges before the next push), and is in the jawan's report to this machine's Sardar. A clean merge lands
  through `bin/toli commit`'s `--merge` with the project's commit hooks (rule 6), in the branch's own checkout. Its
  message is `Merge <tag> into <branch>`; a hook that refuses it is reported like a conflict, never bypassed.
- **Hooks that demand a trailer.** A project whose commit-msg hook requires a trailer line on some commits (say, any
  that touches its protected quality paths, which a release's main often does) sets the line once:
  `bin/toli project set <p> --catch-up-trailer '<Key>: <text>'`. Every catch-up merge message then ends with it,
  `{tag}`, `{base}` (the release branch) and `{branch}` filled in, e.g.
  `--catch-up-trailer 'Quality-change: merge of release {tag} from {base}'`. The hook still runs on the message and
  still judges it; `--catch-up-trailer none` drops the line. A merge the hook refuses while no trailer is set says so
  in its report.
- **Checks and push.** In each checkout it merged, the jawan then runs the quick checks,
  `bin/toli project set <p> --catch-up-checks "<command>"` (else the ones the project's notes name; heavy commands
  under `bin/toli build-slot`). It pushes a branch only when the plan prints a `push` line for it: the branch is
  already on origin, it is not main, and the project has a standing push grant on this machine
  (`--standing-push yes`); the push is
  `bin/toli push <p> --branch <b>` with the normal hooks, never forced, and refuses before any hook runs when the
  checkout is on another branch. Otherwise the merge stays local and the report says why. The scan and the tick
  never merge or push.
- **A merge whose checks fail is undone.** The plan prints, per merged branch,
  `if the checks fail: bin/toli catch-up undo <p> --branch <b> --merge <sha>`, and the jawan runs it on a failure.
  It takes back only a merge this machine's catch-up recorded making (state/catch-up.json), only while it is still
  the branch's tip and not on origin's copy of the branch: the branch moves back to the merge's first parent with
  `git reset --keep`, which refuses rather than lose a change in the work tree, and the branch's task gets a note. A
  merge with work on top of it, or any commit it did not make, is refused and left as it is.
- **Boxes that cannot run the push gate.** A catch-up push runs the project's pre-push hook like any push. Where that
  hook checks everything main changed in the merge (heavy builds and tests a small machine's capacity forbids), the
  catch-up must not depend on it: declare the merge-in push light in the hook (`# toli-light-push: NAME=VALUE`,
  [delivery.md](delivery.md#gates-long-checks-run-once-per-tree)) when the project has a quick mode for it, or set
  `bin/toli project set <p> --catch-up-push no` on that machine. Then every catch-up merge stays local and is
  reported; the branch takes the release at its own next push, or the machine that lands it re-merges. Scoping a merge
  commit's checks to the branch's own changes belongs in the project's hook.
- **Opt out.** On by default (a project without release tags has nothing to catch up to).
  `bin/toli project set <p> --catch-up no` turns it off on this machine; `--catch-up default` turns it on again.
  `project list` shows `catch-up=no`, the checks and the trailer (`catchUp`, `catchUpChecks`, `catchUpTrailer` in
  `--json`).

## Setting up an existing project

Projects registered before the interview, imported clones, and notes that drifted get the same treatment:

    /setup-project <name>                    (lead session)
    bin/toli project setup <name> [--json]   the checklist for one project
    bin/toli project setup --all [--json]    every project with gaps, and what each lacks

Example:

    myapp: needs setup
      [x] clone        projects/myapp on release/next
      [x] delivery     commit on the fixed branch release/next
      [ ] smoke        no smoke command in the notes (jawan)
      [~] freshness    notes last changed 41 days ago; re-check against the repo (jawan)

| Item          | Checked                                                                        |
| ------------- | ------------------------------------------------------------------------------ |
| `clone`       | the clone exists on this machine                                               |
| `delivery`    | the mode was chosen, not defaulted                                             |
| `branch`      | a fixed branch exists locally or on origin                                     |
| `forge`       | the forge is detected (required for `pr` / `no-mistakes`)                      |
| `forge-auth`  | `gh`/`glab` are authenticated, or Bitbucket credentials exist (single project) |
| `no-mistakes` | the clone has the `no-mistakes` remote (gate mode)                             |
| `hooks`       | each git hook the repo declares is installed ([git hooks](#git-hooks))         |
| `notes`       | `data/projects/<name>/notes.md` exists                                         |
| `test`        | a test command in the notes (a `- Test:` line, or any backticked test command) |
| `smoke`       | a smoke command in the notes                                                   |
| `local-stack` | a `## Local stack` section (commands, or `- None`)                             |
| `urls`        | a `## URLs` section (local and staging URLs, or `- None`)                      |
| `proof`       | a `## Proof` section (required evidence, screenshot widths)                    |
| `freshness`   | the notes changed within the last 30 days                                      |

`[x]` done, `[ ]` missing, `[~]` stale, `[-]` unknown but not needed in this mode. Each gap names who fills it: the
user (the lead batches every such question into one message) or a jawan (detected from the repo). `--all` and
`bin/toli digest` use the fast local checks only (no forge auth probe), so digest can say how many projects need setup.

## Git hooks

toli delivers through the project's own hooks: `bin/toli commit` runs its `commit-msg` hook and `git push` runs its
`pre-push` hook. A fresh clone runs none of them until they are installed, so toli looks for hooks the repo declares
and checks that git would run each one (an executable file where git resolves it, `core.hooksPath` honoured):

- Hook files in `.husky/` (husky): toli sets `core.hooksPath .husky/_` when husky 9 already generated `.husky/_`, or
  `.husky` for husky 8's `.husky/_/husky.sh`; else it runs the repo's own `node_modules/.bin/husky` with the arguments
  its `prepare` script gives husky; else, when every hook file there is executable and does not source `husky.sh`, it
  sets `core.hooksPath .husky`. Otherwise it prints the dependency install, which runs husky through `prepare`.
- A directory that a justfile, Makefile or `package.json` recipe, or a doc (`README.md`, `CONTRIBUTING.md`,
  `AGENTS.md`, `CLAUDE.md`, `docs/*.md`), sets `core.hooksPath` to: toli runs `git config core.hooksPath <dir>`.
- `.githooks/` that nothing names: toli prints `git config core.hooksPath .githooks`.
- `.pre-commit-config.yaml` (its `default_install_hook_types`, else `pre-commit`): toli prints `pre-commit install`.
- `lefthook.yml` (or `.toml`/`.json`, dotted or not) and its hook sections: toli prints `lefthook install`.

`bin/toli project add`, `project ensure` and `project setup <name>` install what they can and print a `hooks:` line
per declaration: active, or what is missing and the command that installs it. They never replace a `core.hooksPath`
already set to something else. `bin/toli project setup` lists a `hooks` item per declaration, and `bin/toli doctor`
warns about each clone whose declared hooks are not installed.

`bin/toli commit` stops a commit hook (pre-commit, commit-msg) still running after 300 s and refuses the commit. A
project whose hooks take longer sets its own limit with `bin/toli project set <p> --hook-timeout <seconds>|none`
(`none`: no limit; `default` goes back to the machine's), shown as `hook-timeout=` in `bin/toli project list`
(`hookTimeoutSeconds` in `--json`). The machine's default for every project is `capacity.commitHookTimeoutSeconds` in
`config/machine.json` (seconds or `"none"`). The refusal names both settings. A project's limit is kept in this
machine's `data/projects.json`, so each machine that commits to a slow project sets it there: for example
`bin/toli project set <p> --hook-timeout 900` gives that project's pre-commit 15 minutes. This limit is only
for a project's commit hooks: toli's own `local/hooks/` scripts (post-init, pre-tick, post-tick, task-end;
[helpers.md](helpers.md)) keep their separate fixed 5-minute limit and never block a commit.

`bin/toli push` refuses when the repo declares a `pre-push` hook git would not run: the project's own pre-push check
would otherwise skip without a word, which is how pushes went out unverified before. `--no-hooks-ok` pushes anyway,
for the rare repo whose declared hook is meant to stay off on this machine. Other declared hooks that are not
installed only warn. A repo that declares no hooks gets no `hooks` line, item or warning.

`bin/toli push` also refuses a checkout a release train owns (T2232), since the project's pre-push hook may run its
full check there and hold the train for hours: one on a `release/*` branch (`refusing to push <p>: projects/<p> is on
release/<v>, a release train's branch; only the train pushes it (--release-train)`), or one a live jawan holds, by the
release catch-up's own check (a spawn run working in it, not one still queued, or a live native subagent whose open
task records it as its workspace; never the pushing run itself, `TOLI_RUN_ID`, nor the task named with `--task`):
`refusing to push <p>: projects/<p> is held (<who> works in it); ...`. The train itself passes `--release-train`. This
covers every push toli makes, the catch-up jawan's included. toli keeps no separate train or tag lock.

## Data layout

    data/projects/<name>/
      notes.md        stack, commands, local stack, URLs, proof, delivery, gotchas; fed into every brief
      briefs/         each dispatched brief (T<n>.md, T<n>-verify.md, ...)
      reports/        scout and task reports (T<n>.md)
      runs/           jawan run outputs, and outputs of remote runs started before the one-lead-per-machine cutover
      decisions.md    held questions, their options, and the user's verbatim answers (appended by bin/toli task answer)

Cross-project files stay at the top of `data/`: the user's preferences (`preferences.md`), `learnings.md`, `jobs/`,
`inbox/`, `archive/`, toli-wide `reports/`, and `remote/` for old remote runs without a project. In code, every path
comes from `src/core/paths.ts` (`paths.projectNotes(p)`, `projectBriefsDir(p)`, `projectReportsDir(p)`,
`projectReport(p, id)`, `projectRunsDir(p)`, `projectDecisions(p)`).

`bin/toli project drop <name>` keeps both the clone and `data/projects/<name>/`; `--delete-clone` and `--delete-data`
remove them (irreversible; the lead confirms first).

## Moving data from the old layout

Installs from before this layout kept everything flat under `data/` (`notes/<name>.md`, `reports/T<n>.md`,
`remote/`, loose `briefs/`) and the user's preferences in a file named after the persona. One command moves it:

    bin/toli migrate --dry-run    print the plan; change nothing
    bin/toli migrate              apply it

- Notes move to `data/projects/<name>/notes.md`; task reports to the reports directory of the task's project (looked up
  in the backlog and the task archive); remote runs that name their project to its `runs/`; briefs to the `briefs/`
  of the project whose scheduled job uses them, else, for a task brief (`T10.md`), of the task's project (looked up
  like reports), else of the project the file name names (`myapp.md`, `myapp-review.md`). A name that fits several
  projects (`myapp-admin-x.md` with `myapp` and `myapp-admin`) stays.
- Everything else stays where it is and is listed as kept: toli-wide reports, reports and briefs of unknown tasks,
  project-less remote runs, briefs that name no project.
- The old persona-named preferences file (and its archive in `data/archive/`) moves to `data/preferences.md`
  (`data/archive/preferences.md`).
- Nothing is overwritten. A different file already at a destination is a conflict: the plan shows it and `migrate`
  refuses without moving anything. An identical copy is a duplicate, and the old copy is removed.
- Mentions of moved files in `config/jobs.json` prompts, `data/backlog.json` task notes, `data/preferences.md`,
  `data/learnings.md`, and project notes are rewritten to the new paths.
- Running it again finds nothing to move.

Back up first: `tar czf ~/toli-data-backup-$(date +%Y%m%d-%H%M).tgz data`.
