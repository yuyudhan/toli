# Changelog

Every toli release is an annotated git tag `vX.Y.Z` (semver) with a section here. `just release` writes new sections
from the commits since the previous tag; `bin/toli upgrade` prints the sections between your version and the new
one. See docs/releasing.md.

## v0.2.2 - unreleased

### Added

- `bin/toli commit <p> --merge <ref> -m "..."` writes a two-parent merge commit from the clean merge of `<ref>` into
  the branch tip (`git merge-tree`), with the usual checks (secrets, lock files, reverts, branch moved meanwhile). It
  refuses a conflicted merge, a ref already merged, local changes to the files the merge changes, and named paths
  the merge also changes; on success the merged files are checked out in the index and working tree.
- A push log: `bin/toli push` records every push that moves origin's branch in the pushing machine's
  `data/pushes.jsonl` (time, project, branch, old..new sha, issuing machine, task, the owner's quoted word via
  `--by`/`--for`/`--word`), and `bin/toli digest` lists the last week's under "recent pushes". A push run on one
  machine for another (over ssh, or through `bin/toli remote ... --task <id>`, whose `exec` hands the issuing machine
  and task to the run) no longer looks unexplained there. `bin/toli push-log add` records a raw `git push`;
  `bin/toli push-log list` shows the log. The toli-deliver skill and brief templates say how to use it.

### Fixed

- `bin/toli pr create` on GitLab passes `--head` to `glab mr create`, so the source project is looked up on the
  forge host (`forgeHost`, glab config) instead of the git remote's ssh host (`gitlab-ssh.*`).
- `bin/toli commit -m a -m b` keeps every `-m`, joined as paragraphs like `git commit`, instead of only the last.
- CI's coverage step passes again (it failed on v0.2.1 while every test passed): the jawan environment builder moved
  to `src/jawans/env.ts`, so its tests no longer load the outcome delivery code in-process.

## v0.2.1 - 2026-11-02

### Added

- `bin/toli doctor` on a worker reports results waiting in `state/outbox/` for the coordinator (count and age of the
  oldest), so a worker whose results stopped reaching the coordinator shows a warning instead of staying silent.

### Changed

- One code folder, one build folder (AGENTS.md hard rule 5): every jawan builds and tests in the checkout it works
  in, into its normal build folder; no private `CARGO_TARGET_DIR`, `/tmp` target, or scratch copy of the code. The
  brief and verify-brief templates and the dispatch skill say so, and `bin/toli spawn` starts jawans without an
  inherited `CARGO_TARGET_DIR`.
- Build jobs have one cap per machine, `capacity.cargoJobs` in `config/machine.json` (default half the cores):
  `bin/toli spawn` sets every jawan's `CARGO_BUILD_JOBS` to it (replacing any inherited value), `bin/toli doctor`
  warns when `~/.cargo/config.toml` `[build] jobs` differs, and the brief templates tell jawans never to pass `-j`,
  extra `RUSTFLAGS`, a profile or features in a shared build folder.

### Fixed

- The test suite removes the temporary directories its tests create once the run ends, instead of leaving them in
  the system temp folder.

## v0.2.0 - 2026-10-30

### Added

- Linux and WSL2 support: `bin/toli resources` reads load and memory from `/proc`; the minute tick and helpers run
  under systemd user timers when `systemctl --user` works, crontab otherwise (a leftover v0.1.0 crontab tick is
  removed and flagged); `just setup` gives apt/dnf hints. Supported: macOS, Debian/Ubuntu, Fedora, WSL2; native
  Windows is not.
- CI on `ubuntu-latest` and `macos-latest` running `just verify` (the gate plus smoke checks, with `install.sh`
  checked under dash and shellcheck) on every push and pull request to `main` and `develop`.
- A 3-day update check: toli compares its version with the latest release tag in the background (never blocking,
  silent offline), tells you once per version with its changelog, and upgrades only when you say so
  (`bin/toli update status|check|snooze <vX.Y.Z>|off|on`).
- `bin/toli project set <p> --branch <b>` switches a clean clone to the branch, or leaves it and prints the exact
  `git switch` command.
- Lint fails on an `await` of a non-promise (TS80007) and on a Mermaid block GitHub cannot parse.
- `bin/toli commit` is safe with many jawans in one clone (R23): it builds a private index from the branch tip,
  commits only the named paths and `--patch` hunks, moves the branch only if it has not moved (one retry from the new
  tip), and refuses a secret (gitleaks), a `Cargo.lock`/`bun.lock` that does not parse, a path that was not named, or
  an exact revert of one of the last 20 commits (`--allow-revert <sha>`). No worktrees or tree copies.
- The live session runs an installed runtime: `bin/toli self sync` snapshots HEAD under `~/.toli/runtime/`, proves
  it loads, and points `bin/toli` at it, so half-edited files in the checkout no longer break Sardar or the minute
  tick. `commit toli`, `sync` and `upgrade` refresh it; `self status` and `doctor` report it; `TOLI_DEV=1` runs the
  working tree.

### Changed

- Branch model: toli's own work lands on `develop`; `main` moves only at a release, when `just release` merges
  `develop` into it, tags it, and asks before pushing `main`, `develop` and the tag. A CHANGELOG section drafted on
  `develop` is kept and dated.
- Jawans edit toli in place on `develop` and land with `bin/toli commit toli`; no worktrees anywhere in toli's own
  flow, including temporary ones (AGENTS.md rule 4). `worktree-per-task` stays an opt-in project strategy.
- The digest's Next block names the remaining setup steps on a fresh install (a quiet line once setup is snoozed).
- The lead's guidance puts the 1-3 line reply rule first.

### Removed

- `bin/toli self prepare|list|land` and toli's self worktrees (`projects/.worktrees/toli/`).

### Fixed

- `migrate` moves `data/briefs/T<n>.md` to its task's project, as it does reports.
- The installer prints the resolved absolute install path.
- `tests/bitbucket.test.ts` awaited a non-promise (TS80007).
- `schedule install` and `helper install` run from toli's root no longer write bun's `bun-node-*` temp dir (gone
  after a reboot) into the tick's or a helper's bun path and PATH; `schedule status`, doctor and the setup checklist
  warn when the bun an installed tick runs no longer exists.

## v0.1.0 - 2026-10-30

### Added

- A lead agent ("Sardar" by default) that runs in the toli checkout, takes requests in chat, records each one as a
  task, and dispatches background worker agents ("jawans") to do the work; it never does project work itself.
- `bin/toli`: projects (`project add|list|set|setup|drop`), tasks, commits that stage only named paths and strip AI
  trailers, fixed working branches, forge delivery for GitHub, GitLab and Bitbucket (`push`, `pr create|status|merge`).
- Per-project data under `data/projects/<project>/` (notes, briefs, reports, runs, decisions) and a setup interview
  for each new project.
- Scheduled jobs (`job add|list|run-due|tick`, `schedule install`) that run headless and push results back into the
  chat through the inbox.
- Multi-machine fleets: `init`, `sync`, `resources`, `fleet status`, `pick`, `remote` dispatch to the least-busy
  machine.
- Any harness for the lead and jawans: omp, Claude Code, Codex, Cursor, Grok and pi (`spawn --harness`,
  `harness sync|status`, per-turn guidance).
- Memory with a token budget, dated entries, staleness checks and archive (`memory`, `prune`), plus `migrate` for
  older layouts.
- Private per-machine helpers in `local/` (`helper install|run|status`) that are never committed.
- Persona names from `config/persona.json` (defaults Malik, Sardar, jawan).
- `doctor`, `digest`, `wake`, `inbox` and `runs` for status at a glance.
- Repo quality: Biome, Prettier, Taplo, shfmt, shellcheck, actionlint, guards, git hooks, gitleaks and CI.
- `install.sh` one-line installer, `bin/toli version|upgrade`, and `just release` for tagged releases.
- Self-hosting: `bin/toli self prepare|list|land` develop toli in worktrees (`projects/.worktrees/toli/<T-id>`) and
  land them by fast-forward only after `just check` passes there, so the live checkout never holds half-edited code;
  the extension reports a failing CLI once per distinct error and points to `bin/toli doctor`.
- Needs-you queue: `task hold` takes 2-4 `--option "<choice> => <then>"`, `--recommend` and `--blocks`;
  `bin/toli needs [--json]` lists held tasks by project, blocking and oldest first, with reply hints; the digest
  opens with it, flags holds without a question, and re-surfaces stale holds once (`needs.staleDays`, default 7);
  `task answer` records options and the verbatim reply in `decisions.md` and prints `unblocked: dispatch T<n>`.
- Goal contracts: briefs carry a `## Goal` (Objective, Constraints, Validate, Stop when, Record, and a rule against
  weakening checks; a short form for scouts), verifiers check Stop when independently, and `spawn` warns on a ship
  brief without one.
- Lead guard compares symlink-resolved real paths and treats every project's real checkout (linked ones included) as
  project code, for reads and writes; `doctor` and `schedule status` warn when the machine's tick runs another toli
  checkout.
