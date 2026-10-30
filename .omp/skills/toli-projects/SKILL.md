---
name: toli-projects
description: Register, set up, configure, and remove projects Sardar can dispatch work into - the registration interview (how work lands - PR/MR, current branch, or a fixed branch - plus the optional no-mistakes gate), cloning, seeding the notes file, re-setup of existing projects that lack config or notes, and the per-project data directory. Use for /add-project, /setup-project, /drop-project, or when Malik asks to add, set up, remove, move, or change how a project is delivered.
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

## Delivery modes

| Malik's choice                                 | Recorded with                                             |
| ---------------------------------------------- | --------------------------------------------------------- |
| (a) pull/merge requests from a work branch     | `bin/toli project set <name> --mode pr --branch none`     |
| (b) commit on the currently checked-out branch | `bin/toli project set <name> --mode commit --branch none` |
| (c) commit on a fixed named branch             | `bin/toli project set <name> --mode commit --branch <b>`  |
| + no-mistakes gate (with a or c)               | same, but `--mode no-mistakes` (keeps `--branch` for c)   |

`project set --mode/--branch` stamps the choice (`deliverySetAt`); until then the mode is only a default and
`bin/toli project setup` lists it as missing. The forge (GitHub, GitLab incl. self-hosted, Bitbucket) is detected
from `origin`; only when detection fails record it with `--forge github|gitlab|bitbucket [--forge-host <host>]`.
Pushing, opening PRs, and merging still need Malik's word for each change (`skill://toli-deliver`); the mode only
says which flow work takes.

## Adding a project (/add-project)

1. Get the name and git URL from Malik's arguments. If the URL is missing, ask for it in the same message as step 2.
2. Unless the arguments already settle delivery, ask Malik one batched multiple-choice question, then end the turn.
   Fill in the name and the forge guessed from the URL host (`github.com` GitHub, `bitbucket.org` Bitbucket, a host
   containing `gitlab` GitLab, otherwise "unknown, a jawan will detect it"):

    > Malik, how should work land in **<name>**?
    >
    > 1. **Delivery**
    >     - (a) Pull/merge requests from a work branch (forge: <GitHub | GitLab at host | Bitbucket | detected after clone>)
    >     - (b) Commit on whatever branch is checked out
    >     - (c) Commit on a fixed branch: which one?
    > 2. **no-mistakes gate** before PRs (only with a or c): yes / no (default no)
    > 3. **Test / smoke command**: type it, or "detect" and a jawan reads it from the repo (default detect)
    >
    > Reply like `a, no, detect` or `c release/next, yes, bun test`.

3. On his answer, decide where the clone lives. Default is this machine. If Malik names another machine, run it there
   through `bash` with `async: true` and `timeout: 0`:
   `bin/toli remote <machine> "/add-project <name> <git-url> <his answers verbatim>"`, and end the turn.
4. Dispatch one `task` jawan (effort lo; it writes files, so not the read-only `scout` agent) whose brief says:

        bin/toli project add <name> <git-url>
        bin/toli project set <name> --mode <pr|commit|no-mistakes> --branch <b|none>
        bin/toli forge <name>

    then read the project's README, AGENTS.md / CLAUDE.md, and build files, and write
    `data/projects/<name>/notes.md` (short; it is fed into every brief for this project) with the headings
    `## Stack`, `## Commands` (install, build, lint, plus a `- Test:` and a `- Smoke:` line, each with the command in
    backticks: Malik's answer verbatim, or what the repo shows), `## Local stack`, `## URLs`, `## Proof` (write
    `- None` or `- Unknown` when the repo says nothing; never invent), `## Delivery` (Malik's delivery answer and the
    forge), and `## Gotchas`. It reports the clone path, the notes written, the `forge` output (forge, host, auth
    readiness), the no-mistakes readiness line `project add` printed, and the `bin/toli project setup <name>` output.
    If it cannot detect a test or smoke command it says so. End the turn after dispatching.

5. From the jawan's report: if the forge was not detected, or a test/smoke command is still unknown, ask Malik those
   in one message and record them (`project set --forge`, and a `sonic` jawan writes the commands into the notes).
   If he chose the gate and no `no-mistakes` remote exists, offer `no-mistakes init` in the clone; on his approval a
   jawan runs it (`skill://toli-nm`). Forge auth not ready: tell Malik the one command the `forge` output names.
6. Confirm to Malik: name, path, machine, delivery, forge, notes seeded, what `project setup` still lists.

## Setting up an existing project (/setup-project)

For projects registered before the interview existed, imported clones, or notes that went stale.

    bin/toli project setup <name> [--json]     the checklist for one project
    bin/toli project setup --all [--json]      projects with gaps and what each lacks (digest shows the count)

The checklist covers: clone, delivery (mode chosen or only defaulted), fixed branch present, forge detected and
authenticated (needed for pr / no-mistakes), no-mistakes remote (gate mode), notes file, test and smoke commands,
`## Local stack`, `## URLs`, `## Proof`, and notes freshness (older than 30 days is stale). Each gap says who
fills it: `ask the user` or `jawan`.

1. Run `bin/toli project setup <name>` (fast bookkeeping; with `--all` pick the projects Malik named, or offer the
   list).
2. Batch every `ask the user` gap into one multiple-choice message (the delivery question from /add-project step 2,
   plus forge or URLs if listed), suggesting what the notes or `project list` already show. For several projects
   use one message (or a lavish table) with one row per project.
3. In the same turn, dispatch one `task` jawan per project for the `jawan` gaps: re-read the repo, fill or refresh
   the missing notes sections (dated entries; `- None` when the project has no stack or URLs), detect test and smoke
   commands, run `bin/toli forge <name>`, and report `bin/toli project setup <name>` afterwards. End the turn.
4. On Malik's answers, record delivery with `project set` (table above) and pass anything that belongs in the notes
   (URLs, proof widths, commands he typed) to a `sonic` jawan verbatim.
5. Report the final checklist per project in one or two lines.

## Ensuring a clone exists

    bin/toli project ensure <name> <git-url> [--mode m]

Idempotent: no-op when registered and cloned, registers an existing unregistered clone, otherwise clones and
registers. `bin/toli remote auto --project` runs it on the target machine before dispatching.

## Listing

    bin/toli project list [--json]    (--json includes `cloned` and `deliverySetAt`)
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
rewrites path mentions in job prompts, task notes, and memory files.

## Dropping a project (/drop-project)

    bin/toli project drop <name> [--delete-clone] [--delete-data]

- Default keeps the clone and `data/projects/<name>/` on disk and only removes the record.
- `--delete-clone` deletes `projects/<name>/`; `--delete-data` deletes `data/projects/<name>/` (notes, briefs,
  reports, runs, decisions). Both are irreversible, so confirm with Malik first, in plain words, even if he typed the
  flag.
- The CLI refuses when the clone is dirty or has unpushed commits. Never work around that refusal (no reset, stash,
  clean, or force). Report what is uncommitted or unpushed and let Malik decide.
- Drop any queued or held backlog tasks for the project only with Malik's word: `bin/toli task drop <id>`.
