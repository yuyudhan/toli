# The disk keeper

Low free disk never stops work on a toli machine. No floor refuses a spawn, a pick, or a build. When free space on
the volume holding toli is under `capacity.diskKeepGB` in `config/machine.json` (default 60), toli deletes rebuildable
output until free space is 20 GB above that floor. Nobody has to decide anything and nobody is asked.

**A full disk means delete the build folders.** Every `target/` folder can go at any time, even one a running build
uses: cargo builds it again. If free space is still under the floor after the normal steps, the keeper deletes every
`target/` folder in the clones and task worktrees, in use or not, then the rest of the build output (step 6). A
Sardar or jawan on any machine that finds its disk full runs `bin/toli disk keep` and never asks first.

    bin/toli disk keep [--dry-run] [--floor <GB>] [--wait <minutes>] [--json]

## When it runs

- Before every jawan starts (`bin/toli spawn`, queued runs, automatic continuations) and before every `bin/toli exec`.
  It runs inline and does not wait on busy builds. If that leaves the disk under the floor, it starts a background
  `bin/toli disk keep --wait 30`, and the run starts anyway.
- Every minute from the tick (`bin/toli schedule install`), the same way.
- By hand, with `bin/toli disk keep`. `--dry-run` (or `TOLI_DRY_RUN=1`) lists what would go and counts each folder's
  size as freed. `--floor` overrides the configured floor, so a dry run with a high floor shows the whole plan.

Only one keeper runs at a time (`state/disk-keep.lock` holds its pid). Every action goes to `logs/disk.log`. A reason
the keeper did not run (paused, or another keeper busy) is logged once when it starts, not on every minute's tick.

## Pausing it for a long job

A long job that must keep its build output for a while (a release build, a test gate, a benchmark) writes its own
pid to `state/disk-keep.pause`, optionally followed by a short reason, and removes the file when done:

    pause=/path/to/toli/state/disk-keep.pause        # in your toli checkout
    printf '%s\nrelease gate\n' "$$" > "$pause"      # first word: a pid; the rest: a reason
    ...                                              # the long job
    rm -f "$pause"

While that pid is alive the keeper deletes nothing (`bin/toli disk keep` says `paused by pid N (reason)`). Once the
pid is dead the file is stale and ignored, so a job killed before its cleanup never blocks the keeper for good. Use
this file, never `state/disk-keep.lock`: the lock belongs to the keeper itself.

## What it deletes, in order

It stops as soon as free space reaches the floor plus 20 GB. Steps 1 to 5 spare build output in use; step 6 does not.

1. Whole `target/` folders of project checkouts that nothing uses. A checkout is all registered projects' clones
   plus their git worktrees. Nothing uses it when no running jawan works in it (or, for a main clone, on its
   project) and no process has its working directory inside it. The wipe still takes cargo's locks and checks
   that no process uses the target (see 5), so a build or test started from elsewhere is never cut off. Oldest first.
2. `node_modules/` and `dist/` of those idle checkouts, unless a process holds a file in them open. A project main
   clone's `node_modules/` is never deleted: builds run there between jobs (the kalki queue's builder) and do not
   reinstall dependencies on their own, while cargo rebuilds a wiped `target/` by itself.
3. Docker: `docker builder prune -af`, then `docker image prune -af`. It never touches volumes or containers.
4. sccache: when its local cache is over its own cap, the oldest entries until it is back under the cap. A missing
   entry is only a cache miss.
5. Every `target/` still left, busy checkouts included, between build steps. A busy target is never simply skipped.
   The keeper takes cargo's own file locks (`.cargo-lock`, `.cargo-build-lock`, `.cargo-artifact-lock`; cargo holds
   them while it compiles) and then checks that no process uses the target. Cargo releases its locks before it runs
   the test binaries, so the locks alone are not enough. The target is in use when, from the process table (`ps`,
   then each process's executable, mapped files and working directory: `lsof -d cwd,txt` on macOS, `/proc/<pid>/exe`
   and `/proc/<pid>/cwd` on Linux), any process runs an executable or maps a file under it, works inside its
   workspace (the folder holding `target/`), or is `cargo`, `rustc`, `rustdoc`, `clippy-driver`, `just` or a kalki
   queue working in, above, or naming that workspace; when a cargo process (`cargo`, `cargo-clippy`, `cargo-nextest`,
   ...) runs in the folder holding the target (`cargo test` drops its locks before it runs the test binaries one after
   another); or when any process holds a file under it open. A process table it cannot read counts as in use. Each
   skip is logged with its reason. Only then does it rename the folder aside under the locks, release them, and delete
   the renamed tree (where the rename fails, as it can on a full disk, it deletes the folder in place under the locks).
   A cargo that starts meanwhile waits on the lock, then builds into an empty target.

    A target that is in use right now (jawans building it back to back hold its lock all the time) is swept instead
    of skipped: every entry directly inside `<profile>/deps`, `build`, `.fingerprint` and `incremental` (any profile
    dir up to three levels down: `target/debug`, `target/<triple>/release`, ...) that went unused for
    `capacity.diskSweepStaleMinutes` (default 180) is deleted, lock or no lock. The keeper logs, per target, how many
    artifacts it removed and the bytes that freed (`swept N stale artifacts from <target>`, then `freed X GB (B bytes)`;
    `--json` lists them under `swept`). Unused means no file in the entry was read or written since, judged by access
    time where the mount keeps it current enough and by modification time elsewhere: `noatime` mounts, Linux
    `relatime` (the default; it refreshes access times at most once a day, so access time counts only for an age of a
    day or more), and macOS volumes not mounted `strictatime`. The keeper reads the mount's options from
    `/proc/self/mounts` or `mount` and names its choice in the log line (`by mtime: relatime mount ...`). It never
    deletes a cargo lock file, anything holding one, anything newer than the age, or anything a process holds open,
    runs or maps (lsof). Cargo rebuilds an artifact it finds missing; a build already running that needs one swept
    from under it fails once and rebuilds it when run again.

    The inline keeper tries the wipe once and then sweeps; the background keeper also retries the wipe for up to 30
    minutes per target and checks `state/disk-keep.pause` again before every try, so a job that writes the pause while
    the keeper waits is not cut off.

6. The last resort, only when free space is still under the floor itself (not merely short of the floor plus 20 GB)
   after steps 1 to 5: every `target/` folder still there, in use or not, held lock or not, is deleted outright. Then,
   until free space reaches the floor plus 20 GB, every `node_modules/` (never a main clone's, see 2) and `dist/`
   left (Vite's cache is
   `node_modules/.vite`, so it goes with them) and Playwright's downloaded browsers (the `chromium-1140`-style folders
   in `PLAYWRIGHT_BROWSERS_PATH`, else `~/Library/Caches/ms-playwright` on macOS and `~/.cache/ms-playwright` on
   Linux; `playwright install` fetches them again). Docker's build cache already went in step 3. Each deletion is
   logged with what it freed (`deleted <path>, freed X GB`), and an in-use folder first with why it was in use
   (`<path> is in use (...): deleting it anyway`); `--json` sets `lastResort`. A build that loses its target fails
   once and compiles again; the message before a jawan start says so. The background keeper does not wait on busy
   targets after this.

## On a full disk

`bin/toli disk keep` works at 0 bytes free. It writes nothing before it has freed something: log lines wait in
memory until the first deletion (then go to `logs/disk.log`), `bin/toli disk` runs Bun with its transpiler cache off
(`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`), and a keeper lock it cannot write is done without (the log says
`freeing without the keeper lock`). A write that fails never stops it. It runs no shell and expands no glob, so it
behaves the same under any login shell (a zsh loop over `*/target` aborts with `no matches found` when one pattern
matches nothing). If the keeper fails anyway (free disk unreadable, a broken `config/machine.json`), a fallback
sweeps the stale artifacts out of every target as above, with no lock and no free-disk reading, then the command
exits 1 with the reason instead of a crash. The keeper run before every jawan start and from the tick falls back the
same way.

If `bin/toli` itself cannot run, delete the git-ignored `target/` folders by hand with `find` from the toli checkout
(no glob, nothing written; a tracked folder named `target` is not ignored, so it stays), then run `bin/toli disk keep`:

    find "$PWD/projects" -type d -name target -prune -exec sh -c \
        'git -C "$1/.." check-ignore -q "$1" && rm -rf "$1"' _ {} \;

## What it never deletes

A candidate is only a folder named `target`, `node_modules` or `dist` that git lists as ignored and wholly untracked
(`git ls-files --others --ignored --exclude-standard --directory`). So it never touches sources, git data, tracked
`dist/` folders, or uncommitted work. Beyond those folders it deletes only Playwright's browser builds and sccache
entries. It never removes Docker volumes or containers, and nothing outside this account's registered checkouts and
its own caches.

## Settings

```json
{ "capacity": { "diskKeepGB": 60, "diskSweepStaleMinutes": 180 } }
```

`diskKeepGB` is the floor in GB. `diskSweepStaleMinutes` is how long an artifact in a busy target must go unused
before the sweep deletes it (a positive number of minutes; at 1440 or more, Linux `relatime` access times count too).

Each machine reads its own `config/machine.json`. Machine-private cleanup scripts ([helpers.md](helpers.md)) can
still run on top of the keeper, but none of them may refuse work on low disk.
