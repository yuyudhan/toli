# Machines: the fleet

toli runs on one machine or many. Each machine has its own clone of toli and its own private records; the jawans on
all of them together form the paltan. The lead uses whichever machine is free.

## Roles

- **Coordinator**: the machine whose lead you talk to day to day. It sees the whole fleet
  (`bin/toli digest --fleet`), syncs every machine (`bin/toli sync --all`), and receives the other machines' results
  in its inbox.
- **Worker**: has some projects cloned and runs their work and scheduled jobs. Every job result and remote-run
  outcome is also sent to the coordinator's inbox; when the coordinator is unreachable, results wait in
  `state/outbox/` and the per-minute ticker retries them.

Set the role once per machine (the "set up toli" flow asks for it, [setup.md](setup.md)):

    bin/toli init --name <machine> --role coordinator
    bin/toli init --name <machine> --role worker --coordinator-ssh <host> --coordinator-root <path>

List every machine in `config/fleet.json` on each machine that should see or dispatch to the others:

```json
{
    "machines": [{ "name": "<machine>", "ssh": "<host>", "root": "/path/to/toli" }]
}
```

The machines reach each other over plain `ssh` (`<host>` is anything `ssh` accepts, including an alias from
`~/.ssh/config`). Each machine's `data/projects.json` lists only the clones on that machine; a project may be cloned
on several.

## Capacity and picking a machine

    bin/toli resources [--json]               # this machine: load, free memory/disk, active runs, clones, available?
    bin/toli fleet status [--json]            # every machine, probed over ssh in parallel; unreachable is not fatal
    bin/toli pick [--project <p>] [--json]    # best machine for one unit of work; exit 2 with reasons when none

A machine is available when it is under every threshold in `config/machine.json` (defaults shown; `maxRuns` defaults
to `max(1, floor(cpus / 4))`):

```json
{ "capacity": { "maxRuns": 2, "maxLoadPerCpu": 0.8, "minMemAvailableMB": 2048, "minDiskFreeGB": 5 } }
```

`pick` scores each available machine by min(cpu headroom, memory headroom) minus its share of busy run slots. Within
0.1 of the best it prefers this machine, then one that already has the clone, then name order. A machine that is
asleep, unreachable, or busy is skipped. Nothing is ever locked or refused because a machine is busy: availability
only steers where work goes. When no machine is available, the lead queues the task and tells you.

## Running work on another machine

    bin/toli remote auto "<prompt>" --project <p>
    bin/toli remote <machine> "<prompt>" [--project <p>]

`remote auto` prints `local` when this machine wins `pick` (the lead then dispatches jawans here). Otherwise it runs
`bin/toli project ensure` on the target when the project's URL is known here (clone and register if needed), then
pipes the prompt to `bin/toli exec` there. `exec` runs the prompt in headless omp for up to an hour, under the
remote-run rules: commit on the current branch only, never push, merge, open a PR, or ask questions; finish with the
outcome and evidence. The output is saved in `data/projects/<p>/runs/` (or `data/remote/` without a project) and the
outcome reaches the coordinator's inbox.

`exec` and headless job runs leave a record in `state/runs/` while they run; that is what `activeRuns` counts.
Remote runs can take a long time, so the lead always starts them in the background and their result arrives in the
chat by itself.

## Keeping machines in sync

Tracked files (contract, skills, CLI, docs) travel through git; private files never leave their machine.

    bin/toli sync          # git pull --ff-only in this clone; refuses when tracked files have local changes
    bin/toli sync --all    # this clone, then every other machine in config/fleet.json over ssh

In chat: `/sync-toli` (this machine) or `/sync-toli --all`. Release installs upgrade with `bin/toli upgrade`
instead ([install.md](install.md#upgrading)).
