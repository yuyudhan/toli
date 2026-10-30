# Installing and upgrading toli

toli installs as a git clone of a tagged release (`vX.Y.Z`). There is no package to build: the clone is the install,
and your private data lives in gitignored directories inside it (`data/`, `state/`, `config/`, `logs/`, `projects/`,
`local/`).

## Requirements

- `git`
- [`bun`](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`, or `brew install oven-sh/bun/bun`). The
  installer clones without it, prints these hints, and skips the sanity check.
- An agent harness to talk to: omp, Claude Code, Codex, Cursor, Grok, or pi (docs/harnesses.md).

## One-line install

    curl -fsSL <toli-raw-url>/install.sh | sh

The installer:

1. lists the release tags with `git ls-remote --tags` (no API token) and picks the highest `vX.Y.Z`; pre-releases
   (`v1.0.0-rc.1`) are installed only when named with `--version`;
2. asks where to install (Enter for `./toli` under the current directory, or type a path; `~` works) and refuses a
   directory that is not empty;
3. asks you to confirm, then clones that tag (`git clone --branch vX.Y.Z --depth 1`; the checkout is detached at the
   tag);
4. runs `bin/toli version` and `bin/toli doctor` as a sanity check. On a fresh install doctor reports
   `fail machine ... run bin/toli init`: that is first-run setup, which your agent does;
5. prints the next steps and offers to open a shell in the new directory (a script cannot change the directory of
   the shell that ran it; `exit` returns you to where you were).

Then, in the install directory, open your favourite agent (`omp`, `claude`, `codex`, `cursor-agent`, `grok`, `pi`)
and say **set up toli**. The agent walks you through the rest (docs/setup.md).

Answers are read from the terminal (`/dev/tty`), so the piped form above still asks. Without a terminal (CI, a
script), pass `--yes`.

### Options

    sh install.sh [--dir <path>] [--version vX.Y.Z] [--yes] [--help]

| Option              | Effect                                                                  |
| ------------------- | ----------------------------------------------------------------------- |
| `--dir <path>`      | Install here instead of asking (default `./toli`).                      |
| `--version vX.Y.Z`  | Install this tag instead of the latest.                                 |
| `--yes`             | Ask nothing: default location unless `--dir`, no shell at the end.      |
| `TOLI_REPO_URL=...` | Environment: the git URL to install from (default: the public release). |

With the pipe, pass options after `sh -s --`:

    curl -fsSL <toli-raw-url>/install.sh | sh -s -- --version v0.1.0 --dir ~/toli

## Which version is installed

    bin/toli version          # toli v0.2.0
    bin/toli version --json   # {"tag": "v0.2.0", "version": "0.2.0", "commit": "...", "branch": null}

Off a release tag (a development clone on `main`) it prints `0.2.0 (untagged: main @ abc1234)`.

## Upgrading

    bin/toli upgrade --check     # current vs latest, changes nothing
    bin/toli upgrade             # to the latest release (same as --latest)
    bin/toli upgrade v0.3.0      # to a specific tag (also a pre-release, or an older tag to roll back)

`upgrade` lists the tags on `origin`, then:

- refuses when tracked files have local changes (untracked files and the private directories do not count) or
  when HEAD is on a branch, which means a development clone: there, use git directly;
- refuses a tag that does not exist on the remote, listing the ones that do;
- fetches just that tag (shallow installs stay shallow) and checks it out, detached;
- runs `bin/toli migrate` and `bin/toli harness sync` from the new code;
- prints the CHANGELOG.md sections between your old version and the new one.

Your `data/`, `state/`, `config/`, `logs/`, `projects/`, and `local/` are gitignored, so the checkout never touches
them. After an upgrade, restart your agent session so it loads the new contract and skills.
