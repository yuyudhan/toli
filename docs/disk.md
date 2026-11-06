# The disk keeper

Low free disk never stops work on a toli machine. No floor refuses a spawn, a pick, or a build. When free space on
the volume holding toli is under `capacity.diskKeepGB` in `config/machine.json` (default 60), toli deletes rebuildable
output until free space is 20 GB above that floor. Nobody has to decide anything and nobody is asked.

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

It stops as soon as free space reaches the floor plus 20 GB.

1. Whole `target/` folders of project checkouts that nothing uses. A checkout is all registered projects' clones
   plus their git worktrees. Nothing uses it when no running jawan works in it (or, for a main clone, on its
   project) and no process has its working directory inside it. The wipe still takes cargo's locks and checks
   that no process uses the target (see 5), so a build or test started from elsewhere is never cut off. Oldest first.
2. `node_modules/` and `dist/` of those idle checkouts, unless a process holds a file in them open.
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
   queue working in, above, or naming that workspace; or when any process holds a file under it open. A process
   table it cannot read counts as in use. Each skip is logged with its reason. Only then does it rename the folder
   aside under the locks, release them, and delete the renamed tree. A cargo that starts meanwhile waits on the lock,
   then builds into an empty target. The inline keeper tries once; the background keeper retries for up to 30 minutes
   per target.

## What it never deletes

A candidate is only a folder named `target`, `node_modules` or `dist` that git lists as ignored and wholly untracked
(`git ls-files --others --ignored --exclude-standard --directory`). So it never touches sources, git data, tracked
`dist/` folders, or uncommitted work. It never removes Docker volumes or containers, and nothing outside this
account's registered checkouts and its own caches.

## Settings

```json
{ "capacity": { "diskKeepGB": 60 } }
```

Each machine reads its own `config/machine.json`. Machine-private cleanup scripts ([helpers.md](helpers.md)) can
still run on top of the keeper, but none of them may refuse work on low disk.
