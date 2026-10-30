# Releasing toli

How a toli release is cut. Installing and upgrading are in [install.md](install.md); the quality gate every change
passes (`just check`, `just verify`, hooks, CI) is in [development.md](development.md).

`just verify`, which every release runs, ends with an install smoke test: it clones the committed HEAD into a
temporary bare repository, tags it with package.json's version if needed, and runs `install.sh --yes` against it over
`file://`. On a checkout without `config/machine.json`, doctor's `fail machine` line is expected and tolerated.

## Versions

- Releases are annotated git tags `vX.Y.Z` (semver); pre-releases look like `v1.0.0-rc.1` and are never picked as
  "latest" by the installer or `bin/toli upgrade`.
- `package.json` `version` is the version of the tree; `CHANGELOG.md` has one section per release, newest first.
- Patch: fixes. Minor: new commands or behaviour. Major: a change that needs users to act (layout, contract).

## Cutting a release

Releases happen only on the owner's word for that release, and pushing needs a second, explicit yes at the prompt.

    just release --dry-run patch     # rehearse everything in a temporary clone; nothing here changes
    just release patch               # or minor, major, or an explicit v1.4.0

`just release [patch|minor|major|vX.Y.Z] [--dry-run] [--remote <name>]` (default `patch`, remote `origin`):

1. Requires branch `main` and a clean working tree (`git status --porcelain` empty).
2. Computes the version from package.json (or takes the explicit one) and refuses one that is not newer than both
   package.json and the latest `v*` tag, or whose tag already exists.
3. Runs `bun run verify` (the gate plus the smoke checks).
4. Bumps `package.json`, prepends a `## vX.Y.Z - <date>` section to CHANGELOG.md from the commits since the last tag
   (merge and `Release ...` commits skipped), grouped by `feat:` / `fix:` prefixes, gitmoji, or the leading verb
   (Add... -> Added, Fix... -> Fixed, Remove/Drop... -> Removed, the rest Changed). Edit the section afterwards with
   a follow-up commit if the wording needs it.
5. Commits `Release vX.Y.Z` and creates the annotated tag `vX.Y.Z` whose message is that section.
6. Asks `Push main and vX.Y.Z to origin (<url>)? [y/N]` and pushes both atomically only on `y`. Otherwise it prints
   the push command to run later.

`--dry-run` clones HEAD into a temporary directory, runs `bun install`, and does steps 1-5 there (the verify run
included), prints the release commit and tag, and removes the clone. It never asks and never pushes.

### The first release

CHANGELOG.md is seeded with a `v0.1.0` section and package.json says `0.1.0`, but no tag exists yet. Run
`just release v0.1.0`: with the version already in package.json and its section already written, the release skips
the bump and the commit and only tags HEAD (after verify) and asks to push.

## The release URL

The public repository is not chosen yet. Its URL is set in two places, both marked `<toli-repo-url>`:

- `install.sh`: the `TOLI_REPO_URL` default near the top;
- `src/release.ts`: the `TOLI_REPO_URL` constant (used by `bin/toli upgrade` when the clone has no `origin`).

Until then, both accept a `TOLI_REPO_URL` environment variable. Also replace the `<toli-raw-url>` in README.md and
docs/install.md with the raw-file URL that serves `install.sh` from the latest release.
