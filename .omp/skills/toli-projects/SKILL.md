---
name: toli-projects
description: Register, configure, and remove projects Sardar can dispatch work into - clone, seed the notes file, check no-mistakes readiness, clone on another machine, and set the delivery mode. Use for /add-project, /drop-project, or when Malik asks to add, remove, move, or change how a project is delivered.
---

# Managing projects

Projects live in `projects/<name>/` (gitignored) and are recorded in `data/projects.json`. Each machine's registry
lists only the clones on that machine; a project may be cloned on several machines. Each has one delivery mode.

## Adding a project (/add-project)

1. Get the name and git URL from Malik's arguments. If the URL is missing, ask once.
2. Decide where the clone lives. Default is this machine. If Malik names another machine, run it there through
   `bash` with `async: true` and `timeout: 0`: `bin/toli remote <machine> "/add-project <name> <git-url>"`, and end
   the turn. Work is sent to whichever machine is free later (`bin/toli remote auto ... --project <name>` clones it on
   demand with `bin/toli project ensure`).
3. Decide the delivery mode: `commit` (default), `pr`, or `no-mistakes`. Only set a non-default mode when Malik says
   so.
4. Dispatch one `task` jawan (effort lo; it must write a file, so not the read-only `scout` agent) whose brief says:

        bin/toli project add <name> <git-url> [--mode commit|pr|no-mistakes]

    then read the project's README, AGENTS.md / CLAUDE.md, and build files, and write `data/notes/<name>.md`
    (short; it is fed into every brief for this project) with:
    - stack and package manager
    - install, build, test, lint, and smoke commands
    - main entry points and directory map
    - gotchas the project's own docs call out

    and report the clone path, the notes written, and the no-mistakes readiness line `project add` printed. End the
    turn after dispatching.

5. Report no-mistakes readiness from the jawan's report. If no `no-mistakes` git remote exists, tell Malik and offer
   `no-mistakes init` in the clone; on his approval a jawan runs it. Readiness only matters if he will ever want
   branch/PR delivery through the gate (`skill://toli-nm`).
6. Confirm to Malik: name, path, machine, mode, notes seeded, no-mistakes ready or not.

## Changing settings

    bin/toli project set <name> --mode commit|pr|no-mistakes

## Ensuring a clone exists

    bin/toli project ensure <name> <git-url> [--mode m]

Idempotent: no-op when registered and cloned, registers an existing unregistered clone, otherwise clones and
registers. `bin/toli remote auto --project` runs it on the target machine before dispatching.

## Listing

    bin/toli project list [--json]    (--json includes `cloned`)
    bin/toli project path <name>

## Importing existing clones

Clones copied or moved into `projects/` by hand are registered with `bin/toli project import` (no URL needed; it reads
`origin`). A clone that had a no-mistakes gate needs `no-mistakes init` again in its new place. After an import, seed missing
notes files and report no-mistakes readiness the same way as for `/add-project`; batch the readiness list into one
message (or a lavish table) instead of asking per project.

## Dropping a project (/drop-project)

    bin/toli project drop <name> [--delete-clone]

- Default keeps the clone on disk and only removes the record.
- `--delete-clone` deletes `projects/<name>/`. It is irreversible, so confirm with Malik first, in plain words, even if
  he typed the flag.
- The CLI refuses when the clone is dirty or has unpushed commits. Never work around that refusal (no reset, stash,
  clean, or force). Report what is uncommitted or unpushed and let Malik decide.
- Leave `data/notes/<name>.md` in place unless Malik asks to remove it.
- Drop any queued or held backlog tasks for the project only with Malik's word: `bin/toli task drop <id>`.
