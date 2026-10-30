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

Feature work lands on `develop` ([development.md](development.md)); `main` moves only here. Releases happen only on
the owner's word for that release, and pushing needs a second, explicit yes at the prompt.

    just release --dry-run patch     # rehearse everything in a temporary clone; nothing here changes
    just release patch               # or minor, major, or an explicit v1.4.0

`just release [patch|minor|major|vX.Y.Z] [--dry-run] [--remote <name>]` (default `patch`, remote `origin`):

1. Requires branch `develop`, a clean working tree (`git status --porcelain` empty), and a local `main` that
   `develop` contains and that no worktree has checked out (each refusal names the command that fixes it).
2. Computes the version from package.json (or takes the explicit one) and refuses one that is not newer than both
   package.json and the latest `v*` tag, or whose tag already exists.
3. Runs `bun run verify` (the gate plus the smoke checks).
4. Bumps `package.json` and writes the CHANGELOG.md section: a section drafted ahead on `develop`
   (`## vX.Y.Z - unreleased`) is kept and gets the date; otherwise a `## vX.Y.Z - <date>` section is generated from
   the commits since the last tag (merge and `Release ...` commits skipped), grouped by `feat:` / `fix:` prefixes,
   gitmoji, or the leading verb (Add... -> Added, Fix... -> Fixed, Remove/Drop... -> Removed, the rest Changed).
5. Commits `Release vX.Y.Z` on `develop`, merges `develop` into `main` (a fast-forward: `main` never gets commits of
   its own), and creates the annotated tag `vX.Y.Z` on that commit, whose message is the section.
6. Asks `Push main, develop and vX.Y.Z to origin (<url>)? [y/N]` and pushes all three atomically only on `y`.
   Otherwise it prints the push command to run later.

`--dry-run` clones `develop` into a temporary directory (with `main` from this repository), runs `bun install`, and
does steps 1-5 there (the verify run included), prints the release commit and tag, and removes the clone. It never
asks and never pushes.

### Tagging a version already in package.json

When package.json already has the version and CHANGELOG.md its section but no tag exists (how v0.1.0 was cut), run
`just release vX.Y.Z`: the release skips the bump and the commit, fast-forwards `main`, tags HEAD (after verify) and
asks to push.

## The release URL

The public repository is https://github.com/yuyudhan/toli. Its URL is set in two places:

- `install.sh`: the `TOLI_REPO_URL` default near the top;
- `src/release/release.ts`: the `TOLI_REPO_URL` constant (used by `bin/toli upgrade` when the clone has no `origin`).

Both accept a `TOLI_REPO_URL` environment variable instead. README.md and docs/install.md serve the installer from
`https://raw.githubusercontent.com/yuyudhan/toli/main/install.sh`: it always installs the latest release tag (or the
`--version` named), so the script on `main` is the one to fetch.
