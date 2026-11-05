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

Only one keeper runs at a time (`state/disk-keep.lock` holds its pid). Every action goes to `logs/disk.log`.

## What it deletes, in order

It stops as soon as free space reaches the floor plus 20 GB.

1. Whole `target/` folders of project checkouts that nothing uses. A checkout is all registered projects' clones
   plus their git worktrees. Nothing uses it when no running jawan works in it (or, for a main clone, on its
   project) and no process has its working directory inside it. The wipe still takes cargo's locks, so a build
   started from elsewhere is never cut off. Oldest first.
2. `node_modules/` and `dist/` of those idle checkouts, unless a process holds a file in them open.
3. Docker: `docker builder prune -af`, then `docker image prune -af`. It never touches volumes or containers.
4. sccache: when its local cache is over its own cap, the oldest entries until it is back under the cap. A missing
   entry is only a cache miss.
5. Every `target/` still left, busy checkouts included, between build steps. A busy target is never simply skipped.
   The keeper takes cargo's own file locks (`.cargo-lock`, `.cargo-build-lock`, `.cargo-artifact-lock`; every cargo
   command holds them for its whole build and test run) and checks that no process holds a file under the target
   open, such as a server or test binary running from it. It then renames the folder aside under the locks,
   releases them, and deletes the renamed tree. A cargo that starts meanwhile waits on the lock, then builds into an
   empty target. The inline keeper tries once; the background keeper retries for up to 30 minutes per target.

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
