# Projects

A project is a git repository the lead (Sardar) can dispatch jawans into. Each machine clones the projects it works on
into `projects/<name>/` and records them in `data/projects.json`; everything toli keeps about a project lives in one
directory, `data/projects/<name>/`.

## Registering a project

In the lead session:

    /add-project <name> <git-url | path> [machine]

Before anything is cloned, the lead asks one batched, multiple-choice question (full text in the `toli-projects`
skill): checkout (`clone` fresh, or `link <path>` to an existing checkout), workspace strategy (`same-branch
[<branch>]`, `branch`, `worktree`; default from `defaults.workspace` in `config/machine.json`), PR or MR (per-task
strategies), the no-mistakes gate, the test/smoke command, and an optional standing push/PR grant. Reply like
`clone, same-branch, no, detect` or `link ~/code/shop, worktree, mr, yes, bun test`.

With the answer, a jawan clones the repo (`bin/toli project add`) or links it (`bin/toli project link`), records the
choices (`bin/toli project set`), checks the forge and its auth (`bin/toli forge <name>`), and seeds
`data/projects/<name>/notes.md` from the repo's README, agent docs, and build files. Anything it cannot detect (an
unknown forge, no test command) comes back to the user as one follow-up question.

What each delivery choice means: [delivery.md](delivery.md).

Without a lead session, the same steps by hand:

    bin/toli project add <name> <git-url>        or   bin/toli project link <name> <path>
    bin/toli project set <name> --workspace worktree-per-task --mode pr --branch none
    bin/toli project setup <name>

`bin/toli project link <name> <path>` registers a checkout the user already has: it checks it is a git repo,
reports its origin, forge and branch, and makes `projects/<name>` a symlink to it; `project drop --delete-clone`
removes only that symlink, never the checkout, and `project setup`/digest flag a link whose checkout moved.
`bin/toli project ensure <name> <git-url>` is the idempotent form used when work is sent to another machine;
`bin/toli project import` registers clones copied into `projects/` by hand.

## Workspace strategy

Each project records where its jawans work (`workspace` in `bin/toli project list`; asked at registration and by
`/setup-project`; new projects start on the machine default, `defaults.workspace` in `config/machine.json`):

| Strategy            | Where jawans work                                                                  | Landing                    |
| ------------------- | ---------------------------------------------------------------------------------- | -------------------------- |
| `same-branch`       | the one clone, on the project's (fixed or checked-out) branch                      | per the delivery mode      |
| `branch-per-task`   | the one clone, switched to `toli/<T-id>-<slug>` before the jawan starts            | task branch pushed + PR/MR |
| `worktree-per-task` | `projects/.worktrees/<project>/<T-id>`, a worktree on its own `toli/<T-id>-<slug>` | task branch pushed + PR/MR |

- `bin/toli spawn --task T<n>` prepares the workspace (or `bin/toli workspace prepare T<n>` for native subagents)
  and records it on the task; the brief carries the strategy, path, and branch, and the verifier reuses it.
  Task branches start from the base branch: the project's `--branch`, else origin's default branch.
- `branch-per-task` refuses to switch the clone while another active or held task of the project uses it on a
  different branch, or while the clone has uncommitted changes; use `worktree-per-task` for parallel tasks.
- `bin/toli commit|push|pr create <project> --task T<n>` act in the task's workspace (commands run from inside a
  task worktree find it themselves). Per-task projects refuse a commit without `--task`.
- Pushing the task branch and opening its PR/MR need the user's word for that change, unless the project carries an
  explicit standing grant ([delivery.md](delivery.md#standing-grants)). Without one, the verifier commits and holds
  the task with the question.
- `bin/toli workspace list [--project p]` shows each task worktree with its task status, branch, merged state and
  cleanliness. `bin/toli workspace prune [--project p]` removes worktrees of done/dropped tasks whose branch is
  merged into the base (local or origin, fetched first) and deletes the merged branch. It keeps live, dirty, and
  unmerged ones; `--force` abandons unmerged commits (it prints the deleted tip sha) and is only run on the user's
  word. Squash-merged branches show as unmerged.
- `bin/toli project set --all --workspace <s>` applies one strategy to every project. A per-task strategy moves a
  `commit`-mode project to `pr`.
- Pre-strategy projects keep their behaviour: `bin/toli migrate` records `branch-per-task` for `pr` and branchless
  `no-mistakes` projects, `same-branch` for the rest.

Examples:

    # blog: everyone on the one clone, committing on the fixed branch nightly
    bin/toli project set blog --workspace same-branch --mode commit --branch nightly

    # shop: a worktree and branch per task, published as a GitLab merge request; push/MR only on the user's word
    bin/toli project set shop --workspace worktree-per-task --mode pr --branch main --standing-push no --standing-pr no

For shop, `bin/toli spawn --task T42 ...` creates `projects/.worktrees/shop/T42` on
`toli/T42-<slug>` from `main`; after verification the verifier holds T42 asking to push and open the MR, and on the
user's word a jawan runs `bin/toli push shop --task T42` and `bin/toli pr create shop --task T42 ...`.

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

## Data layout

    data/projects/<name>/
      notes.md        stack, commands, local stack, URLs, proof, delivery, gotchas; fed into every brief
      briefs/         each dispatched brief (T<n>.md, T<n>-verify.md, ...)
      reports/        scout and task reports (T<n>.md)
      runs/           jawan and remote run outputs (bin/toli remote --project)
      decisions.md    held questions and the user's answers (appended by bin/toli task answer)

Cross-project files stay at the top of `data/`: the user's preferences (`preferences.md`), `learnings.md`, `jobs/`,
`inbox/`, `archive/`, toli-wide `reports/`, and `remote/` for remote runs without a project. In code, every path
comes from `src/paths.ts` (`paths.projectNotes(p)`, `projectBriefsDir(p)`, `projectReportsDir(p)`,
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
  of the project whose scheduled job uses them, else of the project the file name names (`myapp.md`,
  `myapp-review.md`). A name that fits several projects (`myapp-admin-x.md` with `myapp` and `myapp-admin`) stays.
- Everything else stays where it is and is listed as kept: toli-wide reports, reports of unknown tasks, project-less
  remote runs, briefs that name no project.
- The old persona-named preferences file (and its archive in `data/archive/`) moves to `data/preferences.md`
  (`data/archive/preferences.md`).
- Nothing is overwritten. A different file already at a destination is a conflict: the plan shows it and `migrate`
  refuses without moving anything. An identical copy is a duplicate, and the old copy is removed.
- Mentions of moved files in `config/jobs.json` prompts, `data/backlog.json` task notes, `data/preferences.md`,
  `data/learnings.md`, and project notes are rewritten to the new paths.
- Running it again finds nothing to move.

Back up first: `tar czf ~/toli-data-backup-$(date +%Y%m%d-%H%M).tgz data`.
