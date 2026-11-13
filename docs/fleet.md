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
  A coordinator that takes no inbound ssh pulls them instead ([below](#machines-that-take-no-inbound-ssh)).
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

toli's calls to other machines share one ssh connection per host: they run `ssh -F state/ssh/config`, a generated
config that includes `~/.ssh/config` and `/etc/ssh/ssh_config` first and then sets `ControlMaster auto`, `ControlPath
state/ssh/%C` and `ControlPersist 10m` for every host, so the calls of the next ten minutes reuse one login instead of
opening a connection each (which security monitoring reads as many logins). ssh keeps the first value it reads, so a
host's own `Control*` lines in your ssh config win (`ControlMaster no` turns sharing off for it). `state/ssh` is
mode 0700. Before a call, a control socket whose master does not answer `ssh -O check` within 2 seconds is removed,
so a wedged master never holds a call past its timeout; the master, which carries every shared session (long `exec`
runs too), drops a link dead for two minutes (`ServerAliveInterval 30`, `ServerAliveCountMax 4`). A checkout whose
path is too long for a unix socket there (`state/ssh` longer than 45 characters) opens a connection per call, as
before.

### Machines that take no inbound ssh

A machine that takes no inbound ssh is never ssh-ed into by toli on any other machine (a personal computer the fleet
must not log into). It still ssh-es out: its delegations and `talk` reach the others over ssh as usual. Mark it in
either of two places; one is enough:

- **On the machine itself**, at setup: `bin/toli init --name <machine> --role <role> ... --inbound off` writes
  `"inbound": false` to its `config/machine.json` (`--inbound on` clears it; a rerun without the option keeps it). Its
  tick pulls from then on, whatever its copy of the list says, and each pull carries the flag to the machine pulled
  from (below).
- **On the coordinator's list**, as its entry's `"inbound": false`:

```json
{ "name": "<machine>", "ssh": "<host>", "root": "/path/to/toli", "inbound": false }
```

The list's flag reaches the machine only through `fleet sync` or a pull, so a machine marked only there, whose list
was copied before the flag was set, never learns it while its coordinator takes no inbound ssh either. Mark such a
machine on itself.

Everything the others would deliver to it over ssh (job results and alerts, `talk`, delegations, delegated-task
reports and links, share answers, task answers and escalated answers, queue offers) stays in their
`state/outbox/`. Its minute tick runs `bin/toli outbox pull`: it ssh-es to each other machine and runs `bin/toli
outbox pending --for <itself>` there (the items queued for it, oldest first, by when they were queued), applies each
item here with the same `bin/toli` command an ssh delivery would have run (`inbox add`, `delegation
receive|update|link`, `share receive`, `task answer`), then runs `bin/toli outbox ack --for <itself>` there, which
drops the applied items and, for a delegation, records the task id it got. So:

- **Each item is applied once.** An applied item is recorded in `state/pulled/<machine>.json` until its ack lands;
  pulled again (the ack was lost), it is acknowledged again, not re-applied.
- **Nothing is lost while either side is offline.** A machine that does not answer keeps its items for the next
  pull; an item that fails to apply stays queued.
- **Order holds per sender.** The first item that fails stops that sender's batch until it applies.
- **A machine speaks only for itself.** An item whose `from` is not the machine it was pulled from is dropped, not
  applied.

The pull also carries this machine's `fleet export`: a worker whose coordinator takes no inbound ssh takes its list
from each pull (its own `fleet sync` does not contact the coordinator), and any other machine learns the flag. From
then on no toli call there ssh-es into it: sends queue for the pull, fleet reads (`fleet status`, `digest --fleet`,
`task list --fleet`, `fleet check`, `sync --all`) skip it with the reason, `talk <machine>` without words refuses,
and a call that forgot the check fails in `sshArgs` before running ssh. `bin/toli doctor` there reports such
messages as waiting for the pull (a warning only once the oldest is 10 minutes old, i.e. the pulls stopped), never as
an ssh problem. To take ssh again, drop the flag on the coordinator (and run `bin/toli init ... --inbound on` on the
machine if it was marked there) and run `bin/toli outbox pull` once there: the list it carries clears the flag on the
others, and their queued items go by ssh from then on.

`bin/toli doctor` catches a machine whose pulls never started:

- On the pulling machine, a `pull` line: a warning while it has never pulled (`state/pull-last.json` records the
  last pull that reached a machine, over ssh or HTTPS).
- On a sender, the `outbox` line names a puller that has never asked it for its items (`state/pullers.json` records
  each one's last ask) once the oldest is 10 minutes old, with the fix: mark it on itself with `--inbound off`.
- On a sender, items for a machine reached by ssh that have waited over an hour add a hint: if that machine takes no
  inbound ssh, mark it so it pulls them.

#### Two machines that both take no inbound ssh

Neither can reach the other: a pull skips a sender marked `"inbound": false` (it could not ssh in), and a send to a
pull-only machine only queues. They exchange messages through a **relay**, a paired peer both reach: each pairs with
it, and each runs `bin/toli peer trust <other> --key <its key> --via <relay>`. Items then travel sealed for the
recipient and signed by the sender, so the relay can neither read nor forge them, and the recipient applies each as
a message from its sender ([peers.md](peers.md#relay)). The ssh pull still never takes items one machine left for
another: there a machine speaks only for itself.

### Unreachable machines

Each tick moves the fleet's messages in one pass: a machine that takes no inbound ssh first pulls (from every other
machine at once, with a 5 s `ConnectTimeout`, each machine's items applied as soon as they arrive, so one that is
down or slow never holds up another's), then the outbox goes out (5 s `ConnectTimeout` too). Within the pass a host
is tried until its first failure only: its other items wait, in their order, for the next pass, and the tick log has
one line for them (`outbox: pending 3 items for itlinux4 left queued: ...`). A host the tick's ssh did not reach
(ssh's own exit 255, or a timeout) is also backed off across ticks in `state/reach.json`: the tick leaves it alone for
30 s after the first failure, doubling with each one after, at most 10 minutes; any call that reaches it clears that.
The pull line counts such machines (`pull: 2 waiting, 2 applied, 2 acknowledged; 4 machine(s) held back`). A hand-run
`bin/toli outbox pull`, and a send's own delivery, try backed-off machines anyway and do not back them off.

Passes never overlap: one that finds the previous still running (overlapping cron ticks) leaves the round to it. A
tick that waits on its headless job runs runs a pass every minute meanwhile, since launchd and systemd start no tick
while one is running.

## Capacity and picking a machine

    bin/toli resources [--json]               # this machine: queue, load, memory/disk, runs, build slots, clones
    bin/toli fleet status [--json]            # every machine, probed over ssh in parallel; unreachable is not fatal
    bin/toli fleet queues [--json]            # every machine's queue, lightest per jawan slot first
    bin/toli pick [--project <p>] [--json]    # the machine for one unit of work; exit 2 with reasons when none

`pick` and `fleet queues` rank machines by queue per jawan slot: queued tasks plus running jawans (spawn runs and
native subagents recorded with `task start --agent`) plus waiting runs, over `capacity.maxRuns` (active tasks with no
jawan here, such as a lead's bookkeeping or work delegated elsewhere, and held tasks are not queue). Lightest first;
on equal load a machine with the project's clone wins, then this machine, then name
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

`capacity.maxRuns` is still a hard cap on jawans on each machine, shared by `bin/toli spawn` runs and the lead's native
subagents (active tasks recorded with `task start --agent <id>`; [harnesses.md](harnesses.md)): with that many
running, a new spawn (or an automatic continuation) is queued and starts when one ends (`--now` overrides), and
`resources`, `fleet queues` and the digest say `jawans at cap N/N (...): queue instead`. `capacity.autoResume`
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
`TOLI_BUILD_SLOT` set to the slot's number, and frees the slot when the command ends. The test harnesses get the same
share: `RUST_TEST_THREADS` and `NEXTEST_TEST_THREADS` are set to it unless the caller already set them, so a
`cargo test` or `cargo nextest` in a slot never runs a test thread per core. When every slot is busy it prints
`waiting for a heavy-build slot (N busy)` once and waits for one; it never fails for lack of a slot. Waiters are served
in arrival order: each holds a numbered ticket in `state/build-slots/queue/` and only the oldest live one takes a slot
that frees, so a later build never passes an earlier one. A slot is a lock on `state/build-slots/<n>.lock` held by the
`build-slot` process, and a ticket is a lock held the same way, so a holder or waiter that is killed or crashes frees
its slot or its place in line at once. The lock files stay once made, one per slot number ever used (a `2.lock` on a
machine now at one slot is from when it had two); only the lock on a file says its slot is busy. Inside a slot
already (`TOLI_BUILD_SLOT` set), it runs the command at once: a nested build never waits on its own slot.

A project's push check takes one slot for its whole run the same way, because its recipe may call cargo directly
(a `just` recipe, a hook that resets PATH), where the cargo shim below never sees it: a gate's runner
(`bin/toli gate run`, `bin/toli push --gate`, [delivery.md](delivery.md#gates-long-checks-run-once-per-tree)) runs
the recipe in a slot, and `bin/toli push` in a project with a pre-push hook runs `git push`, and so the hook, in one.
Cargo reads the slot's variables from the environment however it is reached, and a cargo, `build-slot` or gate the
check starts runs inside that slot at once. On Linux the whole check (the gate's recipe, or `git push` and so its
hook) also runs in the slot's memory-capped scope below, so every cargo it starts shares that one cap; the runner
still watches the recipe's own process tree for stalls. A live-stack project's checkout skips the slot here too.

On Linux with a systemd user manager, each build also runs in its own user scope,
`toli-build-<slot>-<pid>.scope` (slot 0 where flock is unavailable, pid of the `build-slot` process), started with
`systemd-run --user --scope --collect -p MemoryHigh=<90% of cap> -p MemoryMax=<cap> -p MemorySwapMax=0`. The build
cannot swap: without `MemorySwapMax=0` a build at its cap pushed the rest of its memory into swap, and once the
machine's swap filled systemd-oomd killed the whole build anyway. An out-of-memory kill (the kernel at the cap, or
systemd-oomd under memory pressure) then takes that one build, not the terminal, tmux server or lead session that
started it. The cap is `capacity.buildMemoryMax` in MB (default three quarters of the RAM split evenly over the build
slots: 16384 with 64 GB and 3 slots, so every slot at its cap still leaves a quarter for the rest; 0: no cap, still its
own scope). The build's exit code, or the signal that killed it, is reported as without a scope. A nested build
(inside a slot, or in a process already in a `toli-build-*` scope) stays in its parent's scope; without
`systemd-run` or a user manager (crontab-only boxes, containers, macOS) the build starts as before. Inside the scope
`/bin/sh` creates `state/build-slots/scope-<pid>.started` and then execs the build; when systemd-run exits without it
(it could not make the scope: no user session bus over ssh, no lingering), the build never ran, so it runs once
without a scope after one warning line. A build that ran and failed reports its own exit code and is not run again.
`TOLI_BUILD_SCOPE=off` turns the scope off. `systemctl --user list-units 'toli-build-*'` lists the running ones;
`systemctl --user show` on a scope already gone (`--collect`) reports the defaults (`MemoryMax=infinity`), not its cap.

`bin/toli spawn` puts toli's cargo shim (`bin/shims/cargo`) first on every jawan's PATH, gives it one slot's share of
the cores (`CARGO_BUILD_JOBS` at `capacity.cargoJobs`, and `RUST_TEST_THREADS` and `NEXTEST_TEST_THREADS` at the same
number unless already set) and makes toli's rustc wrapper (`bin/shims/toli-rustc-wrapper`) its `RUSTC_WRAPPER`, with
`CARGO_CACHE_RUSTC_INFO=0` (below). So every cargo it starts, the pre-push hook of a plain `git push` included, gets
the share however it reached cargo, and `cargo test` never compiles its doctests one rustc per core (rustdoc runs
one per test thread, past the rustc wrapper). A lead session started in toli's root gets the same variables for
itself, so the native subagents it starts (omp `task`, Claude Code's Agent tool), which inherit its environment, build
the same way: omp's toli extension adopts them into the omp process when it loads (any omp that is not a
`bin/toli spawn` jawan), and Claude Code's SessionStart hook writes them to `CLAUDE_ENV_FILE`, which Claude sources
before every Bash command; both read them from `bin/toli hook lead-build-env`. The shim sends the heavy cargo
commands (`build`, `check`, `test`, `clippy`, `nextest`, `run`, `bench`, `doc`, `install`, `rustc`, `rustdoc` and
their one-letter aliases) through `bin/toli build-slot`, and runs everything else (`cargo --version`, `metadata`,
`fmt`, ...) and any cargo inside a slot straight away, with the first real cargo on PATH after the shim.

PATH order alone is not enough: a login profile, a harness's shell snapshot or git (its exec path, in a hook) can put
`~/.cargo/bin` ahead of the shim, and that cargo then never sees the shim. The rustc wrapper catches it: cargo calls
it for every rustc it runs, whichever cargo PATH found, starting with its `rustc -vV` probe. Cargo caches that probe
in the build folder (`target/.rustc_info.json`), so a cargo with nothing left to compile (a `cargo test` that only
runs its tests and doctests) would never call the wrapper at all; `CARGO_CACHE_RUSTC_INFO=0` turns the cache off, so
the probe is every cargo's first act and the slot is taken before anything runs. Inside a slot it goes
straight on. Otherwise, on the first call of a cargo running a heavy command, `bin/toli build-slot --cargo <pid>`
starts a detached holder (`build-slot --hold <pid>`) that waits in line, takes a slot for that cargo and writes
`state/build-slots/cargo-<pid>.held`; the call waits (printing the same waiting line) until it holds. Later calls of
that cargo, of any cargo it starts (cargo-clippy's `cargo check`) and of its build scripts find the holder through
their process ancestry and go straight on, so a nested cargo reuses the slot and never deadlocks on it. The holder
frees the slot when the cargo exits or is killed (it polls the pid), and a killed holder frees it with its lock; the
cargo's next rustc call then takes one again. The wrapper then runs the wrapper it replaced (an inherited
`RUSTC_WRAPPER`, else `[build] rustc-wrapper` in `~/.cargo/config.toml`, such as sccache), or rustc itself. Such a
cargo holds a slot but no memory-capped scope: it was already running when it reached toli.

A build started in a live-stack project's checkout ([projects.md](projects.md#live-stack-mode)) skips the slots, as
that project's jawans run without the shim or the wrapper, at the same share of jobs and test threads. `[build] jobs`
in `~/.cargo/config.toml` holds the same per-slot number so hand-run cargo gets it too
(`bin/toli doctor` warns when the two differ). `bin/toli resources` shows the slots as `builds <busy>/<total>`
(`buildSlots` and `buildSlotsBusy` in `--json`).

#### Dev stacks and heavy builds

A dev container that rebuilds its project on every save (a backend under a file watcher, compiling inside Docker) is a
build outside every slot: beside a gate it doubles the load and fills the disk with its own target copy. A project
declares such containers in its notes' `## Local stack` section, on one line (see
[projects.md](projects.md#dev-stacks-that-rebuild-on-save)):

    - Pause during builds: app-backend, app-frontend

While any command holds a slot (`bin/toli build-slot`, a gate or push check, a cargo the rustc wrapper holds a slot
for), each declared container that runs is paused with `docker pause`: its processes freeze and its memory and data
stay. The first holder in pauses them, and the last holder out unpauses them, once no command holds a slot and none
waits for one, so a queue of builds pauses the stack once. Containers are only paused and unpaused, never stopped or
removed, and only those named: a database is never touched. Nothing is paused that is not running, and a container
Docker cannot pause is warned about and left running; the build still runs.

The paused names are kept in `state/build-slots/stacks.paused`. A failed unpause prints
`toli: could not unpause <name>: <docker's error>; run \`docker unpause <name>\``, keeps the name there, and is retried
when the next slot is freed and by the minute tick, which also resumes a stack a killed holder left paused (a holder
that is killed frees its slot with its lock, but cannot unpause). A live-stack project's declaration is ignored, like
its builds skip the slots: its running stack is the machine's one build.

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
  the inbox once per ended run, so the lead gets a `[toli wake]` naming them. A task answered less than the grace
  minutes ago is not stale: its lead dispatches it in the turn that recorded the answer (`task answer` posts no wake
  of its own; only an answer forwarded from another machine's lead does). Recording a new jawan
  (`task start --agent`, `spawn --task`) clears it. A task is live while the run it names, or the latest run of that
  run's resume or replace chain, is queued or running, even when that run carries no task id (`task start --agent`
  also records the task on a run spawned without `--task`).
- **Tasks that wait.** `bin/toli task wait T<n> --on "<what>"` marks an active task as deliberately waiting (a
  deferred spawn, a push, another task). Next names it as `waiting on <what>` after the stale tasks, never as a
  re-dispatch; the tick and `fleet check` leave it out, and `task list` (`--fleet` too) shows `(waiting on: <what>)`
  on its line. Recording a new jawan or holding the task ends the wait. A machine's own helpers that defer or trigger
  work call it for the tasks they hold back.
- **Idle machines.** `fleet check` probes every machine (as `fleet status` does) and reads each reachable one's own
  backlog (`fleet check --local --json` over ssh). A reachable machine with no active run while queued work, or a
  stale active task, exists for a project cloned there is idle; every machine's stale tasks are named too, and so is
  every machine whose peer listener is configured (`peer.listen`) but down or stuck on a replaced runtime
  ([peers.md](peers.md#the-listener)). `--wake` posts the findings as one batched inbox item, only when there is
  something to act on. The coordinator's tick runs `fleet check --wake` every `oversight.fleetCheckMinutes` (default
  60), detached when other machines must be reached over ssh, in-process on a lone machine.

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
(checkout, `migrate`, `harness sync`, runtime, and a reinstall of the lead service and tick wherever they are
installed); each worker's running jawans finish on the runtime they started with and are not stopped
([install.md](install.md#upgrading)). A new tag alone changes nothing: the update notice tells the owner, and workers
move on his word.
