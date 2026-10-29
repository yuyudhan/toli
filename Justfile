# Repo-quality recipes; each wraps the matching package.json script so CI, hooks, and humans agree.

# List recipes
default:
    @just --list

# Lint (tsc, Biome, guards) then tests: the pre-push gate
check:
    bun run check

# Type-check, Biome lint and format check, guards
lint:
    bun run lint

# Format and organize imports in place
fmt:
    bun run format

# Run the test suite
test:
    bun test

# Run the hygiene guards over tracked files
guard:
    bun run guard

# Point git at .githooks/ (run once per clone)
hooks:
    bun run hooks
