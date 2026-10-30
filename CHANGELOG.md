# Changelog

Every toli release is an annotated git tag `vX.Y.Z` (semver) with a section here. `just release` writes new sections
from the commits since the previous tag; `bin/toli upgrade` prints the sections between your version and the new
one. See docs/releasing.md.

## v0.2.0 - unreleased

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

### Changed

- Branch model: toli's own work lands on `develop` (`bin/toli self land`); `main` moves only at a release, when
  `just release` merges `develop` into it, tags it, and asks before pushing `main`, `develop` and the tag. A
  CHANGELOG section drafted on `develop` is kept and dated.
- The digest's Next block names the remaining setup steps on a fresh install (a quiet line once setup is snoozed).
- The lead's guidance puts the 1-3 line reply rule first.

### Fixed

- `migrate` moves `data/briefs/T<n>.md` to its task's project, as it does reports.
- The installer prints the resolved absolute install path.
- `tests/bitbucket.test.ts` awaited a non-promise (TS80007).

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
