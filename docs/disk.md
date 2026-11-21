# The disk keeper

Low free disk never stops work on a toli machine. No floor refuses a spawn, a pick, or a build; only a disk under the
emergency level with nothing left to free but build folders in use pauses new jobs ("When only folders in use are
left"). When free space on
the volume holding toli is under the floor, toli deletes rebuildable output until free space is back at the floor.
Nobody has to decide anything and nobody is asked. The floor is `capacity.diskKeepGB` in `config/machine.json`
(default 60), but never more than 15% of the volume's size: a setting too high for a small disk would otherwise keep
the keeper deleting forever, since free space could never reach it. On a 117 GB disk with `diskKeepGB` 100 the floor
is 17.5 GB, and `bin/toli disk keep` says so: `floor 17.5 GB (15% of 117.0 GB disk; capacity.diskKeepGB 100 is above
it)` (`--json`: `floorGB`, `floorNote`, `diskTotalGB`; the same text reaches `logs/disk.log` whenever the keeper
runs or skips).

**A full disk means delete the build folders nothing uses.** Every build folder no jawan, gate, subagent, process or
live build uses can go when the disk is nearly full: it rebuilds itself. If free space is still under the emergency
level after the idle steps (max(5 GB, 3% of the disk), never above the floor; `--json`: `emergencyGB`), the keeper
removes Docker volumes of idle build output (step 5), then Playwright's browser cache (step 6, the last resort),
re-checking free space after each item and stopping once it is over the emergency level. **A build folder in use is
never deleted, at any step:** one in a checkout a running jawan, a live native subagent, a running gate or any process
works in, one cargo's locks hold, one a live build compiles into (a cargo or rustc working there or naming it, a held
heavy-build slot, a running gate; see "Live builds" below), one holding open files. The keeper says which it kept
(`skipped <path>: <why>`, `kept <path>: <why>`), and a run that ends still under the floor names each one it left
(`done, still under the floor: ...; left in use: <path> (<why>), ...`; `--json`: `inUseLeft`). A run that ends under
the emergency level with such folders left pauses new jobs instead (see "When only folders in use are left"): until
2026-11 the last resort deleted a busy checkout's build output too, and a worktree's `node_modules` went mid-gate
(T2030). A Sardar or jawan on any machine that finds its disk full runs `bin/toli disk keep` and never asks first,
and never deletes a `target/` with `rm -rf` itself: only the keeper sees a cargo in a build slot, a running gate and
cargo's own locks (T1901: a subagent's hand `rm -rf` of a target broke a `bin/toli build-slot -- cargo check`
compiling into it). When free space comes back over the floor while the keeper lists build folders, it deletes
nothing and says who freed it:
`done: free A -> B, freed by another process meanwhile, not the keeper`.

    bin/toli disk keep [--dry-run] [--floor <GB>] [--json] [--background]

## When it runs

- Before every jawan starts (`bin/toli spawn`, queued runs a finishing run starts, automatic continuations) and
  before every `bin/toli exec`. It runs inline, and the run starts anyway.
- Every minute from the tick (`bin/toli schedule install`), detached: the tick only reads free disk and, under the
  floor, starts a background `bin/toli disk keep --background` to do all of it (every step below, the last resort
  included), then goes on. `--background` skips the scan for builds outside the clones (below).
  The tick's own queue drain runs no keeper. A slow keeper (on an I/O-starved disk one run can take an hour) so never
  holds up a tick. Nothing starts while a keeper runs or a live pause holds it; in a dry run nothing starts. The tick
  records the keeper it started in `state/disk-keep.background.json` (pid, start time): while that pid is still that
  `toli disk keep`, no other starts, its lock released or not; once it has run 1 h the tick kills it
  (`disk keeper: killed background keeper pid <n>, running <m> min (limit 60 min)` in `logs/tick.log`) and starts
  another. A pid ps cannot show to be that keeper (reused after it ended) is never killed (T2170).
- By hand, with `bin/toli disk keep`. `--dry-run` (or `TOLI_DRY_RUN=1`) lists what would go and counts each folder's
  size as freed. It makes every check a real deletion makes (cargo's locks, taken and released at once, the processes,
  live builds and open files of a target wipe (step 1), open files under a `node_modules` or `dist`) and deletes
  nothing, so it keeps
  what a real run would keep, with the same reason; it never pauses jobs. `--floor` overrides the floor and is not
  capped (it is the
  caller's choice), so a dry run with a high floor shows the whole plan.

Only one keeper runs at a time (`state/disk-keep.lock` holds its pid). Every action goes to `logs/disk.log`. A reason
the keeper did not run (paused, or another keeper busy) is logged once when it starts, not on every minute's tick.
Every `bin/toli disk keep`, by hand or in the background, has a time limit of 2 h: a call that never returns (a
macOS privacy prompt nobody answers, a hung disk or tool) blocks the keeper's own thread, so a watchdog thread logs
`disk keeper: stopped after its time limit of 120 min` to `logs/disk.log` and stderr and kills the process; the next
run starts over (`src/fleet/disk-watchdog.ts`).

## Switching automatic deletion off

`"capacity": { "diskKeep": false }` in `config/machine.json` (default `true`) turns every automatic deletion off on
that machine: before a jawan start, in the tick, the background keeper and the fallback sweep. Toli then deletes
nothing on its own; `bin/toli disk keep` run by hand still works as below, and says `automatic deletion: off`. Low
disk only alerts: before a jawan start and in every tick toli reads free disk, and when it is under 10 GB (or the
emergency level, when that is higher) it posts one inbox item, at most once per machine every 6 hours
(`state/disk-alert.stamp`), titled `disk low on <machine>`, naming the biggest build folders (those of no-mistakes
run worktrees too, each with its run and status) so that machine's own
lead decides what goes ([sardars.md](sardars.md#each-machines-disk-is-its-own-leads-job)); it is not forwarded to the
coordinator. The tick posts it from a detached `bin/toli disk alert`, so sizing the
folders never holds the tick up; `bin/toli disk alert` by hand posts it at once. Any value but `true` or `false` also
deletes nothing and says why.

## Pausing it for a long job

A long job that must keep its build output for a while (a release build, a test gate, a benchmark) writes its own
pid to `state/disk-keep.pause`, optionally followed by a short reason, and removes the file when done:

    pause=/path/to/toli/state/disk-keep.pause        # in your toli checkout
    printf '%s\nrelease gate\n' "$$" > "$pause"      # first word: a pid; the rest: a reason
    ...                                              # the long job
    rm -f "$pause"

While that pid is alive the keeper deletes nothing (`bin/toli disk keep` says `paused by pid N (reason)`). Once the
pid is dead the file is stale and ignored, so a job killed before its cleanup never blocks the keeper for good. A
pause also expires 2 hours after the file was last written (its modification time), even while the pid lives: a
job that hangs, or forgets its cleanup while its shell lives on, cannot turn cleaning off for good. The keeper then
removes the file and logs once `pause by pid N expired after 2 h; cleaning resumed`. A job that runs longer than 2
hours touches the file again before then (`touch "$pause"`, say once an hour) to keep its pause. Use this file,
never `state/disk-keep.lock`: the lock belongs to the keeper itself.

## What it deletes, in order

It stops as soon as free space is back at the floor: no margin on top, since every build folder it deletes beyond
that is one a build would have reused, and the keeper runs again before the next jawan starts and every minute
anyway. Within each step it takes the least recently used folders first (by the newest modification time of the
folder and its direct children: a build rewrites `target/debug`, `node_modules/.bin`), so the output of the work
going on now goes last. No step takes build output in use. Steps 5 and 6, and a held clone's `target/` (step 1), run
only under the emergency level and stop as soon as free space is over it. Each item freed is logged with its size and
its step (`deleted <path>, freed X GB (step 1: idle target)`, `removed docker volume <name> (23.1 GB), freed 22.0 GB
(step 5: idle build volume)`).

0. Leftovers of an interrupted target wipe (see 1): every untracked `<name>.toli-wipe-<ms>` folder of a checkout, which
   nothing builds into any more, is deleted whole before anything else, root-owned files through a throwaway container
   as in step 1 (`deleted <path>, freed X GB (step 0: leftover of an interrupted target wipe)`, or `kept <path>: ...`
   with the reason).

1. Build output finished no-mistakes runs left in their worktrees, then Docker volumes of build caches no container
   uses, then whole `target/` folders of project checkouts that nothing uses. A checkout is all registered projects'
   clones plus their git worktrees. Nothing uses it when no
   running jawan works in it (or, for a main clone, on its project), no live native subagent's open task records it as
   its workspace (a jawan between two commands runs no process there; `skipped <dir>: T<n>'s jawan <id> works in
it`; a done or dropped task's old jawan tag holds nothing, since that subagent lives on in the lead session and
   moves to other tasks: a follow-up reopens the task first), no running gate checks it (`bin/toli gate run`, `push
--gate`, the pre-push hook; `skipped <dir>: a gate of <project> (pid N) runs in it`), and no process has its working
   directory inside it. The same check holds `node_modules/` and `dist/` in step 2. The wipe still takes cargo's locks
   and checks that no process and no live build uses the target (below and
   "Live builds"), so a build or test started from elsewhere is never cut off: the target is kept
   (`kept <target>: cargo (pid N) builds into it (CARGO_TARGET_DIR <dir>)`) and the keeper moves on to the next
   folder.

    Build-cache volumes come before any checkout's `target/` (T2232: a release lane's 120 GB target was wiped twice
    while an unused 112 GB cargo-target volume sat beside it). A volume is one when its name holds a word of
    `capacity.diskCacheVolumes` (case-insensitive; default `target`, `cargo`, `node_modules`), its name does not
    look like data (the data words of step 5), and no container mounts it, running or stopped. Largest first, until
    free space is back at the floor
    (`removed docker volume <name> (104.5 GB), freed 104.0 GB (step 1: unused build-cache volume)`). Only where
    Docker answers (`docker cache volumes: skipped (daemon not reachable)`), never while a pull or build runs; a
    volume a stopped container still mounts waits for step 5.

    A `target/` in a main clone a live native jawan's open task records as its workspace (a task pinned to the clone,
    such as a release train, between two commands), or in a checkout where a held heavy-build slot's holder works
    (whatever target that build compiles into), stays while free space is over the emergency level
    (`skipped <target>: <why>; kept until free disk is under the emergency level`). Under it, after step 5, it goes
    like any target nothing uses now (`step 1: idle target, under the emergency level`): a full disk still deletes
    `target/` folders.

    The wipe takes cargo's own file locks (`.cargo-lock`, `.cargo-build-lock`, `.cargo-artifact-lock`; cargo holds
    them while it compiles) and then checks that no process and no live build (see "Live builds") uses the target.
    Cargo releases its locks before it runs
    the test binaries, so the locks alone are not enough. The target is in use when, from the process table (`ps`,
    then each process's executable, mapped files and working directory: `lsof -d cwd,txt` on macOS, `/proc/<pid>/exe`
    and `/proc/<pid>/cwd` on Linux), any process runs an executable or maps a file under it, works inside its
    workspace (the folder holding `target/`), or is `cargo`, `rustc`, `rustdoc`, `clippy-driver`, `just` or one of the
    machine's own build tools (`capacity.diskBuildTools`, below) working in, above, or naming that workspace; when a
    cargo process (`cargo`, `cargo-clippy`, `cargo-nextest`, ...) runs in the folder holding the target (`cargo test`
    drops its locks before it runs the test binaries one after
    another); or when any process holds a file under it open. A process table it cannot read counts as in use. A
    process of the user's that cannot be inspected (lsof leaves out one caught mid-exec; Linux hides the files of one
    that is not dumpable, such as `systemd --user`, or one in a container) counts as in use only when its command
    line could run from the target: the command line names the target or its workspace, or its program is a file in
    the target (a relative program counts when it names one from a parent folder of the target). For a process in a
    container (its `/proc/<pid>/cgroup` names a container id) the program is looked up through the folders its
    `/proc/<pid>/mountinfo` mounts from the host, so another project's target, which no mount shows, stays free. On
    Linux every one of these checks, and the working directories and open files of steps 1 and 2, reads `/proc`
    (`/proc/<pid>/cwd`, `exe`, `maps`, `fd/*`, `comm`), so they hold where `lsof` is not installed. Each skip is
    logged with its reason. Only then does it rename the folder aside under the locks (`<target>.toli-wipe-<ms>`; the
    checkout's `.git/info/exclude` gets `*.toli-wipe-*` first, so `git status` and any dirty-tree check never list it),
    release them, and delete the renamed tree (where the rename fails, as it can on a full disk, it deletes the folder
    in place under the locks). A cargo that starts meanwhile waits on the lock, then builds into an empty target.
    Files a container wrote as root (a `target/` or `node_modules/` a compose stack built into) go through the same
    throwaway container as a no-mistakes run's (step 1), never sudo; a tree that still stays is logged
    (`kept <target>: renamed aside to <path>, which stays: <why>`) and deleted first by the next keeper run (step 0
    above), as is one a killed keeper left behind.

    A target that is in use right now (jawans building it back to back hold its lock all the time) is kept whole:
    the keeper never deletes part of a target under a live build. Cargo links up-to-date artifacts it compiled hours
    ago, so artifacts left unwritten for hours are not stale to a running build, and deleting them breaks it at link
    time (`crate ... required in rlib format, but was not found`). A target a live build uses never goes, nor one a
    lock or an open file holds. The keeper tries the wipe once; it checks
    `state/disk-keep.pause` before the wipe, so a job that writes the pause is not cut off.

    no-mistakes runs each gate push in a detached worktree, `$NM_HOME/worktrees/<repo>/<run>` (`NM_HOME` defaults to
    `~/.no-mistakes`), and removes it when the run ends, best effort: a run whose checks started a compose stack leaves
    that stack's root-owned `docker-data/backend/target` behind, about 20 GB a run. The keeper looks only under
    `$NM_HOME/worktrees/`: a run in a worktree root elsewhere is never freed. It reads no-mistakes' own state,
    `$NM_HOME/state.sqlite`, read only, again just before each deletion:
    a worktree is finished only when run records name it and every one is terminal (`completed`, `failed`,
    `cancelled`, `checks_passed`, `handed_off`, `ci_monitor_interrupted`). Anything uncertain counts as in use and
    keeps its build output at every step, the last resort included: a pending or running run, a status it does not
    know, a worktree no record names, a database it cannot read (`skipped <path>: no-mistakes run <id> is running`).
    In a finished run's worktree it takes the build folders a checkout has (see "What it never deletes") plus, inside its other ignored folders
    (up to 4 levels down, symlinks never followed), a `target` cargo marked as its own (`CACHEDIR.TAG` or
    `.rustc_info.json`) and `node_modules`; never a nested `dist` or unmarked `target`, nor the database or upload
    folders beside them. Each one still passes every check a target wipe makes (cargo's locks, processes, open files,
    live container mounts). Files a container wrote as root go through a throwaway container that binds the folder's
    parent and removes it (`docker run --rm --network none --user 0:0 ... busybox:latest rm -rf`), never sudo; with no
    docker to reach the folder stays (`kept <path>: it holds root-owned files, and docker is not reachable to remove
them (never sudo)`).

2. `node_modules/` and `dist/` of those idle checkouts, unless a process holds a file in them open. A project main
   clone's `node_modules/` is never deleted: builds run there between jobs (a project's build queue) and do not
   reinstall dependencies on their own, while cargo rebuilds a wiped `target/` by itself.

    A `target/`, `node_modules/` or `dist/` folder steps 1 and 2 deleted within the last 6 h that has grown back
    since is left alone while free disk is over the emergency level (`skipped <path>: the keeper deleted it N min ago
 and it grew back; ...`). A build that refills a folder at once means deleting it frees next to nothing, so with
    free disk just under the floor the keeper would otherwise delete the same folder every minute and cost that build
    its cache each time (T2122: a main clone's 0.6 GB `target/` went 71 times in one day, free disk 33.7 GB against a
    floor of 34). Each real deletion of those steps is recorded with its time in `state/disk-keep.deleted.json`
    (entries drop after 6 h; a file that cannot be read or written holds nothing back). Such a folder is never one in
    use: when free disk falls under the emergency level, in that run (before step 5) or a later one, it goes like any
    idle folder (`(step 1: idle target, under the emergency level)`), and it never counts toward pausing new jobs.

3. Docker: `docker builder prune -af`, then `docker image prune -f` (dangling images only); under the emergency level
   (see 6) `docker image prune -af`, every image no container uses. This step never touches volumes or containers
   (step 5 removes idle build-output volumes). A prune
   deletes what a pull or build in flight has fetched but not yet tagged or started (a `lease does not exist` or
   `lchown ... no such file` failure of `docker pull`), and an unused image a minute-old pull just left is gone before
   its container starts, so Docker is pruned only when it is due (`state/disk-docker-prune.json` holds when, free
   disk then, and what the last prune reclaimed):
    - not while a `docker pull`, `build`, `buildx`, `compose up` or `load` process runs on the machine (found in `ps`;
      a pull or build started through the Docker API by another tool is not seen, and `docker run`'s implicit pull is
      not either): `docker: skipped (pid N `docker pull ...` is running; ...)`. A `compose up` kept in the foreground
      keeps Docker unpruned while it runs;
    - at most once every 30 minutes;
    - after a prune that reclaimed 0 B, not again until free disk has dropped 1 GB below its level then, or 6 hours
      have passed.

    A dry run reads that state and applies the same rules but never writes it.

4. sccache: when its local cache is over its own cap, the oldest entries until it is back under the cap. A missing
   entry is only a cache miss. A cache at its cap is also handled on every tick, whatever the free disk (see "sccache
   at its cap" below).
5. Only under the emergency level (see 6): Docker volumes of idle build output, largest first (sizes from `docker
system df -v`), until free space is over that level. A volume is build output only when its name says so (ends in
   `target`, as `demo_backend_target` or `app-target` do, or contains `cargo` or `node_modules`) or a container mounts
   it at a `target` or `node_modules` folder or a `cargo` path (`/app/target`, `/usr/local/cargo/registry`). Never
   one whose name or any mount point may hold data, whatever else matches: a name or mount point containing `pg`,
   `postgres`, `sql`, `maria`, `mongo`, `redis`, `valkey`, `data`, `db`, `upload`, `media`, `minio`, `elastic`,
   `opensearch`, `clickhouse`, `kafka`, `rabbit`, `backup`, `storage`, `vault` or `secret` (`kept docker volume
<name>: ... may hold data`). Never one a running, paused, restarting or just-created container uses (`kept docker
volume <name>: container <c> uses it (running)`). A stopped (`exited` or `dead`) container that still mounts it is
   removed first (`docker rm`, never `-v`, so its other volumes stay; `compose up` creates it again), since Docker
   refuses to remove a volume a container references, but only when that container holds nothing but build output:
   every one of its mounts is a named build-output volume as above (no bind mount, tmpfs, anonymous volume or
   data-looking volume), and its image is no database or data store (`postgres`, `mysql`, `mariadb`, `mongo`,
   `clickhouse`, `redis`, `elasticsearch`, `opensearch`, `minio`, `rabbitmq`, `kafka`, `zookeeper`, `cassandra`,
   `etcd`, `vault`, a registry and the like). Otherwise the volume is skipped whole (`kept docker volume <name>:
stopped container <c> mounts it and its image postgres:16 keeps data`, `... it also has a bind mount <path> at
<dest>`) and the keeper moves on. Like step 3 it never runs while a `docker pull`, `build`,
   `buildx`, `compose up` or `load` runs (`docker volumes: skipped (pid N ... is running)`). Docker's build cache
   already went in step 3. On macOS Docker Desktop keeps volumes in its VM disk image, so the host may get the space
   back only later; the keeper logs what free space actually gained.
6. The last resort, only when free space is still under the emergency level after steps 1 to 5: max(5 GB, 3% of the
   disk), never above the floor (6.8 GB on a 228 GB disk, 14 GB on a 468 GB one). Under the floor but over that
   level the keeper stops after step 4 (`done, still under the floor`). Under it, Playwright's downloaded browsers go
   (the `chromium-1140`-style folders in `PLAYWRIGHT_BROWSERS_PATH`, else `~/Library/Caches/ms-playwright` on macOS
   and `~/.cache/ms-playwright` on Linux; `playwright install` fetches them again), unless a process holds a file in
   them open (`free X GB is under the emergency level Y GB: deleting Playwright's browsers; build folders in use
stay`, `deleted <path>, freed X GB (step 6: last resort)`); `--json` sets `lastResort`. Docker's build cache
   already went in step 3, its idle build volumes in step 5. Build output in use stays even here, as does a folder a
   live container mounts (see "What it never deletes"). A run that still ends under the floor names every folder it
   left in use (`left in use: <path> (<why>), ...`, `--json`: `inUseLeft`).

### When only folders in use are left

A run that ends under the emergency level with build folders in use left pauses new jobs: it writes
`state/disk-hold.json` (why, since when, and until when: 30 minutes on, renewed by every keeper run that ends the same
way) and, when the pause starts, posts one inbox item, `disk full on <machine>: new jobs paused, only build folders in
use left`, naming each folder and what uses it (`new jobs paused until free disk is over the emergency level (...);
alert posted to the inbox` in `logs/disk.log`; `--json`: `jobsPaused`). While it holds:

- a new jawan run is queued, not started (`queued <run>: new jobs paused (since <time>): <why>; it starts once the
disk keeper lifts the pause`); `bin/toli spawn --now` still starts one;
- queued jawan runs stay queued (the tick and a finishing run's supervisor start none);
- the tick starts no scheduled job (`due jobs not started: <names>: new jobs paused ...` in `logs/tick.log`); each
  stays due and runs once the pause lifts. `bin/toli job run <name>` by hand still runs.

Running work goes on: as it ends, its folders are no longer in use and the next keeper run (every minute from the
tick while free disk is under the floor) frees them. A keeper run that ends over the emergency level, or a tick that
finds free disk back over the floor, lifts the pause (`new jobs resume: free X GB is ...`); a pause no keeper renews
lapses after its 30 minutes.

### Live builds

A live build is a running `cargo` (`cargo`, `cargo-clippy`, `cargo-nextest`, ...) or `rustc`, a held heavy-build
slot ([fleet.md](fleet.md), "Heavy-build slots"), or a running gate (`bin/toli gate run`, `push --gate`, the pre-push
hook: a `running` record in `state/gates/<project>/` whose runner is alive, building in the checkout it names). It
compiles into the `CARGO_TARGET_DIR` in its environment when one is set (relative to its working directory, as cargo
reads it), else into the target of the workspace it works in, or above it within the same git checkout (a `just`
recipe or a gate runs cargo from a checkout's top); a build above the checkout holding the workspace, such as a slot
held from toli's own checkout above every task worktree under `projects/`, builds none of that checkout's targets.
An argument naming a path in a target (`--target-dir`, rustc's `--out-dir`) or a workspace's
`Cargo.toml` (`--manifest-path` from elsewhere) uses that target too. The keeper reads cargo and rustc processes from
`/proc/<pid>/comm`, `cwd`, `environ` and `cmdline` on Linux, and from `ps -E` and `lsof -d cwd` on macOS; a slot's
holder writes its working directory and `CARGO_TARGET_DIR` into the slot's lock file (`state/build-slots/<n>.lock`)
when it takes the slot, and the keeper reads that only while the slot is held. A build in a slot or a gate is
therefore seen even between two cargo runs, and a build whose target lies outside the checkout it works in (a shared
`CARGO_TARGET_DIR`) is seen too. Such a target is never deleted, at any step.

### sccache at its cap

An sccache server whose local cache sits at its cap evicts an entry for every one it stores, and a long-lived one can
wedge there: its clients sleep on its socket, it starts no compiler, and builds freeze for an hour while it still
answers `sccache --show-stats` (mozilla/sccache#629). `sccache --stop-server` frees them at once: the next compile
starts a fresh server and a cargo already running goes on with it. So the minute tick, whatever the free disk, checks
this user's running sccache server (src/fleet/sccache-keep.ts): when `--show-stats` reports its local cache at 95% of
its cap or more, it deletes the oldest entries until the cache is at 80% of its cap, then, once the server runs no
compiler (no child process), stops it with `sccache --stop-server`; a fresh server sizes its cache from the folder and
starts with that headroom. A server running a compiler is never stopped; the tick asks again a minute later. It sends
no signal, never touches another user's server, and asks nothing when no server of this user's runs, so it never
starts one. `logs/tick.log` gets a line when it trims or stops (`sccache: 20.0 GiB at its 20.0 GiB cap: trimmed ...;
stopped the sccache server (pid N), the next compile starts a fresh one`); a dry run (`TOLI_DRY_RUN=1`) only says
what it would do. A server run by a service manager (a systemd user unit) exits on `--stop-server` like any other;
the next compile starts one when the unit does not restart it.

## On a full disk

`bin/toli disk keep` works at 0 bytes free. It writes nothing before it has freed something: log lines wait in
memory until the first deletion (then go to `logs/disk.log`), `bin/toli disk` runs Bun with its transpiler cache off
(`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`), and a keeper lock it cannot write is done without (the log says
`freeing without the keeper lock`). A write that fails never stops it. It runs no shell and expands no glob, so it
behaves the same under any login shell (a zsh loop over `*/target` aborts with `no matches found` when one pattern
matches nothing). If the keeper fails anyway (free disk unreadable, a broken `config/machine.json`), a fallback
sweeps the stale artifacts out of every target nothing uses, with no keeper lock and no free-disk reading: every entry
directly inside `<profile>/deps`, `build`, `.fingerprint` and `incremental` (any profile dir up to three levels down:
`target/debug`, `target/<triple>/release`, ...) that went unused for `capacity.diskSweepStaleMinutes` (default 180).
It takes cargo's locks first, as the wipe does, and holds them while it deletes, so a target in use stays whole
(`kept <target>: in use (...)`). Unused means no file in the entry was read or written since, judged by access time
where the mount keeps it current enough and by modification time elsewhere: `noatime` mounts, Linux `relatime` (the
default; it refreshes access times at most once a day, so access time counts only for an age of a day or more), and
macOS volumes not mounted `strictatime`. The fallback reads the mount's options from `/proc/self/mounts` or `mount`
and names its choice in the log line (`swept N stale artifacts from <target> (unused for M min, by mtime: relatime
mount ...), freed X GB (B bytes)`). It never deletes a cargo lock file, anything holding one, anything newer than the
age, or anything a process holds open, runs or maps (lsof; `/proc` on Linux). Then the command exits 1 with the reason
instead of a crash. The keeper run before every jawan start and from the tick falls back the same way.

If `bin/toli` itself cannot run, delete the git-ignored `target/` folders by hand with `find` from the toli checkout
(no glob, nothing written; a tracked folder named `target` is not ignored, so it stays), then run `bin/toli disk keep`:

    find "$PWD/projects" -type d -name target -prune -exec sh -c \
        'git -C "$1/.." check-ignore -q "$1" && rm -rf "$1"' _ {} \;

## What it never deletes

A candidate is only a folder named `target`, `node_modules` or `dist` that git lists as ignored and wholly untracked
(`git ls-files --others --ignored --exclude-standard --directory`), or, in a finished no-mistakes run's worktree, a
cargo-marked `target` or a `node_modules` inside such an ignored folder (step 1). So it never touches sources, git
data, tracked `dist/` folders, or uncommitted work. Beyond those folders it deletes only Playwright's browser builds
and sccache entries. Of Docker's volumes it removes only the unused build caches of step 1 and the idle build-output
ones of step 5 (the name and mount patterns there), with the stopped containers that mount them; never a volume that
may hold data or one a running container uses, and nothing outside this account's registered checkouts, no-mistakes
run worktrees and its own caches.

It never deletes a build folder a live (running, paused, restarting or just-created) Docker container mounts, at any
step, the last resort included: a folder that is a bind mount's host folder, holds a volume's mountpoint, or is where
one of the container's mounts sits inside one of its bind mounts. A compose stack that binds `./apps/backend` at
`/app` and mounts the volume `backend_target` at `/app/target` hangs that volume on the host's `apps/backend/target`;
deleting that folder unhooks the volume inside the running container, whose `/app/target` then falls through to
whatever the bind shows, and the live backend breaks (T1256). The log says `kept <path>: container <c> (running)
mounts volume <v> at /app/target, over <path>; a folder a live container mounts is never deleted`. Docker is asked
once per run, at the first folder about to go. No docker, or a daemon this account cannot reach, means no container
holds anything; a daemon that answers but whose containers cannot be listed keeps every build folder that run. A
bind of the whole checkout alone does not hold its build folders.

## Builds outside the clones

AGENTS.md rule 5 (one code folder, one build folder) is enforced in code (`src/fleet/build-place.ts`), not only in
briefs. The known places are a registered project's clone (`data/projects.json`), a task worktree toli made for a
`worktree-per-task` project (`projects/.worktrees/<project>/<T-id>`), a no-mistakes run worktree
(`<NM_HOME>/worktrees/<repo>/<run>`, the gate's own) and toli's own checkout.

- `bin/toli build-slot -- <command>`, and so the cargo shim, which sends every heavy cargo command there (inside a
  slot too), refuses a build whose working tree is none of those places, before it queues for a slot. The working
  tree is the git toplevel of the cwd, or of the folder of cargo's `--manifest-path` (words after `--` belong to the
  program and are not read), climbing out of submodules; outside git it is the folder itself, which must lie in one of
  the places. A git worktree a jawan added, a `git archive` export or a `/tmp` copy is refused with
  `refusing to build in <tree>`. Light cargo commands (`metadata`, `fmt`, ...) build nothing and run anywhere.
- `TOLI_BUILD_PLACE_OVERRIDE="<why>"` lets one build through anyway, for an exception the user agreed to: it
  prints `building outside the clones` and appends `{at, tree, cwd, command, reason, pid}` to
  `logs/build-place.log`. An empty or blank value overrides nothing.
- `bin/toli disk keep` by hand (`flagged, not deleted:` lines; `outsideBuilds` and `outsideScanComplete` in `--json`;
  never the tick's background keeper, whose lines nobody reads) and
  `bin/toli doctor` (`build-place`, a warning per folder, the first 10) flag, never delete, folders outside those
  places under `/tmp`, `$TMPDIR` and the home folder that hold a `target/` or `node_modules/`, and every
  `git worktree list` entry of toli's checkout or a registered clone that toli did not make. The scan reads up to 3
  levels below each of those folders (10,000 folders and 60 s each at most), skipping hidden folders, `Library`
  folders and the home folder's privacy-protected ones (`~/Desktop`, `~/Documents`, `~/Downloads`, `~/Movies`,
  `~/Music`, `~/Pictures`): on macOS opening one raises a privacy prompt that blocks the scan until someone answers.

A cargo that bypassed the shim (another cargo ahead of it on PATH) reaches toli only through the rustc wrapper
([fleet.md](fleet.md#heavy-build-slots)), which takes a slot but does not check the place. toli has no node or pnpm
wrapper, so `npm`, `pnpm` and `bun` builds are not checked when they start; their `node_modules/` outside the places
still shows up in `disk keep` and `doctor`.

## Settings

```json
{
    "capacity": {
        "diskKeep": true,
        "diskKeepGB": 60,
        "diskSweepStaleMinutes": 180,
        "diskBuildTools": ["my-queue"],
        "diskCacheVolumes": ["target", "cargo", "node_modules"]
    }
}
```

`diskKeep` false leaves all deleting to the lead (see above). `diskKeepGB` is the floor in GB, capped at 15% of the
size of the volume holding toli (see the top of this page).
`diskSweepStaleMinutes` is how long an artifact in an idle target must go unused before the fallback sweep (see "On a
full disk") deletes it (a positive number of minutes; at 1440 or more, Linux `relatime` access times count too).
`diskBuildTools` (default none) names this machine's own build tools, such as a project's build queue that runs
cargo from above its workspaces: while one runs, a target in a workspace it works in, above or names counts as in
use. An entry is a program name, matched against every word of a command line by file name (`my-queue` also
matches a script `/opt/tools/my-queue.ts`), or several words that must follow each other (`my-tool queue`).
`diskCacheVolumes` (default `["target", "cargo", "node_modules"]`) lists the words that mark a Docker volume a build
cache by its name, case-insensitive: one no container mounts goes in step 1, before any checkout's `target/`. A name
that looks like data never counts, whatever word it holds.

Each machine reads its own `config/machine.json`. Machine-private cleanup scripts ([helpers.md](helpers.md)) can
still run on top of the keeper, but none of them may refuse work on low disk.
