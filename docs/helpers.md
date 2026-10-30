# Custom machine helpers

Every machine has its own chores: clearing old build output when the disk fills up, reconnecting a VPN, a nightly
backup, keeping a small local service running. toli gives each installation one private place for these scripts and
installs their schedules for you. Nothing here is ever committed: the whole `local/` directory is gitignored.

You normally never write a helper yourself. Ask the lead ("clean old build folders every hour on this machine"), and
it dispatches a worker that writes the script, registers it, runs it once, installs it, and shows you its status.

## Layout

    local/
      README.md        short explainer (seeded by `bin/toli init`)
      helpers.json     the registry (seeded empty by `bin/toli init`)
      scripts/<name>   helper programs, any language
      hooks/           optional: post-init, pre-tick, post-tick
    logs/helpers/<name>.log   each helper's output

## helpers.json

```json
{
    "helpers": [
        {
            "name": "disk-reaper",
            "description": "Delete idle build output when the disk runs low",
            "exec": "local/scripts/disk-reaper",
            "args": ["--quiet"],
            "schedule": { "every": "15m" },
            "runAtLoad": true,
            "nice": 10,
            "lowPriorityIO": true,
            "env": { "LOW_GB": "50" },
            "platforms": ["darwin", "linux"],
            "enabled": true
        }
    ]
}
```

| Field           | Required | Meaning                                                                                                 |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `name`          | yes      | letters, digits, `.`, `_`, `-`; unique                                                                  |
| `exec`          | yes      | program path, absolute or relative to the toli root                                                     |
| `schedule`      | yes      | exactly one of `{"every": "90s"\|"15m"\|"1h"\|"1d"}`, `{"cron": "m h dom mon dow"}`, `{"always": true}` |
| `description`   | no       | shown by `helper list`                                                                                  |
| `args`          | no       | arguments, as-is; the working directory is the toli root                                                |
| `runAtLoad`     | no       | also run once when installed and at login/boot (default false)                                          |
| `nice`          | no       | CPU priority 0-19, higher is gentler                                                                    |
| `lowPriorityIO` | no       | low-priority disk I/O (launchd `LowPriorityIO`, systemd `IOSchedulingClass=idle`)                       |
| `env`           | no       | extra environment; `PATH` here replaces the default scheduled PATH                                      |
| `platforms`     | no       | install only on these (`darwin`, `linux`); default every platform                                       |
| `enabled`       | no       | default true; `install` refuses and `install --all` skips a disabled helper                             |

`always` keeps one process running and restarts it when it exits; it needs launchd or systemd (crontab cannot do
it). A `cron` schedule may restrict day-of-month or day-of-week, not both (launchd and systemd cannot express cron's
"either day" rule). An `every` interval under crontab must divide an hour or a day evenly; otherwise use `cron`.

Unknown keys and malformed values are errors that name the helper, so a typo never installs silently.

## Commands

    bin/toli helper list [--json]              # registry: schedule, enabled, installed, description
    bin/toli helper status [<name>] [--json]   # loaded, running pid, last exit; flags installed helpers no longer registered
    bin/toli helper install <name> | --all     # install or reinstall (reloads; safe to repeat)
    bin/toli helper uninstall <name> | --all   # unload and remove; works after the entry is gone from helpers.json
    bin/toli helper run <name>                 # run once now, in the foreground; exits with the helper's exit code

`TOLI_DRY_RUN=1 bin/toli helper install <name>` prints the unit files and commands without touching anything.

## Schedulers

| Platform                          | What `install` writes                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| macOS                             | `~/Library/LaunchAgents/com.toli.helper.<name>.plist`, loaded with `launchctl bootstrap` |
| Linux with a systemd user session | `~/.config/systemd/user/toli-helper-<name>.service` (+ `.timer`), `enable` + `restart`   |
| Linux without systemd             | one crontab line ending in `# toli helper <name>`                                        |

`TOLI_HELPER_SCHEDULER=launchd|systemd|crontab` forces one, e.g. on a server whose systemd user session does not
survive logout (or run `loginctl enable-linger $USER` so it does).

## Hooks

Optional executables in `local/hooks/` that toli runs itself, with the toli root as `$1` and as the working
directory:

| Hook        | Runs                                                  |
| ----------- | ----------------------------------------------------- |
| `post-init` | after `bin/toli init`                                 |
| `pre-tick`  | before every scheduler tick (`bin/toli job tick`)     |
| `post-tick` | after every scheduler tick, even when the tick failed |

A missing hook is skipped. A hook that is not executable is skipped with a note. A failing or slow hook (5-minute
limit) is reported on stderr and never fails the toli command. Hook output goes to stderr (the tick log), never to
stdout. Keep tick hooks fast: they run every minute.

## Moving to another machine

`local/` is per machine and is not synced. Copy the directory over (scp, a dotfiles repo of your own), adjust
absolute paths, then `bin/toli helper install --all` and `bin/toli helper status`.
