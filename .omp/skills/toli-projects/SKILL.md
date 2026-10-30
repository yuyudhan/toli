---
name: toli-projects
description: Register, set up, configure, and remove projects Sardar can dispatch work into - the registration interview (fresh clone or link to an existing checkout; workspace strategy - same-branch, branch-per-task, worktree-per-task; how work lands - PR/MR, current branch, or a fixed branch - plus the optional no-mistakes gate and standing push/PR grants), cloning or linking, seeding the notes file, re-setup of existing projects that lack config or notes, and the per-project data directory. Use for /add-project, /setup-project, /drop-project, or when Malik asks to add, link, set up, remove, move, or change how a project is delivered or branched.
---

# Managing projects

Projects live in `projects/<name>/` (gitignored) and are recorded in `data/projects.json`. Each machine's registry
lists only the clones on that machine; a project may be cloned on several machines. Everything toli keeps about a
project lives in `data/projects/<name>/`:

| Path                                | Holds                                                         |
| ----------------------------------- | ------------------------------------------------------------- |
| `data/projects/<name>/notes.md`     | stack, commands, URLs, proof, delivery, gotchas (every brief) |
| `data/projects/<name>/briefs/`      | each dispatched brief, `T<n>.md`                              |
| `data/projects/<name>/reports/`     | scout and task reports, `T<n>.md`                             |
| `data/projects/<name>/runs/`        | jawan and remote run outputs                                  |
| `data/projects/<name>/decisions.md` | held questions and Malik's answers (`bin/toli task answer`)   |

Cross-project files stay at the top of `data/` (`preferences.md`, `learnings.md`, `jobs/`, `inbox/`, `archive/`,
toli-wide `reports/`). Details: `docs/projects.md`.

## Checkout, workspace strategy, and delivery

A project is either cloned fresh into `projects/<name>/` (`bin/toli project add <name> <git-url>`) or linked to a
checkout Malik already has (`bin/toli project link <name> <path>`: validates the git repo, reports origin, forge and
branch, and makes `projects/<name>` a symlink to it). Dropping a linked project removes only the symlink.

| Malik's choice                                         | Recorded with (`bin/toli project set <name> ...`)               |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| `same-branch`: commit on the checked-out branch        | `--workspace same-branch --mode commit --branch none`           |
| `same-branch <b>`: commit on a fixed named branch      | `--workspace same-branch --mode commit --branch <b>`            |
| `branch`: one clone, a branch + PR/MR per task         | `--workspace branch-per-task --mode pr --branch <base>\|none`   |
| `worktree`: a worktree + branch + PR/MR per task       | `--workspace worktree-per-task --mode pr --branch <base>\|none` |
| + no-mistakes gate (any of them)                       | same, but `--mode no-mistakes`                                  |
| + standing grant (branch/worktree only, his word only) | `--standing-push yes --standing-pr yes` (or push only)          |
| same strategy for every project                        | `bin/toli project set --all --workspace <strategy>`             |

The strategies in one line each: **same-branch** - every jawan works in the one clone on the project's branch;
**branch-per-task** - one clone, switched to a `toli/<T-id>-<slug>` branch per task (two live tasks cannot share the
clone on different branches), each pushed with a PR/MR; **worktree-per-task** - a git worktree per task under
`projects/.worktrees/<project>/<T-id>` with its own branch and PR/MR, so tasks run side by side. New projects start on
the machine default (`defaults.workspace` in `config/machine.json`, asked during "set up toli"; same-branch when
unset), unstamped, so `project setup` asks until Malik confirms. For a per-task strategy `--branch` is the base the
task branches start from and the PR/MR targets (origin's default branch when unset).

`project set --mode/--branch` stamps the delivery choice (`deliverySetAt`) and `--workspace` the strategy
(`workspaceSetAt`); until then both are defaults and `bin/toli project setup` lists them as missing. The forge
(GitHub, GitLab incl. self-hosted, Bitbucket) is detected from `origin`; only when detection fails record it with
`--forge github|gitlab|bitbucket [--forge-host <host>]`. Pushing and opening PR/MRs need Malik's word for each change
unless he granted that project a standing grant in plain words; merging always needs his word
(`skill://toli-deliver`). Never record a standing grant from a default or a guess.

## Adding a project (/add-project)

1. Get the name and git URL (or local path) from Malik's arguments. If both are missing, ask in the same message as
   step 2.
2. Unless the arguments already settle every item, ask Malik one batched multiple-choice question, then end the turn.
   Fill in the name, the machine default strategy (`defaults.workspace` in `config/machine.json`, else same-branch),
   and the forge guessed from the URL host (`github.com` GitHub, `bitbucket.org` Bitbucket, a host containing
   `gitlab` GitLab, otherwise "unknown, a jawan will detect it"):

    > Malik, how should **<name>** be set up?
    >
    > 1. **Checkout**: `clone` a fresh copy into projects/<name>, or `link <path>` to a checkout you already have
    >    (default clone)
    > 2. **Workspace** (default <machine default>)
    >     - `same-branch [<branch>]`: every jawan works in the one clone on the checked-out (or that fixed) branch
    >     - `branch`: one clone, a new branch and PR/MR per task, one task at a time in the clone
    >     - `worktree`: a separate worktree and branch per task, PR/MR per task, tasks side by side
    > 3. **PR or MR** (branch/worktree only; forge: <GitHub | GitLab at host | Bitbucket | detected after clone>):
    >    `pr` / `mr` (same flow; say which word your forge uses)
    > 4. **no-mistakes gate** before PRs: yes / no (default no)
    > 5. **Test / smoke command**: type it, or "detect" and a jawan reads it from the repo (default detect)
    > 6. Optional **standing grant** (branch/worktree only): `standing push+pr` lets verified task branches be pushed
    >    and PR/MRs opened without asking each time (default: ask every time)
    >
    > Reply like `clone, same-branch, no, detect` or `link ~/code/moneytrace, worktree, mr, yes, bun test`.

3. On his answer, decide where the checkout lives. Default is this machine. If Malik names another machine, run it
   there through `bash` with `async: true` and `timeout: 0`:
   `bin/toli remote <machine> "/add-project <name> <git-url> <his answers verbatim>"`, and end the turn. A `link`
   path is a path on the machine that has it.
4. Dispatch one `task` jawan (effort lo; it writes files, so not the read-only `scout` agent) whose brief says:

        bin/toli project add <name> <git-url>          (clone)   |   bin/toli project link <name> <path>   (link)
        bin/toli project set <name> --workspace <strategy> --mode <pr|commit|no-mistakes> --branch <b|none>
        bin/toli project set <name> --standing-push yes --standing-pr yes     (only when Malik granted it, quoted)
        bin/toli forge <name>

    then read the project's README, AGENTS.md / CLAUDE.md, and build files, and write
    `data/projects/<name>/notes.md` (short; it is fed into every brief for this project) with the headings
    `## Stack`, `## Commands` (install, build, lint, plus a `- Test:` and a `- Smoke:` line, each with the command in
    backticks: Malik's answer verbatim, or what the repo shows), `## Local stack`, `## URLs`, `## Proof` (write
    `- None` or `- Unknown` when the repo says nothing; never invent), `## Delivery` (Malik's checkout, workspace and
    delivery answers and the forge), and `## Gotchas`. It reports the checkout path, the notes written, the `forge`
    output (forge, host, auth readiness), the no-mistakes readiness line `project add`/`link` printed, and the
    `bin/toli project setup <name>` output. If it cannot detect a test or smoke command it says so. End the turn
    after dispatching.

5. From the jawan's report: if the forge was not detected, or a test/smoke command is still unknown, ask Malik those
   in one message and record them (`project set --forge`, and a `sonic` jawan writes the commands into the notes).
   If he chose the gate and no `no-mistakes` remote exists, offer `no-mistakes init` in the clone; on his approval a
   jawan runs it (`skill://toli-nm`). Forge auth not ready: tell Malik the one command the `forge` output names.
6. Confirm to Malik: name, path (and link target), machine, workspace strategy, delivery, standing grant, forge,
   notes seeded, what `project setup` still lists.

## Setting up an existing project (/setup-project)

For projects registered before the interview existed, imported clones, or notes that went stale.

    bin/toli project setup <name> [--json]     the checklist for one project
    bin/toli project setup --all [--json]      projects with gaps and what each lacks (digest shows the count)

The checklist covers: clone (a linked project whose checkout moved or vanished is a broken link: ask Malik for the
new path, then drop and re-link), delivery (mode chosen or only defaulted), workspace strategy (chosen or only the
machine default), fixed branch present, forge detected and authenticated (needed for pr / no-mistakes), no-mistakes
remote (gate mode), notes file, test and smoke commands, `## Local stack`, `## URLs`, `## Proof`, and notes
freshness (older than 30 days is stale). Each gap says who fills it: `ask the user` or `jawan`.

1. Run `bin/toli project setup <name>` (fast bookkeeping; with `--all` pick the projects Malik named, or offer the
   list).
2. Batch every `ask the user` gap into one multiple-choice message (the workspace, delivery and gate items from
   /add-project step 2, defaulting to what `project list` shows, plus forge or URLs if listed). Reply format there,
   without the checkout item: `same-branch, no, detect` / `worktree, mr, yes, bun test`. For several projects
   use one message (or a lavish table) with one row per project.
3. In the same turn, dispatch one `task` jawan per project for the `jawan` gaps: re-read the repo, fill or refresh
   the missing notes sections (dated entries; `- None` when the project has no stack or URLs), detect test and smoke
   commands, run `bin/toli forge <name>`, and report `bin/toli project setup <name>` afterwards. End the turn.
4. On Malik's answers, record workspace and delivery with `project set` (table above; "same for all" is
   `project set --all --workspace <s>`) and pass anything that belongs in the notes
   (URLs, proof widths, commands he typed) to a `sonic` jawan verbatim.
5. Report the final checklist per project in one or two lines.

## Ensuring a clone exists

    bin/toli project ensure <name> <git-url> [--mode m]

Idempotent: no-op when registered and cloned, registers an existing unregistered clone, otherwise clones and
registers. `bin/toli remote auto --project` runs it on the target machine before dispatching.

## Listing

    bin/toli project list [--json]    (shows workspace=<strategy>; --json adds `cloned`, `linkedTo`, `brokenLink`,
                                       `standing`, `deliverySetAt`, `workspaceSetAt`)
    bin/toli project path <name>

## Importing existing clones

Clones copied or moved into `projects/` by hand are registered with `bin/toli project import` (no URL needed; it reads
`origin`). A clone that had a no-mistakes gate needs `no-mistakes init` again in its new place. After an import, run
the /setup-project flow for the imported projects; batch the questions into one message (or a lavish table) instead
of asking per project.

## Moving old data (one time)

Installs from before per-project directories keep a flat layout directly under `data/` (`notes/<name>.md`, task
reports `reports/T<n>.md`, `remote/`, loose `briefs/`). A jawan runs `bin/toli migrate --dry-run`, then (plan looks
right, no conflicts) `bin/toli migrate`, and reports both outputs. It moves files without overwriting anything and
rewrites path mentions in job prompts, task notes, and memory files. It also writes down each pre-strategy project's
`workspace` (branch-per-task for `pr` / branchless `no-mistakes`, else same-branch), so nothing changes behaviour.

## Dropping a project (/drop-project)

    bin/toli project drop <name> [--delete-clone] [--delete-data]

- Default keeps the clone and `data/projects/<name>/` on disk and only removes the record.
- `--delete-clone` deletes `projects/<name>/` (for a linked project only the symlink; Malik's own checkout is never
  touched); `--delete-data` deletes `data/projects/<name>/` (notes, briefs, reports, runs, decisions). Both are
  irreversible, so confirm with Malik first, in plain words, even if he typed the flag.
- The CLI refuses when the clone is dirty or has unpushed commits. Never work around that refusal (no reset, stash,
  clean, or force). Report what is uncommitted or unpushed and let Malik decide.
- Drop any queued or held backlog tasks for the project only with Malik's word: `bin/toli task drop <id>`.
