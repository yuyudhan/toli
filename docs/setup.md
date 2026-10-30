# First-run setup

After cloning (or installing with `install.sh`), open your agent in toli's directory and say **"set up toli"** (or
run `/setup`). The lead checks what is missing, asks you everything it needs in one message, runs toli's own
bookkeeping commands, and sends a jawan for the installs. Saying it again later resumes a half-done setup.

## The checklist

`bin/toli setup status` (or `--json`) always shows the full state:

```
toli setup: 3 of 10 steps remain, 2 optional - say "set up toli"

done     tools - Bun and git: bun 1.3.14, git /usr/bin/git
missing  machine - Machine config (config/machine.json): config/machine.json missing
           user: Question: what should this machine be called, and is it the coordinator ...? Then: bin/toli init ...
...
```

Each item has a stable id, a status, who closes it, and the exact fix command or question:

| id             | what is checked                                                     | status when absent                             | who              |
| -------------- | ------------------------------------------------------------------- | ---------------------------------------------- | ---------------- |
| `tools`        | Bun (always, it runs `bin/toli`) and git on PATH                    | missing                                        | jawan            |
| `machine`      | `config/machine.json` (`bin/toli init`)                             | missing                                        | user             |
| `persona`      | `config/persona.json`; the default names are fine                   | optional                                       | user             |
| `harness-sync` | harness shims match `bin/toli harness sync`                         | missing                                        | jawan            |
| `harness-cli`  | at least one harness CLI installed and logged in                    | missing                                        | jawan, then user |
| `scheduler`    | the per-minute tick (`bin/toli schedule status`) runs this checkout | missing (runs another checkout: user decides)  | jawan            |
| `local`        | `local/` seeded (scripts/, hooks/, helpers.json, README.md)         | missing                                        | lead-command     |
| `git-hooks`    | `core.hooksPath` is `.githooks` (only when the checkout has one)    | missing                                        | jawan            |
| `fleet`        | other machines in `config/fleet.json`; a worker's coordinator       | optional (worker without coordinator: missing) | user             |
| `project`      | at least one project in `data/projects.json`                        | missing                                        | user             |

- **user**: needs your answer (or your own login, which may open a browser).
- **lead-command**: one `bin/toli` command that writes only toli's own records; the lead runs it.
- **jawan**: changes outside toli's records (installs, launchd/crontab, git config, tracked files); a jawan does it.

The harness check stops at the first ready harness, starting with the default jawan harness, so it stays fast.

## Told once

At session start the lead (and you) see one line, only when it is new:

    Setup: 3 steps remain - say "set up toli" (bin/toli setup status lists them)

It appears on the first run and again only when a step is missing that was not missing the last time it was shown.
Finishing steps never re-triggers it. `state/setup-shown.json` remembers the last shown set.

Where it shows up:

- `bin/toli digest` (text) prints it under the header; every harness runs the digest at session start.
- omp: the extension takes it at session start, shows it as a notification, and hands it to the lead's first turn.
- Claude Code: the SessionStart hook (`bin/toli hook claude-session-start`, written by `bin/toli harness sync`).

The digest's Next block is not told-once: while any step is missing it names them every time (`Setup: 3 steps
remain (...): say "set up toli" ...`), so a fresh install never reads "Nothing pending".

Commands:

    bin/toli setup status [--json]   # full checklist, every time
    bin/toli setup notice [--json]   # the told-once line (empty when nothing new); marks it shown
    bin/toli setup snooze            # quiet until a new step is missing
    bin/toli setup seed-local        # create local/ without touching existing files

## What "set up toli" does

The `toli-setup` skill (`/setup` command, in every harness after `bin/toli harness sync`):

1. reads `bin/toli setup status --json`;
2. asks one batched question for the user items: machine name and role (coordinator or worker), persona names,
   default jawan harness, default workspace strategy (`same-branch`, `branch-per-task`, `worktree-per-task`), first
   project to add, other machines, and any login you must do yourself;
3. runs the bookkeeping: `bin/toli init`, `config/persona.json`, `harness.jawan` and `defaults.workspace` in
   `config/machine.json`, `bin/toli setup seed-local`, `/add-project`, `config/fleet.json`;
4. dispatches one jawan for the rest: harness installs, `bin/toli harness sync`, `bin/toli schedule install`,
   `git config core.hooksPath .githooks`;
5. re-checks until status says `complete`.

Re-running `bin/toli init` keeps every other setting in `config/machine.json` (capacity, harness, retention), so
setup can always be resumed safely.

## Persona names

The default names are Malik (you), Sardar (the lead, plural Saradars), and jawan (a worker, plural jawans). Pick your
own in `config/persona.json`; the lead then uses them everywhere (`bin/toli digest` prints the active names):

```json
{ "user": "Boss", "lead": "Lead", "leadPlural": "Leads", "worker": "worker", "workerPlural": "workers" }
```

## By hand

Everything "set up toli" does can be done directly. Requirements: [Bun](https://bun.sh), git, omp (scheduled jobs
run in headless omp), and optionally `no-mistakes` ([delivery.md](delivery.md#the-no-mistakes-gate)) and the forge
CLIs for your projects ([delivery.md](delivery.md#forges-push-and-pull-requests)).

    git clone https://github.com/yuyudhan/toli toli && cd toli && bun install    # or the installer: docs/install.md

    bin/toli init --name <machine> --role coordinator            # the machine you talk to
    bin/toli init --name <machine> --role worker --coordinator-ssh <host> --coordinator-root <path>   # every other one

    bin/toli harness sync        # link skills and commands into each harness (docs/harnesses.md)
    bin/toli schedule install    # run bin/toli job tick every minute (docs/jobs.md)
    bin/toli doctor              # bun, omp, git, forge auth, no-mistakes, config, clones, fleet, scheduler
    bin/toli setup status        # what is still missing

Other machines go in `config/fleet.json` ([fleet.md](fleet.md)); projects are added with `/add-project` or
`bin/toli project add` ([projects.md](projects.md)).
