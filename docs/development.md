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
bin/toli commit toli -m "Fix one hunk" --patch my.diff       # only the hunks in my.diff
```

`bin/toli commit` (all projects; `toli` means this checkout, on `develop`) never uses the shared index:

1. It reads the branch tip once and builds a private temporary index from it (`GIT_INDEX_FILE`), then stages only
   the named paths (deletions included) and the `--patch` hunks. Other jawans' staged or unstaged changes and a stale
   shared index cannot reach the commit.
2. It refuses, committing nothing, when the staged set: changes a path that was not named; holds a secret (gitleaks
   over the private index); stages a `Cargo.lock` or `bun.lock` that does not parse (merge markers, a TOML or JSONC
   error, a `[[package]]` the parser dropped; for a whole-file `Cargo.lock` also `cargo metadata --locked`); or
   exactly undoes a hunk of one of the last 20 commits that touched those files, which is what a stale copy of a file
   looks like (`--allow-revert <sha>` when undoing that commit is the point).
3. It writes the commit with `git commit-tree` on the tip it read and moves the branch with
   `git update-ref <branch> <new> <old>`, which fails if another commit landed meanwhile. It then rebuilds everything
   once from the new tip; a second move is a refusal ("run the same commit again").
4. It points the shared index's entries for the committed files at the commit (so `git status` shows no phantom
   staged changes) and strips AI co-author trailers from the message. Git hooks do not run (`commit-tree`), which is
   why `just check` comes first.

For toli, it then refreshes the installed runtime (below), so the live session runs the new commit from the next
`bin/toli` call.

## The live session runs an installed runtime

The checkout you start `omp` in is live: Sardar's session, the extension's minute tick (`bin/toli job due`,
`bin/toli wake`), the OS ticker and the harness hooks all call its `bin/toli`. `bin/toli` is a small launcher: when
the checkout has an installed runtime, it runs that pinned snapshot of committed code instead of the working tree,
so a half-edited file (an export renamed in one file but not yet in its importer) never breaks the live session.

```sh
bin/toli self sync     # snapshot HEAD, prove it loads, then make it the runtime
bin/toli self status   # which code bin/toli runs: the runtime (current or behind HEAD) or the working tree
```

- A snapshot is `git archive` of one commit in `~/.toli/runtime/<checkout>-<hash>/<commit>/` (tracked files only:
  `src/` imports only Bun and node built-ins). Its `.toli-runtime.json` names the checkout, so `config/`, `data/`,
  `state/`, `projects/` and `.omp/` stay where they are; `state/runtime` names the active snapshot.
- `self sync` runs the new snapshot once (`self status --json`, which loads every command module) and switches only
  when it loads and serves this checkout; otherwise it refuses with the error and the live session keeps the previous
  snapshot. The last three snapshots are kept, since running processes may still use the previous one.
- `bin/toli commit toli` and `bin/toli upgrade` refresh the runtime after they move HEAD; after a plain `git pull`
  or `bin/toli sync`, run `bin/toli self sync`. Deleting `state/runtime` goes back to running the working tree;
  `bin/toli doctor` warns when the runtime is behind HEAD or its snapshot is gone.
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

## The gate: `just check`

| Command          | What it runs                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `just fmt`       | Format everything in place (Biome, Prettier, Taplo, shfmt, `just --fmt`).                                     |
| `just fmt-check` | Report unformatted files.                                                                                     |
| `just lint`      | Biome lint rules, shellcheck, actionlint, the repo guards, and `scripts/useless-await.ts` (TS80007).          |
| `just typecheck` | `tsc --noEmit` over `src/`, `tests/`, `scripts/`, `.omp/extensions/`.                                         |
| `just test`      | `bun test` with 60 s per test (most tests run `bin/toli` and git; parallel jawans load the machine).          |
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
- **pre-push**: gitleaks over the pushed commits, then `bun run check`.

CI (`.github/workflows/ci.yml`) runs on pushes and pull requests to `main` and `develop`, on `ubuntu-latest` and
`macos-latest`. Each runner installs the pinned, checksum-verified shfmt, shellcheck, actionlint, just, and gitleaks
(the `bin/toli commit` tests scan with it) for its OS and architecture, uses the Bun version in `.bun-version`, and
runs `just verify` (which is `just check` plus the
smoke runs). The Ubuntu runner also runs `bun test --coverage` (threshold in `bunfig.toml`) and a full-history
gitleaks scan.

Tests never touch the host's scheduler: `TOLI_DRY_RUN=1` is the sandbox default, `systemctl` is stubbed as "no user
session", and `TOLI_PLATFORM`, `TOLI_SCHEDULER`, `TOLI_LAUNCH_AGENTS_DIR`, `TOLI_SYSTEMD_USER_DIR` and `TOLI_PROC_DIR`
select a platform, scheduler, unit directories and `/proc` fixtures on any host.

## File layout

Tracked (shared by all machines):

    bin/toli                     CLI launcher: runs the installed runtime when there is one, else src/main.ts
    src/main.ts                  the command router: maps each `bin/toli` command to its area
    src/core/                    shared plumbing: args, config, paths, persona, git, cron, util (output, errors,
                                 JSON files, locks, processes)
    src/records/                 toli's own records: backlog, needs, digest, memory, inbox, acks, wake, migrate, prune
    src/jobs/                    scheduled jobs: jobs, schedule (OS ticker), os-scheduler (launchd, systemd --user,
                                 crontab: choice and primitives shared with helpers), tick
    src/jawans/                  `bin/toli spawn` on any harness: spawn, supervise, runs
    src/harness/                 agent harnesses: headless commands, hooks, sync of generated files, lead guard,
                                 guidance, live session, CLI health for the extension
    src/projects/                project registry, link, set, setup, workspace strategy and worktrees, safe commit
    src/forge/                   forges, push and PR/MR: GitHub/GitLab CLIs, Bitbucket API
    src/fleet/                   machines: fleet status, resources, pick
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
