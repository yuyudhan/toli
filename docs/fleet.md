# Machines: the fleet

toli runs on one machine or many. Each machine has its own clone of toli and its own private records; the jawans on
all of them together form the paltan. The lead uses whichever machine is free.

## Roles

- **Coordinator**: the machine whose lead you talk to day to day. It sees the whole fleet
  (`bin/toli digest --fleet`), syncs every machine (`bin/toli sync --all`), and receives the other machines' results
  in its inbox.
- **Worker**: has some projects cloned and runs their work and scheduled jobs. Every job result and remote-run
  outcome is also sent to the coordinator's inbox; when the coordinator is unreachable, results wait in
  `state/outbox/` and the per-minute ticker retries them. On a worker, `bin/toli doctor` warns while results wait
  there; a backlog that does not drain means `ssh <coordinator ssh> true` fails from the worker. When the
  coordinator's ssh name changes (a VPN peer re-registered under a new name), re-run `bin/toli init` on every worker
  with the new `--coordinator-ssh` and update the coordinator's entry in each `config/fleet.json`.

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

    bin/toli resources [--json]               # this machine: load, memory/disk, runs, build slots, clones, available?
    bin/toli fleet status [--json]            # every machine, probed over ssh in parallel; unreachable is not fatal
    bin/toli pick [--project <p>] [--json]    # best machine for one unit of work; exit 2 with reasons when none

A machine is available when it is under every threshold in `config/machine.json` (defaults shown; `maxRuns` defaults
to `max(1, floor(cpus / 4))`). Free disk is never a threshold. Under `diskKeepGB`, the disk keeper frees build output
before work starts instead ([disk.md](disk.md)):

```json
{ "capacity": { "maxRuns": 2, "maxLoadPerCpu": 0.8, "minMemAvailableMB": 2048, "diskKeepGB": 60 } }
```

`capacity.maxRuns` is also a hard cap on `bin/toli spawn` jawans here: with that many running, a new spawn (or an
automatic continuation) is queued and starts when one ends (`--now` overrides). `capacity.autoResume` (default 3)
is how many times a chain of runs that stalled (no progress for `capacity.stallMinutes`, default 30) or used an
explicit `--max-time` without a report is resumed in the same session
([harnesses.md](harnesses.md#jawans-on-any-harness-bintoli-spawn)).

`pick` scores each available machine by min(cpu headroom, memory headroom) minus its share of busy run slots. Within
0.1 of the best it prefers this machine, then one that already has the clone, then name order. A machine that is
asleep, unreachable, or busy is skipped. Apart from the spawn queue above and the build slots below, nothing is
locked or refused because a machine is busy: availability steers where work goes. When no machine is available, the
lead queues the task and tells you.

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

## Running work on another machine

    bin/toli remote auto "<prompt>" --project <p> [--max-time <minutes>]
    bin/toli remote <machine> "<prompt>" [--project <p>] [--task T<n>] [--max-time <minutes>]

`remote auto` prints `local` when this machine wins `pick` (the lead then dispatches jawans here). Otherwise it runs
`bin/toli project ensure` on the target when the project's URL is known here (clone and register if needed), then
pipes the prompt to `bin/toli exec` there. `exec` runs the prompt in headless omp with no time limit (an explicit
`--max-time` gives omp that limit and kills it 5 minutes after); a run with no progress for `capacity.stallMinutes`
is stopped and its own omp session resumed (up to `capacity.autoResume` times). It runs under the remote-run rules:
commit on the current branch only, never push, merge, open a PR, or ask questions; finish with the outcome and
evidence. The output is saved in `data/projects/<p>/runs/` (or `data/remote/` without a project) and the outcome
reaches the coordinator's inbox. `remote` hands an explicit limit and the project to `exec` in
`TOLI_EXEC_MAX_MINUTES` and `TOLI_EXEC_PROJECT`, not flags, so a target on an older toli still runs the prompt, under
that toli's own limit until it upgrades.

On the target, `exec` records the prompt as a jawan run like `bin/toli spawn` does (harness omp, the `--task` and
`--project`, its log in the run dir's `output.log`), so the target's `bin/toli runs --active`, `digest`, jawan slots
and `activeRuns` include it; the run ends `done` or `failed` with omp's exit, and `bin/toli run kill <id>` there
stops it. `exec` prints the run id on stderr, which lands in the issuing machine's saved output. The issuing machine
keeps its own record (the saved output file above); the outcome is not posted to the target's inbox. A target on a
toli from before this records nothing in `state/jawans/`. Commands a jawan on another machine runs on a worker over
plain ssh (builds, tests) are not runs there: that worker's `runs` never shows them, only its load and `ps` do.

`exec` and headless job runs also leave a record in `state/runs/` while they run; that is what `activeRuns` counts.
`exec` refuses to start (exit 1, the reasons on stderr) when the target's run slots are full (`activeRuns` at
`maxRuns`) or its free memory is under `minMemAvailableMB`, even when the target was named rather than picked by
`auto`; load alone does not refuse, since it swings with the builds already running.
Remote runs can take a long time, so the lead always starts them in the background and their result arrives in the
chat by itself.

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
