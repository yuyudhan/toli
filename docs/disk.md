# The disk keeper

Low free disk never stops work on a toli machine. No floor refuses a spawn, a pick, or a build. When free space on
the volume holding toli is under the floor, toli deletes rebuildable output until free space is back at the floor.
Nobody has to decide anything and nobody is asked. The floor is `capacity.diskKeepGB` in `config/machine.json`
(default 60), but never more than 15% of the volume's size: a setting too high for a small disk would otherwise keep
the keeper deleting forever, since free space could never reach it. On a 117 GB disk with `diskKeepGB` 100 the floor
is 17.5 GB, and `bin/toli disk keep` says so: `floor 17.5 GB (15% of 117.0 GB disk; capacity.diskKeepGB 100 is above
it)` (`--json`: `floorGB`, `floorNote`, `diskTotalGB`; the same text reaches `logs/disk.log` whenever the keeper
runs or skips).

**A full disk means delete the build folders.** Every `target/` folder can go when the disk is nearly full, even one a
running build uses: cargo builds it again. If free space is still under the emergency level after the idle steps
(max(5 GB, 3% of the disk), never above the floor; `--json`: `emergencyGB`), the keeper first removes Docker volumes
of idle build output (step 5), then wipes busy targets between build steps (step 6), then deletes the `target/`
folders in the clones and task worktrees, in use or not, then the rest of the build output (step 7), re-checking
free space after each item and stopping once it is over the emergency level. It never deletes part of a target a
build uses: a target goes whole or not at all. Over the emergency level a build folder in use is never touched, so a disk a little under its floor never costs
a running build its output. A Sardar or jawan on any machine that finds its disk full runs `bin/toli disk keep` and
never asks first.

    bin/toli disk keep [--dry-run] [--floor <GB>] [--json]

## When it runs

- Before every jawan starts (`bin/toli spawn`, queued runs a finishing run starts, automatic continuations) and
  before every `bin/toli exec`. It runs inline, and the run starts anyway.
- Every minute from the tick (`bin/toli schedule install`), detached: the tick only reads free disk and, under the
  floor, starts a background `bin/toli disk keep` to do all of it (every step below, the last resort included), then
  goes on.
  The tick's own queue drain runs no keeper. A slow keeper (on an I/O-starved disk one run can take an hour) so never
  holds up a tick. Nothing starts while a keeper runs or a live pause holds it; in a dry run nothing starts.
- By hand, with `bin/toli disk keep`. `--dry-run` (or `TOLI_DRY_RUN=1`) lists what would go and counts each folder's
  size as freed. `--floor` overrides the floor and is not capped (it is the caller's choice), so a dry run with a high
  floor shows the whole plan.

Only one keeper runs at a time (`state/disk-keep.lock` holds its pid). Every action goes to `logs/disk.log`. A reason
the keeper did not run (paused, or another keeper busy) is logged once when it starts, not on every minute's tick.

## Switching automatic deletion off

`"capacity": { "diskKeep": false }` in `config/machine.json` (default `true`) turns every automatic deletion off on
that machine: before a jawan start, in the tick, the background keeper and the fallback sweep. Toli then deletes
nothing on its own; `bin/toli disk keep` run by hand still works as below, and says `automatic deletion: off`. Low
disk only alerts: before a jawan start and in every tick toli reads free disk, and when it is under 10 GB (or the
emergency level, when that is higher) it posts one inbox item, at most once per machine every 6 hours
(`state/disk-alert.stamp`), titled `disk low on <machine>`, naming the biggest build folders so that machine's own
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
going on now goes last. Steps 1 to 5 spare build output in use; steps 6 and 7, under the emergency level only, do
not. Steps 5 to 7 run only under the emergency level and stop as soon as free space is over it, so build output in
use goes only when nothing idle is left. Each item freed is logged with its size and its step (`deleted <path>, freed
X GB (step 1: idle target)`, `removed docker volume <name> (23.1 GB), freed 22.0 GB (step 5: idle build volume)`).

1. Whole `target/` folders of project checkouts that nothing uses. A checkout is all registered projects' clones
   plus their git worktrees. Nothing uses it when no running jawan works in it (or, for a main clone, on its
   project) and no process has its working directory inside it. The wipe still takes cargo's locks and checks
   that no process uses the target (see 6), so a build or test started from elsewhere is never cut off.
2. `node_modules/` and `dist/` of those idle checkouts, unless a process holds a file in them open. A project main
   clone's `node_modules/` is never deleted: builds run there between jobs (a project's build queue) and do not
   reinstall dependencies on their own, while cargo rebuilds a wiped `target/` by itself.
3. Docker: `docker builder prune -af`, then `docker image prune -f` (dangling images only); under the emergency level
   (see 7) `docker image prune -af`, every image no container uses. This step never touches volumes or containers
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
   entry is only a cache miss.
5. Only under the emergency level (see 7): Docker volumes of idle build output, largest first (sizes from `docker
system df -v`), until free space is over that level. A volume is build output only when its name says so (ends in
   `target`, as `kalki_backend_target` or `app-target` do, or contains `cargo` or `node_modules`) or a container mounts
   it at a `target` or `node_modules` folder or a `cargo` path (`/app/target`, `/usr/local/cargo/registry`). Never
   one whose name or any mount point may hold data, whatever else matches: a name or mount point containing `pg`,
   `postgres`, `sql`, `maria`, `mongo`, `redis`, `valkey`, `data`, `db`, `upload`, `media`, `minio`, `elastic`,
   `opensearch`, `clickhouse`, `kafka`, `rabbit`, `backup`, `storage`, `vault` or `secret` (`kept docker volume
<name>: ... may hold data`). Never one a running, paused, restarting or just-created container uses (`kept docker
volume <name>: container <c> uses it (running)`); a stopped (`exited` or `dead`) container that still mounts it is
   removed first (`docker rm`, never `-v`, so its other volumes stay; `compose up` creates it again), since Docker
   refuses to remove a volume a container references. Like step 3 it never runs while a `docker pull`, `build`,
   `buildx`, `compose up` or `load` runs (`docker volumes: skipped (pid N ... is running)`). Docker's build cache
   already went in step 3. On macOS Docker Desktop keeps volumes in its VM disk image, so the host may get the space
   back only later; the keeper logs what free space actually gained.
6. Only under the emergency level (see 7): every `target/` still left, busy checkouts included, between build steps.
   Over that level a target in use is left whole (`kept <target> in use: free X GB is over the emergency level Y GB`):
   its build may have run for an hour, and the disk is not yet full.
   The keeper takes cargo's own file locks (`.cargo-lock`, `.cargo-build-lock`, `.cargo-artifact-lock`; cargo holds
   them while it compiles) and then checks that no process uses the target. Cargo releases its locks before it runs
   the test binaries, so the locks alone are not enough. The target is in use when, from the process table (`ps`,
   then each process's executable, mapped files and working directory: `lsof -d cwd,txt` on macOS, `/proc/<pid>/exe`
   and `/proc/<pid>/cwd` on Linux), any process runs an executable or maps a file under it, works inside its
   workspace (the folder holding `target/`), or is `cargo`, `rustc`, `rustdoc`, `clippy-driver`, `just` or one of the
   machine's own build tools (`capacity.diskBuildTools`, below) working in, above, or naming that workspace; when a
   cargo process (`cargo`, `cargo-clippy`, `cargo-nextest`, ...) runs in the folder holding the target (`cargo test`
   drops its locks before it runs the test binaries one after
   another); or when any process holds a file under it open. A process table it cannot read counts as in use. On
   Linux every one of these checks, and the working directories and open files of steps 1 and 2, reads `/proc`
   (`/proc/<pid>/cwd`, `exe`, `maps`, `fd/*`, `comm`), so they hold where `lsof` is not installed. Each skip is
   logged with its reason. Only then does it rename the folder aside under the locks, release them, and delete
   the renamed tree (where the rename fails, as it can on a full disk, it deletes the folder in place under the locks).
   A cargo that starts meanwhile waits on the lock, then builds into an empty target.

    A target that is in use right now (jawans building it back to back hold its lock all the time) is kept whole:
    the keeper never deletes part of a target under a live build. Cargo links up-to-date artifacts it compiled hours
    ago, so artifacts left unwritten for hours are not stale to a running build, and deleting them breaks it at link
    time (`crate ... required in rlib format, but was not found`). Such a target goes only in step 7, whole. The
    keeper tries the wipe once; it checks `state/disk-keep.pause` before the wipe, so a job that writes the pause is
    not cut off.

7. The last resort, only when free space is still under the emergency level after steps 1 to 6: max(5 GB, 3% of the
   disk), never above the floor (6.8 GB on a 228 GB disk, 14 GB on a 468 GB one). Under the floor but over that
   level the keeper stops after step 4 (`done, still under the floor`) and build output in use stays. Under it,
   the `target/` folders still there, in use or not, held lock or not, are deleted outright, one at a time until
   free space is over that level (`free X GB is under the emergency level Y GB: deleting every build folder left, in
use or not, until free space is over that level`). Then, while it is still under that level, the `node_modules/`
   (never a main clone's, see 2) and `dist/` left (Vite's cache is
   `node_modules/.vite`, so it goes with them) and Playwright's downloaded browsers (the `chromium-1140`-style folders
   in `PLAYWRIGHT_BROWSERS_PATH`, else `~/Library/Caches/ms-playwright` on macOS and `~/.cache/ms-playwright` on
   Linux; `playwright install` fetches them again). Docker's build cache already went in step 3, its idle build
   volumes in step 5. Each deletion is logged with what it freed (`deleted <path>, freed X GB (step 7: last
resort)`), and an in-use folder first with why it was in use
   (`<path> is in use (...): deleting it anyway`); `--json` sets `lastResort`. A build that loses its target fails
   once and compiles again; the message before a jawan start says so.

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
(`git ls-files --others --ignored --exclude-standard --directory`). So it never touches sources, git data, tracked
`dist/` folders, or uncommitted work. Beyond those folders it deletes only Playwright's browser builds and sccache
entries. Of Docker's volumes it removes only the idle build-output ones of step 5 (the name and mount patterns
there), with the stopped containers that mount them; never a volume that may hold data or one a running container
uses, and nothing outside this account's registered checkouts and
its own caches.

## Settings

```json
{ "capacity": { "diskKeep": true, "diskKeepGB": 60, "diskSweepStaleMinutes": 180, "diskBuildTools": ["my-queue"] } }
```

`diskKeep` false leaves all deleting to the lead (see above). `diskKeepGB` is the floor in GB, capped at 15% of the
size of the volume holding toli (see the top of this page).
`diskSweepStaleMinutes` is how long an artifact in an idle target must go unused before the fallback sweep (see "On a
full disk") deletes it (a positive number of minutes; at 1440 or more, Linux `relatime` access times count too).
`diskBuildTools` (default none) names this machine's own build tools, such as a project's build queue that runs
cargo from above its workspaces: while one runs, a target in a workspace it works in, above or names counts as in
use. An entry is a program name, matched against every word of a command line by file name (`my-queue` also
matches a script `/opt/tools/my-queue.ts`), or several words that must follow each other (`my-tool queue`).

Each machine reads its own `config/machine.json`. Machine-private cleanup scripts ([helpers.md](helpers.md)) can
still run on top of the keeper, but none of them may refuse work on low disk.
