# Developing toli

This page is for changes to toli itself: where the work happens, the quality gate, formatters, hooks, CI and the file
layout. Cutting a release is in [releasing.md](releasing.md); installing and upgrading in [install.md](install.md).

## Branches: `develop` and `main`

Feature work lands on `develop`; `main` moves only at a release, when `just release` merges `develop` into it and
tags `vX.Y.Z` there ([releasing.md](releasing.md)). The installer and `bin/toli upgrade` use the tags, and the README
fetches `install.sh` from `main`, so users only ever see released code. A development checkout (the live one included)
stays on `develop`. Contributors branch from `develop` and open pull requests against it.

## Working on toli itself: self worktrees

The checkout you start `omp` in is live: Sardar's session, the extension's minute tick (`bin/toli job due`,
`bin/toli wake`) and the OS ticker all run `bin/toli` from it. A half-edited file there breaks them mid-edit (an
export renamed in one file but not yet in its importer fails every `bin/toli` call). So nobody edits the live checkout;
every change to toli is made in a git worktree of this repository and lands on `develop` as one fast-forward after the
gate passes.

```sh
bin/toli self prepare T12       # projects/.worktrees/toli/T12 on branch toli/T12-<slug>, from develop
cd projects/.worktrees/toli/T12  # edit, run just check, commit with plain git on that branch
bin/toli self land T12          # rebase onto develop, just check, fast-forward develop, remove worktree and branch
bin/toli self list              # self worktrees with branch, base and clean/dirty
```

- `self prepare <T-id>` creates `projects/.worktrees/toli/<T-id>` on `toli/<T-id>-<slug of the task title>` (or
  `toli/<T-id>` when the backlog has no such task), starting at `develop` (or, in a clone without a local `develop`
  branch, at the branch the live checkout is on), and runs `bun install --frozen-lockfile` in it. It is idempotent: a
  second call reports the existing worktree.
- `self land <T-id>` refuses, leaving `develop` and the live checkout untouched, when the worktree has uncommitted
  changes, when the branch does not rebase cleanly onto `develop` (the rebase is aborted), when `just check` fails in
  the worktree (it prints the last 30 lines), or when `develop` cannot be fast-forwarded (it moved, or uncommitted
  changes there overlap; run land again). On success `develop` moves to exactly the commits that passed the gate: by
  one `git merge --ff-only` in the checkout that has `develop` checked out (normally the live one), or, when no
  checkout is on `develop`, by moving the branch alone (the output then says `git switch develop` to run it). Then the
  worktree and its branch are removed. A worktree without commits is just removed.
- Both commands work from the live checkout or from inside a self worktree: toli finds the live checkout as the main
  worktree of the repository.
- Inside a worktree, `bin/toli` has no `config/` or `data/` of its own, so toli's bookkeeping commands (`task`,
  `commit`, `job`, ...) run from the live checkout; commit with plain `git` on the task branch.

Why worktrees and not a live session pinned to a release (the R13 install): a pinned install needs a second clone, a
release or upgrade for every change to reach Sardar, and a way to keep the clones' private `config/`, `data/` and
`state/` in one place. Worktrees share the repository and its branches, land in seconds, and keep the private data
where it is. They live under `projects/`, which is gitignored, so Biome (VCS ignore), `tsc` (explicit `include`),
`bun test` (`root = "tests"`), gitleaks (staged and tracked files) and grep tools never walk them; a `projects/toli`
symlink to the repository root would send those recursive walks into the repository itself.

The extension tolerates a broken CLI anyway (a hand edit, a bad pull): its tick reports the failure once per distinct
error, pointing to `bin/toli doctor`, keeps retrying quietly every minute, and recovers silently once `bin/toli` works
again (`src/harness/cli-health.ts`).

## Setup

Run `just setup` once per clone: `bun install`, points git at `.githooks/`, and lists any missing system tools with
their `brew install` command (shfmt, shellcheck, actionlint, just, gitleaks). Format and lint steps that need a missing
tool fail with that hint instead of skipping.

## The gate: `just check`

| Command          | What it runs                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `just fmt`       | Format everything in place (Biome, Prettier, Taplo, shfmt, `just --fmt`).                                     |
| `just fmt-check` | Report unformatted files.                                                                                     |
| `just lint`      | Biome lint rules, shellcheck, actionlint, the repo guards, and `scripts/useless-await.ts` (TS80007).          |
| `just typecheck` | `tsc --noEmit` over `src/`, `tests/`, `scripts/`, `.omp/extensions/`.                                         |
| `just test`      | `bun test` with 60 s per test (most tests run `bin/toli` and git; parallel jawans load the machine).          |
| `just check`     | fmt-check, lint, typecheck, test: **passes before every commit to toli** (`self land` runs it).               |
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

- **pre-commit**: gitleaks over the staged changes, then `scripts/format.ts` formats the staged files of every type
  above and re-stages the ones it changed (so unstaged hunks in a reformatted file get committed too;
  `git stash push --keep-index` first for a partial commit), then the guards over the staged files.
- **commit-msg**: subject of at most 72 characters with no trailing period, a blank line before the body, and no AI
  co-author or Generated-by trailers.
- **pre-push**: gitleaks over the pushed commits, then `bun run check`.

CI (`.github/workflows/ci.yml`) installs the pinned, checksum-verified shfmt, shellcheck, actionlint, and just, uses
the Bun version in `.bun-version`, and runs `bun run lint`, `bun test --coverage` (threshold in `bunfig.toml`), and a
full-history gitleaks scan on every push and PR.

## File layout

Tracked (shared by all machines):

    bin/toli                     CLI entry point (Bun TypeScript)
    src/main.ts                  the command router: maps each `bin/toli` command to its area
    src/core/                    shared plumbing: args, config, paths, persona, git, cron, util (output, errors,
                                 JSON files, locks, processes)
    src/records/                 toli's own records: backlog, needs, digest, memory, inbox, acks, wake, migrate, prune
    src/jobs/                    scheduled jobs: jobs, schedule (OS ticker), tick
    src/jawans/                  `bin/toli spawn` on any harness: spawn, supervise, runs
    src/harness/                 agent harnesses: headless commands, hooks, sync of generated files, lead guard,
                                 guidance, live session, CLI health for the extension
    src/projects/                project registry, link, set, setup, workspace strategy and worktrees, commit
    src/forge/                   forges, push and PR/MR: GitHub/GitLab CLIs, Bitbucket API
    src/fleet/                   machines: fleet status, resources, pick
    src/helpers/                 helper registry, local helpers, OS units
    src/setup/                   setup checklist and notice, doctor
    src/release/                 versions and CHANGELOG (release), upgrade, update check, self worktrees (self)
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
    .github/workflows/ci.yml     CI: lint, tests with coverage, gitleaks
    biome.json, .gitleaks.toml   formatter/linter and secrets-scan config
    .prettierrc.json, .taplo.toml, .editorconfig, .gitattributes, .bun-version, .vscode/   formatting and editor setup

The private, per-machine files (`projects/`, `config/`, `data/`, `state/`, `local/`, `logs/`) are gitignored; self
worktrees live in `projects/.worktrees/toli/`.
