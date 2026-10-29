# Repo-quality recipes; each wraps the matching package.json script so CI, hooks, and humans agree.

# List recipes
default:
    @just --list

# One-time setup per clone: dependencies, git hooks, and a report of missing system tools
setup:
    bun install
    bun run hooks
    bun run tools

# Lint then tests: the pre-push gate
check:
    bun run check

# Type-check, Biome lint, non-Biome format checks, shellcheck, actionlint, guards
lint:
    bun run lint

# Format everything in place (Biome, Prettier, Taplo, shfmt, just --fmt)
fmt:
    bun run format

# Report unformatted files without changing them
fmt-check:
    bun run format:check

# Run the test suite
test:
    bun test

# Run the hygiene guards over tracked files
guard:
    bun run guard

# Point git at .githooks/ (run once per clone)
hooks:
    bun run hooks
