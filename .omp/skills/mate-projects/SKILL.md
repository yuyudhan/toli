---
name: mate-projects
description: Register, configure, and remove projects mate can dispatch work into - clone, seed the notes file, check no-mistakes readiness, clone on another machine, and set the delivery mode. Use for /add-project, /drop-project, or when Malik asks to add, remove, move, or change how a project is delivered.
---

# Managing projects

Projects live in `projects/<name>/` (gitignored) and are recorded in `data/projects.json`. Each machine's registry
lists only the clones on that machine; a project may be cloned on several machines. Each has one delivery mode.

## Adding a project (/add-project)

1. Get the name and git URL from Malik's arguments. If the URL is missing, ask once.
2. Decide where the clone lives. Default is this machine. If Malik names another machine, run it there:
   `bin/mate remote <machine> "/add-project <name> <git-url>"`. Work is sent to whichever machine is free later
   (`bin/mate remote auto ... --project <name>` clones it on demand with `bin/mate project ensure`).
3. Decide the delivery mode: `commit` (default), `pr`, or `no-mistakes`. Only set a non-default mode when Malik says
   so.

        bin/mate project add <name> <git-url> [--mode commit|pr|no-mistakes]

4. Seed the notes file `data/notes/<name>.md`. Dispatch one `scout` subagent (effort lo) to read the project's
   README, AGENTS.md / CLAUDE.md, and build files, and return:
    - stack and package manager
    - install, build, test, lint, and smoke commands
    - main entry points and directory map
    - gotchas the project's own docs call out
   Write the result into the notes file. Keep it short; it is fed into every brief for this project.
5. Report no-mistakes readiness. `mate project add` prints whether a `no-mistakes` git remote exists. If it does not,
   tell Malik and offer to run `no-mistakes init` in the clone. Run it only after Malik approves. Readiness only
   matters if he will ever want branch/PR delivery through the gate (`skill://mate-nm`).
6. Confirm to Malik: name, path, machine, mode, notes seeded, no-mistakes ready or not.

## Changing settings

    bin/mate project set <name> --mode commit|pr|no-mistakes

## Ensuring a clone exists

    bin/mate project ensure <name> <git-url> [--mode m]

Idempotent: no-op when registered and cloned, registers an existing unregistered clone, otherwise clones and
registers. `bin/mate remote auto --project` runs it on the target machine before dispatching.

## Listing

    bin/mate project list [--json]    (--json includes `cloned`)
    bin/mate project path <name>

## Importing existing clones

About 100 existing clones will be migrated from `~/code/firstmate/projects/` into `projects/` and registered with
`bin/mate project import` (check `bin/mate project import --help` for its arguments). After an import, seed missing
notes files and report no-mistakes readiness the same way as for `/add-project`; batch the readiness list into one
message (or a lavish table) instead of asking per project.

## Dropping a project (/drop-project)

    bin/mate project drop <name> [--delete-clone]

- Default keeps the clone on disk and only removes the record.
- `--delete-clone` deletes `projects/<name>/`. It is irreversible, so confirm with Malik first, in plain words, even if
  he typed the flag.
- The CLI refuses when the clone is dirty or has unpushed commits. Never work around that refusal (no reset, stash,
  clean, or force). Report what is uncommitted or unpushed and let Malik decide.
- Leave `data/notes/<name>.md` in place unless Malik asks to remove it.
- Drop any queued or held backlog tasks for the project only with Malik's word: `bin/mate task drop <id>`.
