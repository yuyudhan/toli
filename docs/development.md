# Developing toli

This page is for changes to toli itself: where the work happens, the quality gate, formatters, hooks, CI and the file
layout. Cutting a release is in [releasing.md](releasing.md); installing and upgrading in [install.md](install.md).

## Branches: `develop` and `main`

Feature work lands on `develop`; `main` moves only at a release, when `just release` merges `develop` into it and
tags `vX.Y.Z` there ([releasing.md](releasing.md)). The installer and `bin/toli upgrade` use the tags, and the README
fetches `install.sh` from `main`, so users only ever see released code. A development checkout (the live one included)
stays on `develop`. Contributors branch from `develop` and open pull requests against it.

## Working on toli itself: in place, landed with `bin/toli commit`

Jawans edit toli in this checkout, on `develop`, many at once; there are no worktrees, temporary or otherwise
(they do not scale to many fast parallel agents). Each change lands as its own commit:

```sh
just check                                                   # format check, lint, typecheck, tests
bin/toli commit toli -m "Fix the digest's footer" -- src/records/digest.ts tests/digest.test.ts
bin/toli commit toli -m "Fix one hunk" --patch my.diff       # only the hunks in my.diff (--patch repeats)
bin/toli commit app -m "Merge feature" --merge feature        # a clean two-parent merge, nothing else named
bin/toli commit app -m "Merge feature" --merge feature --resolved -- src/a.rs   # conflicts resolved in the tree
```

`bin/toli commit` (all projects; `toli` means this checkout, on `develop`) never uses the shared index:

1. It reads the branch tip once and builds a private temporary index from it (`GIT_INDEX_FILE`), then stages only
   the named paths (deletions included) and the `--patch` hunks. Other jawans' staged or unstaged changes and a stale
   shared index cannot reach the commit.
2. It refuses, committing nothing, when the staged set: changes a path that was not named; holds a secret (gitleaks
   over the private index); stages a `Cargo.lock` or `bun.lock` that does not parse (merge markers, a TOML or JSONC
   error, a `[[package]]` the parser dropped; for a `Cargo.lock` also `cargo metadata --locked`, run in a copy of the
   staged tree, so the crates a merge adds count); or exactly undoes a hunk of one of the last 20 commits that touched
   those files, which is what a stale copy of a file looks like (`--allow-revert <sha>` when undoing that commit is
   the point). A pure insertion or removal counts only in the same place (the same lines border it), so adding back
   elsewhere a line a recent commit removed is not a revert. With `--merge` only the changes made on top of the merge
   result are checked: what the merged ref itself brings is never a revert, including the ref's own hunks a
   `--resolved` conflict keeps as they are.
3. It writes the commit with `git commit-tree` on the tip it read and moves the branch with
   `git update-ref <branch> <new> <old>`, which fails if another commit landed meanwhile. It then rebuilds everything
   once from the new tip; a second move is a refusal ("run the same commit again").
4. It points the shared index's entries for the committed files at the commit (so `git status` shows no phantom
   staged changes) and strips AI co-author trailers from the message. Before writing the commit it runs the
   project's `commit-msg` hook (`core.hooksPath` honoured, else `.git/hooks/commit-msg`) on a temporary message file,
   from the checkout root with `GIT_INDEX_FILE` at the private index, so a hook that reads the staged set sees
   exactly the named paths; a non-zero exit refuses the commit with the hook's output, and a message the hook edits
   is committed as edited. There is no bypass flag. Pre-commit hooks do not run: the checks above cover the staged
   set, and pre-commit hooks often assume the shared index (re-staging formatters, `git stash`), which is why
   `just check` comes first. Repeated `-m` values become separate paragraphs, as with `git commit`.
5. `--merge <ref>` starts the private index from the clean merge of `<ref>` into the tip (`git merge-tree`, which
   touches no index or working tree), records `<ref>` as second parent, and runs every check
   above. It refuses a ref already merged, local changes or untracked files at paths the merge changes, and named
   paths the merge also changes (commit the merge first), except a lock file: a clean merge can leave `Cargo.lock` or
   `bun.lock` stale (each side's text merges, the entries both sides need do not), so a named, regenerated lock file
   replaces the merged one and goes through the lock check like any staged lock. A conflicted merge is refused, naming
   the conflicted paths and the merge-tree tree (`git show <tree>:<path>` shows each with conflict markers). Write the
   resolved files in the working tree, then run the same commit with `--resolved -- <conflicted paths>`: the named files
   replace the conflicted ones, every conflicted path must be named and free of conflict markers, and every check
   above runs on the result (`--resolved` on a clean merge is refused). After the branch moves it checks the merged
   files out into the shared index and working tree (`git restore --source=<commit> --staged --worktree`).
   A `git merge` already in progress in the checkout (MERGE_HEAD) lands the same way, with `--merge <its sha>` (or
   `--merge MERGE_HEAD`), plus `--resolved -- <conflicted paths>` when it had conflicts: the merge-tree result is the
   start, merged files not named must match it in the working tree (name a file to commit your edit of it), and after
   the branch moves `git merge --quit` ends the merge. Any other commit is refused while a merge is in progress, since
   it would record one parent and drop the merged one; so is an octopus merge.

For toli, it then refreshes the installed runtime (below), so the live session runs the new commit from the next
`bin/toli` call. A `--merge` commit does not: the merged code has not passed `just check` in this checkout yet, so
the runtime stays on the previous commit and the commit says so. Run `just check` on the merge, then
`bin/toli self sync`.

### On a release install: produce a patch, never commit

A machine installed from a release tag (`bin/toli version` prints the tag; HEAD is detached, no `develop`) is not a
development checkout: `bin/toli commit toli` refuses there, and a plain `git commit` or a local branch would move
the install. Edit the files in place, run `just check`, then export the change as a patch for the development
machine, which applies it on `develop`:

```sh
bin/toli commit toli -m "Fix the digest's footer" --patch-out data/outbox/T1.patch -- src/records/digest.ts tests/digest.test.ts
```

It runs steps 1 and 2 above on HEAD (private index, every check, the `commit-msg` hook), but writes nothing to the
checkout: no ref moves, the shared index, the working tree and the runtime stay as they are, and the commit's objects
live in a private temporary object directory (the checkout's own is read-only). The output is `git format-patch`
text at `<file>` and its checksum at `<file>.sha256` (`sha256sum` format); it prints both and the release commit the
patch is on. `--patch` hunks and `--allow-revert` work as usual; `--merge` is refused, since a patch is one commit.
Send the patch and its checksum to the development machine (`bin/toli delegate` or the task's report); there, in the
patch's folder, `sha256sum -c <file>.sha256 && git am <file>` on `develop` lands it with the original author, date and
message. This is a flag of the existing private-index commit code and not a local `develop` branch or a plain
`git commit` on the install, so the install moves only through `bin/toli upgrade`.

## The live session runs an installed runtime

The checkout you start `omp` in is live: Sardar's session, the extension's minute tick (`bin/toli job due`,
`bin/toli wake`), the OS ticker and the harness hooks all call its `bin/toli`. `bin/toli` is a small launcher: when
the checkout has an installed runtime, it runs that pinned snapshot of committed code instead of the working tree,
so a half-edited file (an export renamed in one file but not yet in its importer) never breaks the live session.

```sh
bin/toli self sync     # snapshot HEAD, prove it loads, then make it the runtime
bin/toli self status   # which code bin/toli runs: the runtime (current or behind HEAD) or the working tree
```

- A snapshot is `git archive` of one commit in `~/.toli/runtime/<checkout>-<hash>/<commit>/` (tracked files only, plus
  a link to the checkout's `node_modules` for toli's one runtime dependency, below). Its `.toli-runtime.json` names the
  checkout, so `config/`, `data/`, `state/`, `projects/` and `.omp/` stay where they are; `state/runtime` names the
  active snapshot.
- `self sync` runs the new snapshot once (`self status --json`, which loads every command module) and switches only
  when it loads and serves this checkout; otherwise it refuses with the error and the live session keeps the previous
  snapshot. The last three snapshots are kept, since running processes may still use the previous one.
- `bin/toli commit toli` (but a `--merge`, which waits for `just check` and then `bin/toli self sync`) and
  `bin/toli upgrade` refresh the runtime after they move HEAD; after a plain `git pull` or `bin/toli sync`, run
  `bin/toli self sync`. Deleting `state/runtime` goes back to running the working tree; `bin/toli doctor` warns when
  the runtime is behind HEAD or its snapshot is gone.
- `TOLI_DEV=1 bin/toli ...` runs the working tree, to try a change before it is committed. The tests set `TOLI_ROOT`,
  and `just verify`'s smoke runs set `TOLI_DEV=1`, so both always exercise the working tree.
- The launcher (`bin/toli`) imports nothing from `src/`, so a broken `src/` file cannot break it. The extension
  (`.omp/extensions/toli.ts`) is loaded once when `omp` starts; a change to it reaches the live session at the next
  `omp` start.

Why a snapshot and not a second clone pinned to a release (the R13 install): a second clone needs a release for
every change to reach Sardar and a way to share the private `config/`, `data/` and `state/`. A snapshot per commit
lands in seconds and keeps the private data where it is.

The extension tolerates a broken CLI anyway (no runtime installed and a bad edit, a bad pull): its tick reports the
failure once per distinct error, pointing to `bin/toli doctor`, keeps retrying quietly every minute, and recovers
silently once `bin/toli` works again (`src/harness/cli-health.ts`).

## Setup

Run `just setup` once per clone: `bun install`, points git at `.githooks/`, and lists any missing system tools
(shfmt, shellcheck, actionlint, just, gitleaks) with the install command for this machine: `brew install` on macOS,
`sudo apt install` (Debian/Ubuntu/WSL2) or `sudo dnf install` (Fedora) on Linux, or the tool's release page when the
distribution does not package it (actionlint and gitleaks on both). Format and lint steps that need a missing tool
fail with that hint instead of skipping.

## Runtime dependency

`src/` imports Bun and node built-ins, plus exactly one package: **`@noble/curves`** (MIT license, by Paul Miller;
audited), pinned to an exact version in `package.json` with `bun.lock` committed. It is used only for pairing peers
(CPace over ristretto255, `src/peer/cpace.ts`) and is loaded on demand by `src/peer/deps.ts`, so every other command
runs without `node_modules`. `install.sh` and `bin/toli upgrade` run `bun install --production --frozen-lockfile`,
the installed runtime links the checkout's `node_modules`, and pairing installs it itself when it is missing.
`bin/toli doctor` reports it (`peer-deps`). Never hand-write cryptography in toli; add an audited, pinned package.

## The gate: `just check`

| Command          | What it runs                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `just fmt`       | Format everything in place (Biome, Prettier, Taplo, shfmt, `just --fmt`).                                     |
| `just fmt-check` | Report unformatted files.                                                                                     |
| `just lint`      | Biome lint rules, shellcheck, actionlint, the repo guards, and `scripts/useless-await.ts` (TS80007).          |
| `just typecheck` | `tsc --noEmit` over `src/`, `tests/`, `scripts/`, `.omp/extensions/`.                                         |
| `just test`      | `bun run test`: `bun test` with 60 s per test, set once in package.json's test script for `check` too.        |
| `just check`     | fmt-check, lint, typecheck, test: **passes before every commit to toli** (`bin/toli commit toli`).            |
| `just verify`    | check, then smoke runs: `bin/toli version`, `doctor`, `harness sync --check`, `setup status`, and an install. |
| `just guard`     | The hygiene guards over tracked files.                                                                        |
| `just release`   | Cut a tagged release ([releasing.md](releasing.md); `just publish` is the same recipe).                       |

Plain `just` lists the recipes; each wraps the matching `bun run` script. `.vscode/` recommends the matching editor
extensions with format-on-save.

The guards (`scripts/guard/*.ts`) cover AI attribution, CLI docs, stray `console.log`, file size, focused tests,
Markdown links, whitespace, and Mermaid: every ` ```mermaid ` block in tracked Markdown must parse with the `mermaid`
version pinned in `package.json`, which is the one GitHub renders with (GitHub shows only a spinner for a block it
cannot parse). When GitHub moves to a new Mermaid, bump the pin to match.

## Formatters

Every file type has one formatter, all at 4-space indentation, driven by `scripts/format.ts`:

| Files                           | Formatter (config)            | Lint         |
| ------------------------------- | ----------------------------- | ------------ |
| `.ts`, `.json`, `.jsonc`        | Biome (`biome.json`)          | `tsc`, Biome |
| `.md`, `.yml`, `.yaml`          | Prettier (`.prettierrc.json`) |              |
| `.toml`                         | Taplo (`.taplo.toml`)         |              |
| `.githooks/*`, `*.sh`, `*.bash` | shfmt (`.editorconfig`)       | shellcheck   |
| `Justfile`                      | `just --fmt`                  |              |
| `.github/workflows/*.yml`       | Prettier                      | actionlint   |

## Git hooks and CI

The hooks are for contributors committing with plain `git`; `bin/toli commit` does not run them (it scans with
gitleaks itself, and `just check` runs the formatters, lint and guards before it).

- **pre-commit**: gitleaks over the staged changes, then `scripts/format.ts` formats the staged files of every type
  above and re-stages the ones it changed (so unstaged hunks in a reformatted file get committed too;
  `git stash push --keep-index` first for a partial commit), then the guards over the staged files.
- **commit-msg**: subject of at most 72 characters with no trailing period, a blank line before the body, and no AI
  co-author or Generated-by trailers.
- **pre-push**: gitleaks over the pushed commits, then `bun run check`
  ([delivery.md](delivery.md#gates-long-checks-run-once-per-tree)): skipped when the pushed commit's tree already
  passed as a `bin/toli gate`; run as that gate (and recorded) when the checkout is exactly the pushed commit; otherwise
  run on the working tree as before, after listing up to 20 files that differ, and not recorded. The hook reads the
  proof only through `bin/toli gate check toli --sha <pushed sha> --recipe "bun run check"`, which exits 0 only for a
  record whose HMAC (keyed by this installation's owner-only `state/gate-key`) verifies for that tree, recipe and
  project. It never trusts `TOLI_GATE_*` variables or a record's `status` alone, so an edited, copied or invented
  record, or a gate key others can read, makes the hook run the full check.

CI (`.github/workflows/ci.yml`) runs on pushes and pull requests to `main` and `develop`, on `ubuntu-latest` and
`macos-latest`. Each runner installs the pinned, checksum-verified shfmt, shellcheck, actionlint, just, and gitleaks
(the `bin/toli commit` tests scan with it) for its OS and architecture, uses the Bun version in `.bun-version`, and
runs `just verify` (which is `just check` plus the
smoke runs). The Ubuntu runner also runs `bun test --coverage` (threshold in `bunfig.toml`) and a full-history
gitleaks scan.

Tests never touch the host's scheduler: `TOLI_DRY_RUN=1` is the sandbox default, `systemctl` is stubbed as "no user
session", `sudo` as one without cached credentials (`withSudo` gives a test one that runs its command), and
`TOLI_PLATFORM`, `TOLI_SCHEDULER`, `TOLI_LAUNCH_AGENTS_DIR`, `TOLI_LAUNCH_DAEMONS_DIR`, `TOLI_SYSTEMD_USER_DIR` and
`TOLI_PROC_DIR` select a platform, scheduler, unit directories and `/proc` fixtures on any host; the preload points
`TOLI_LAUNCH_DAEMONS_DIR` away from the host's `/Library/LaunchDaemons`.

Tests never touch this checkout's git repository either. The preload (`tests/setup.ts`, `tests/repo-guard.ts`) drops
every inherited `GIT_*` variable (a git hook exports `GIT_DIR`, so a run under `pre-push` once wrote its temp repos'
commits and tags into the real one), sets `GIT_CEILING_DIRECTORIES` to the OS temp dir and gives the run its own temp
`HOME`, before any test file loads. It also snapshots the real repository's refs and fails the run at the end when a
tag was created, moved or deleted, a branch deleted, or a branch gained a commit by the test author
(`test@example.com`); commits other agents land on `develop` meanwhile are not counted.

## File layout

Tracked (shared by all machines):

    bin/toli                     CLI launcher: runs the installed runtime when there is one, else src/main.ts
    bin/shims/cargo              cargo shim first on jawans' PATH: heavy cargo commands wait for a build slot
    src/main.ts                  the command router: maps each `bin/toli` command to its area
    src/core/                    shared plumbing: args, config, paths, persona, git, cron, util (output, errors,
                                 JSON files, locks, processes)
    src/records/                 toli's own records: backlog, needs, digest, memory, inbox, acks, wake, migrate, prune
    src/jobs/                    scheduled jobs: jobs, schedule (OS ticker), os-scheduler (systemd --user, crontab:
                                 choice and primitives shared with helpers), launchd (user agents, LaunchDaemons) and
                                 launchd-plist, tick
    src/jawans/                  `bin/toli spawn` on any harness: spawn, supervise, runs
    src/harness/                 agent harnesses: headless commands, hooks, sync of generated files, lead guard,
                                 guidance, live session, CLI health for the extension
    src/projects/                project registry, link, set, setup, workspace strategy and worktrees, safe commit
    src/forge/                   forges, push and PR/MR: GitHub/GitLab CLIs, Bitbucket API
    src/fleet/                   machines: fleet status, resources, pick, heavy-build slots
    src/helpers/                 helper registry, local helpers, OS units
    src/setup/                   setup checklist and notice, doctor
    src/release/                 versions and CHANGELOG (release), upgrade, update check, installed runtime (runtime)
    AGENTS.md                    Sardar's role and rules for omp
    .omp/extensions/toli.ts      session tracking, background job hand-off, result delivery into the chat
    .omp/skills/toli-*/          Sardar skills (dispatch, projects, deliver, scout, ...)
    .omp/commands/*.md           slash commands
    docs/brief-template.md       template for every jawan brief
    docs/verify-brief-template.md  template for the independent verifier jawan on ship work
    tests/                       bun tests (temp TOLI_ROOT, stubbed ssh/omp/crontab)
    scripts/guard.ts, guard/     hygiene guards; file-size-exceptions.txt ratchets oversized files
    scripts/format.ts            runs every formatter and file-type linter (write, check, lint, tools)
    scripts/useless-await.ts     fails on TS80007 (`await` on a non-promise), which tsc --noEmit never reports
    docs/*.md                    focused guides
    .githooks/                   pre-commit, commit-msg, pre-push
    .github/workflows/ci.yml     CI: just verify on Ubuntu and macOS, coverage, gitleaks
    biome.json, .gitleaks.toml   formatter/linter and secrets-scan config
    .prettierrc.json, .taplo.toml, .editorconfig, .gitattributes, .bun-version, .vscode/   formatting and editor setup

The private, per-machine files (`projects/`, `config/`, `data/`, `state/`, `local/`, `logs/`) are gitignored; the
installed runtime's snapshots live outside the checkout, in `~/.toli/runtime/`.
