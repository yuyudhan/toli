# Installing and upgrading toli

toli installs as a git clone of a tagged release (`vX.Y.Z`). There is no package to build: the clone is the install,
and your private data lives in gitignored directories inside it (`data/`, `state/`, `config/`, `logs/`, `projects/`,
`local/`).

## Supported platforms

| Platform                                   | Status                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| macOS (Apple silicon and Intel)            | supported; the scheduler is a launchd user agent                           |
| Linux: Debian/Ubuntu and Fedora            | supported; the scheduler is a systemd user timer, or crontab without one   |
| Windows through WSL2 (an Ubuntu or Debian) | supported through the Linux path; run everything inside the WSL2 distro    |
| Native Windows (PowerShell, cmd)           | not supported: toli needs a POSIX shell, `git`, `bun` and a user scheduler |

CI runs `just check` and `just verify` on `ubuntu-latest` and `macos-latest`.

On Linux and WSL2, the per-minute tick and the helpers run under `systemctl --user` when the user session answers
(`systemctl --user show-environment` succeeds), else from your crontab. WSL2 runs neither by default: either turn on
systemd (`[boot]` `systemd=true` in `/etc/wsl.conf`, then `wsl --shutdown` from Windows) or install and start cron
(`sudo apt install cron && sudo service cron start`). systemd user units stop when you log out unless lingering is
on: `loginctl enable-linger $USER`. Memory comes from `/proc/meminfo` (`MemAvailable`), load from `/proc/loadavg`,
and disk from `df -Pk` ([fleet.md](fleet.md) for the thresholds); macOS uses `vm_stat`.

## Requirements

- `git` (macOS: `xcode-select --install`; Debian/Ubuntu/WSL2: `sudo apt install git`; Fedora: `sudo dnf install git`)
- [`bun`](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`, which needs `unzip` on Linux; or on macOS
  `brew install oven-sh/bun/bun`). The installer clones without it, prints these hints, and skips the sanity check.
- An agent harness to talk to: omp, Claude Code, Codex, Cursor, Grok, or pi ([harnesses.md](harnesses.md)).
- `install.sh` is POSIX `sh`: it runs under dash (Debian/Ubuntu's `/bin/sh`), bash and zsh.

## One-line install

    curl -fsSL https://raw.githubusercontent.com/yuyudhan/toli/main/install.sh | sh

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
and say **set up toli**. The agent walks you through the rest ([setup.md](setup.md)).

Answers are read from the terminal (`/dev/tty`), so the piped form above still asks. Without a terminal (CI, a
script), pass `--yes`.

### Options

    sh install.sh [--dir <path>] [--version vX.Y.Z] [--yes] [--help]

| Option              | Effect                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `--dir <path>`      | Install here instead of asking (default `./toli`); printed as the resolved absolute path. |
| `--version vX.Y.Z`  | Install this tag instead of the latest.                                                   |
| `--yes`             | Ask nothing: default location unless `--dir`, no shell at the end.                        |
| `TOLI_REPO_URL=...` | Environment: the git URL to install from (default: https://github.com/yuyudhan/toli).     |

With the pipe, pass options after `sh -s --`:

    curl -fsSL https://raw.githubusercontent.com/yuyudhan/toli/main/install.sh | sh -s -- --version v0.1.0 --dir ~/toli

## Which version is installed

    bin/toli version          # toli v0.2.0
    bin/toli version --json   # {"tag": "v0.2.0", "version": "0.2.0", "commit": "...", "branch": null}

Off a release tag (a development clone on `develop`) it prints `0.2.0 (untagged: develop @ abc1234)`.

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

## Update check

Every 3 days toli looks for a newer release on its own, so you hear about it without asking:

    bin/toli update status            # on/off, installed, last and next check, latest, told, snoozed
    bin/toli update check             # check now (the minute tick does this when due)
    bin/toli update snooze v0.3.0     # never mention this version; a later one is still shown
    bin/toli update off               # no network checks and no notices; `on` turns it back on

- The minute tick (`bin/toli job tick`, see [jobs.md](jobs.md)) claims a due check and starts `bin/toli update check`
  as a background process, so neither the tick nor the digest waits on the network and two ticks never start two
  checks. The check runs `git ls-remote --tags` against `origin` (or `TOLI_REPO_URL`) with a 20 second timeout and
  compares the highest stable `vX.Y.Z` with `package.json`'s version; pre-releases, older and equal tags are
  ignored. For a newer release it fetches that one tag into `FETCH_HEAD` (no local tag is created or moved) to read
  its `CHANGELOG.md`.
- Offline, nothing is recorded but the attempt time; the tick tries again an hour later. A clone that is not a git
  checkout is never checked. A corrupt `config/updates.json` counts as off (fix or delete it, or run
  `bin/toli update on`); a corrupt `state/update-check.json` is replaced by the next check.
- The result is in `state/update-check.json` (`lastChecked`, `latest`, the changelog, and the versions you were
  told about); the settings are in `config/updates.json` (`check`, `snoozed`). Output of background checks goes to
  `logs/update-check.log`.
- The next `bin/toli digest` (run at every session start, in every harness) shows a newer release once: the
  version, its CHANGELOG sections, and how to update. The same version is never shown twice.
- Nothing upgrades by itself. When you confirm, the lead sends a jawan to run `bin/toli upgrade`, which also runs
  `migrate` and `harness sync`, and the jawan reports the result. On a development clone (HEAD on a branch, where
  `upgrade` refuses) the notice says so, and a jawan updates the clone with git instead.
