# Machines: the fleet

toli runs on one machine or many. Each machine has its own clone of toli, its own private records and its own lead;
the jawans on all of them together form the paltan. Work goes to the machine with the shortest queue, through that
machine's lead ([sardars.md](sardars.md)).

## Roles

- **Every machine has a lead.** Its lead service (`bin/toli lead install`) keeps one lead conversation served when
  no terminal session is open. Each lead dispatches only its own machine's jawans, every jawan reports only to it,
  and leads hand work to each other with `bin/toli delegate` ([sardars.md](sardars.md)).
- **Coordinator**: the machine whose lead you talk to day to day, and the one that keeps the fleet view. It sees the
  whole fleet (`bin/toli digest --fleet`), syncs every machine (`bin/toli sync --all`), and receives the other
  machines' job results and toli alerts in its inbox.
- **Worker**: any other machine. Every job result and alert is also sent to the coordinator's inbox; when the
  coordinator is unreachable, results wait in `state/outbox/` (with any delegations, delegated-task reports and
  `talk` messages for other machines) and the per-minute ticker retries them. On a worker, `bin/toli doctor` warns
  while results wait there; a backlog that does not drain means `ssh <coordinator ssh> true` fails from the worker.
  When the coordinator's ssh name changes (a VPN peer re-registered under a new name), re-run `bin/toli init` on
  every worker with the new `--coordinator-ssh`.

Set the role once per machine (the "set up toli" flow asks for it, [setup.md](setup.md)):

    bin/toli init --name <machine> --role coordinator
    bin/toli init --name <machine> --role worker --coordinator-ssh <host> --coordinator-root <path>

### The fleet list

The coordinator's `config/fleet.json` is the fleet list; list every machine there:

```json
{
    "machines": [{ "name": "<machine>", "ssh": "<host>", "root": "/path/to/toli" }]
}
```

Workers take it from the coordinator: every `bin/toli self sync` on a worker (and `bin/toli fleet sync` by hand)
reads the coordinator's `bin/toli fleet export` over ssh and rewrites its own `config/fleet.json`, so a machine added
or removed on the coordinator reaches every worker with its next sync. The machines reach each other over plain
`ssh` (`<host>` is anything `ssh` accepts, including an alias from `~/.ssh/config`). An alias only exists where it
is configured, so the export gives each machine as `user@host` resolved through the coordinator's ssh config; a
worker reaches the coordinator by its own `coordinator.ssh` and keeps the ssh name it already has for a machine it
lists (edit a worker's entry to point at an alias that works there; the next sync keeps it). A worker whose
coordinator is unreachable keeps its list and says why. Each machine's `data/projects.json` lists only the clones on
that machine; a project may be cloned on several.

## Capacity and picking a machine

    bin/toli resources [--json]               # this machine: queue, load, memory/disk, runs, build slots, clones
    bin/toli fleet status [--json]            # every machine, probed over ssh in parallel; unreachable is not fatal
    bin/toli fleet queues [--json]            # every machine's queue, lightest per jawan slot first
    bin/toli pick [--project <p>] [--json]    # the machine for one unit of work; exit 2 with reasons when none

`pick` and `fleet queues` rank machines by queue per jawan slot: queued tasks plus running and waiting jawan runs,
over `capacity.maxRuns` (active tasks with no jawan here, such as a lead's bookkeeping or work delegated elsewhere,
are not queue). Lightest first; on equal load a machine with the project's clone wins, then this machine, then name
order. Left out: an unreachable machine, one whose lead said it is full (`bin/toli lead full`), or one without the
project's clone when its URL is unknown here; when none is left, `pick` exits 2. Every `lead.balanceMinutes` the
lead service compares the queues and wakes its lead with an offer or an ask for work
([sardars.md](sardars.md#queues-decide-where-work-goes)).

The thresholds in `config/machine.json` (defaults shown; `maxRuns` defaults to `max(1, floor(cpus / 4))`) are shown
for information and never pass a machine over. Free disk is never a threshold either. Under `diskKeepGB`, the disk
keeper frees build output before work starts instead ([disk.md](disk.md)):

```json
{ "capacity": { "maxRuns": 2, "maxLoadPerCpu": 0.8, "minMemAvailableMB": 2048, "diskKeepGB": 60 } }
```

`capacity.maxRuns` is still a hard cap on `bin/toli spawn` jawans on each machine: with that many running, a new
spawn (or an automatic continuation) is queued and starts when one ends (`--now` overrides). `capacity.autoResume`
(default 3) is how many times a chain of runs that stalled (no progress for `capacity.stallMinutes`, default 30) or
used an explicit `--max-time` without a report is resumed in the same session
([harnesses.md](harnesses.md#jawans-on-any-harness-bintoli-spawn)). Apart from that spawn queue and the build slots
below, nothing is locked or refused because a machine is busy.

### Heavy-build slots

    bin/toli build-slot -- <command...>       # run a heavy build in one of this machine's build slots

Many cargo builds at once make every one of them slow, and slow builds hit time limits. So each machine has
`capacity.buildSlots` heavy-build slots (default `max(1, floor(cpus / 6))`: 3 on 18 cores, 1 on 4), and
`capacity.cargoJobs` (default `max(1, floor(cpus / buildSlots))`: 6 on 18 cores, 4 on 4) compile jobs per slot, so
all slots busy use about every core once. Setting either key in `config/machine.json` overrides its default.

`bin/toli build-slot -- <command>` takes a free slot, runs the command with `CARGO_BUILD_JOBS` at one slot's share and
`TOLI_BUILD_SLOT` set to the slot's number, and frees the slot when the command ends. When every slot is busy it prints
`waiting for a heavy-build slot (N busy)` once and waits for one; it never fails for lack of a slot. A slot is a lock
on `state/build-slots/<n>.lock` held by the `build-slot` process, so a holder that is killed or crashes frees its
slot at once. Inside a slot already (`TOLI_BUILD_SLOT` set), it runs the command at once: a nested build never waits
on its own slot.

`bin/toli spawn` puts toli's cargo shim (`bin/shims/cargo`) first on every jawan's PATH and sets its
`CARGO_BUILD_JOBS` to `capacity.cargoJobs`. The shim sends the heavy cargo commands (`build`, `check`, `test`,
`clippy`, `nextest`, `run`, `bench`, `doc`, `install`, `rustc`, `rustdoc` and their one-letter aliases) through
`bin/toli build-slot`, and runs everything else (`cargo --version`, `metadata`, `fmt`, ...) and any cargo inside a
slot straight away, with the first real cargo on PATH after the shim. `[build] jobs` in `~/.cargo/config.toml` holds
the same per-slot number so native subagents and hand-run cargo get it too (`bin/toli doctor` warns when the two
differ). `bin/toli resources` shows the slots as `builds <busy>/<total>` (`buildSlots` and `buildSlotsBusy` in
`--json`).

## Work on another machine

No machine starts a jawan on another. Work for another machine goes to its lead, which dispatches its own jawans
([sardars.md](sardars.md)):

    bin/toli delegate <machine> "<title>" --brief <file> [--project <p>] [--for T<n>]   # a task in its backlog
    bin/toli talk <machine> ["<words>"]          # attach to its lead conversation, or send it a message
    bin/toli lead install|status|attach          # this machine's lead service
    bin/toli task list --fleet [--cached]        # the shared list of every machine's tasks (<machine>/T<n>)
    bin/toli task answer <machine>/T<n> "<words>"   # answer a held delegated task; forwarded to its owner

A delegated task reports done, held or dropped back to the delegating machine's inbox by itself. A jawan's outcome
goes only to its own machine's inbox. `bin/toli remote` (every form, `remote auto` included) refuses and points to
`pick` and `delegate`; `bin/toli exec` refuses a prompt from another machine. Jawans started by `remote` before the
cutover still finish, save their output in `data/projects/<p>/runs/` (or `data/remote/`) and report as before.

## Oversight

    bin/toli fleet check [--json] [--wake] [--local]

Nothing may sit idle silently, away mode (`/afk`) included. Two checks run from the tick, whatever a job prompt says:

- **Active tasks with no live run.** An active task whose recorded run ended `oversight.staleTaskMinutes` ago
  (default 15) is stale: a `bin/toli spawn` run no longer queued or running, a run started by `bin/toli remote
--task` before the cutover whose saved output says it finished after the task's jawan was recorded, or no jawan
  recorded at all. A task delegated with `--for` counts as active with the fleet id as its jawan. A harness subagent
  id toli cannot look up counts as live until such a record shows its run ended. The digest's Next block lists stale
  tasks first, with the run's last report line and any answer recorded since; every tick posts newly stale ones to
  the inbox once per ended run, so the lead gets a `[toli wake]` naming them. Recording a new jawan
  (`task start --agent`, `spawn --task`) clears it. A task is live while the run it names, or the latest run of that
  run's resume or replace chain, is queued or running, even when that run carries no task id (`task start --agent`
  also records the task on a run spawned without `--task`).
- **Tasks that wait.** `bin/toli task wait T<n> --on "<what>"` marks an active task as deliberately waiting (a
  deferred spawn, a push, another task). Next names it as `waiting on <what>` after the stale tasks, never as a
  re-dispatch; the tick and `fleet check` leave it out. Recording a new jawan or holding the task ends the wait. A
  machine's own helpers that defer or trigger work call it for the tasks they hold back.
- **Idle machines.** `fleet check` probes every machine (as `fleet status` does) and reads each reachable one's own
  backlog (`fleet check --local --json` over ssh). A reachable machine with no active run while queued work, or a
  stale active task, exists for a project cloned there is idle; every machine's stale tasks are named too. `--wake`
  posts the findings as one batched inbox item, only when there is something to act on. The coordinator's tick runs
  `fleet check --wake` every `oversight.fleetCheckMinutes` (default 60), detached when other machines must be
  reached over ssh, in-process on a lone machine.

Both intervals live in `config/machine.json` (defaults shown):

```json
{ "oversight": { "staleTaskMinutes": 15, "fleetCheckMinutes": 60 } }
```

## Keeping machines in sync

Tracked files (contract, skills, CLI, docs) travel through git; private files never leave their machine.

Workers run release tags; the coordinator, where toli itself is developed, runs `develop`. A worker's checkout is a
release install: detached at a `vX.Y.Z` tag, moved only by `bin/toli upgrade` (which `bin/toli sync` runs there).
The coordinator's checkout is a development clone on `develop`, where `bin/toli commit toli` lands work and
`just release` cuts the tags ([releasing.md](releasing.md)). To put a worker on releases once (clean tree, no active
runs): `git -C <root> fetch --tags origin && git -C <root> checkout --detach vX.Y.Z && bin/toli self sync`.

    bin/toli sync          # development clone: git pull --ff-only; release install: bin/toli upgrade (latest tag)
    bin/toli sync --all    # this clone, then every other machine in config/fleet.json over ssh

Both refuse when tracked files have local changes. In chat: `/sync-toli` (this machine) or `/sync-toli --all`. So
after a release, `sync --all` on the coordinator pulls `develop` there and upgrades every worker to the new tag
(checkout, `migrate`, `harness sync`, runtime); each worker's running jawans finish on the runtime they started with
([install.md](install.md#upgrading)). A new tag alone changes nothing: the update notice tells the owner, and workers
move on his word.
