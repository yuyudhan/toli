# toli's own quality gate and release. Each recipe wraps the matching package.json script so CI, git hooks, agents,
# and humans run the same thing. Before committing work on toli itself: `just check`.

alias publish := release

# List recipes
default:
    @just --list

# One-time setup per clone: dependencies, git hooks, and a report of missing system tools
setup:
    bun install
    bun run hooks
    bun run tools

# Format everything in place (Biome, Prettier, Taplo, shfmt, just --fmt)
fmt:
    bun run format

# Report unformatted files without changing them
fmt-check:
    bun run format:check

# Lint: Biome rules, shellcheck, actionlint, and the repo guards
lint:
    bun run lint

# Type-check src/, tests/, scripts/, and .omp/extensions with tsc
typecheck:
    bun run typecheck

# Run the test suite
test:
    bun test

# The gate every agent runs before committing: fmt-check, lint, typecheck, test
check:
    bun run check

# check plus smoke runs of the CLI (doctor, harness sync --check, setup status) and a file:// install.sh install
verify:
    bun run verify

# Cut a release on develop: verify, bump, CHANGELOG, commit, merge into main, tag; asks before pushing (--dry-run: temp clone)
release *args:
    bun scripts/publish.ts {{ args }}

# Run the hygiene guards over tracked files
guard:
    bun run guard

# Point git at .githooks/ (run once per clone)
hooks:
    bun run hooks
