# Changelog

Every toli release is an annotated git tag `vX.Y.Z` (semver) with a section here. `just release` writes new sections
from the commits since the previous tag; `bin/toli upgrade` prints the sections between your version and the new
one. See docs/releasing.md.

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
- Any harness for the lead and jawans: omp, Claude Code, Codex, Cursor, Grok and pi (`spawn --harness`, `harness
sync|status`, per-turn guidance).
- Memory with a token budget, dated entries, staleness checks and archive (`memory`, `prune`), plus `migrate` for
  older layouts.
- Private per-machine helpers in `local/` (`helper install|run|status`) that are never committed.
- Persona names from `config/persona.json` (defaults Malik, Sardar, jawan).
- `doctor`, `digest`, `wake`, `inbox` and `runs` for status at a glance.
- Repo quality: Biome, Prettier, Taplo, shfmt, shellcheck, actionlint, guards, git hooks, gitleaks and CI.
- `install.sh` one-line installer, `bin/toli version|upgrade`, and `just release` for tagged releases.
