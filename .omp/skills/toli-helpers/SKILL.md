---
name: toli-helpers
description: Create, schedule, and check private machine helpers (scripts that keep this machine healthy) in the gitignored local/ directory. Use when Malik asks to add a maintenance script, run X every N minutes on this machine, clean disk automatically, reconnect a VPN, keep a local service running, or asks what helpers a machine runs.
---

# Custom machine helpers

A helper is a script this machine runs for itself on a schedule: disk cleanup, a VPN reconnect, a backup, keeping a
small service up. It is not a scheduled job (`skill://toli-schedule`): jobs are agent prompts that run in headless
omp; helpers are plain programs that run without any agent.

Everything about helpers is private to the machine:

    local/scripts/<name>     the program (any language; executable, or run through an interpreter in "exec")
    local/helpers.json       the registry; a helper must be listed here to be scheduled
    local/hooks/             optional: post-init, pre-tick, post-tick executables toli runs itself
    logs/helpers/<name>.log  each helper's output

`local/` is gitignored. Never commit anything from it, never copy a helper into tracked toli files, and never put a
secret in `helpers.json` (read secrets at run time from a 0600 file, the environment, or the OS keyring: the macOS
Keychain via `security`, or `secret-tool` on a Linux desktop; a headless Linux box or WSL2 usually has no keyring).

## Registry format

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

- `exec`: absolute, or relative to the toli root. The working directory is the toli root, so relative `args` work.
- `schedule`: exactly one of `{"every": "90s"|"15m"|"1h"|"1d"}`, `{"cron": "m h dom mon dow"}`, or `{"always": true}`
  (keep one process running and restart it when it exits; launchd or systemd only).
- Optional: `description`, `args`, `runAtLoad` (also run once when installed and at login), `nice` (0-19),
  `lowPriorityIO`, `env` (`PATH` here replaces the default scheduled PATH), `platforms`, `enabled` (default true).

## Creating a helper (Malik asks for one)

1. Confirm the schedule back in words ("Ji Malik, a disk cleanup every 15 minutes on this machine"). Ask once if
   the interval or the machine is unclear.
2. Dispatch one jawan (`skill://toli-dispatch`) with a brief that says: write `local/scripts/<name>` (executable,
   idempotent, logs what it did to stdout, exits non-zero on failure), add its entry to `local/helpers.json`, run it
   once with `bin/toli helper run <name>` and paste the output, then `bin/toli helper install <name>` and paste
   `bin/toli helper status <name>`. Out of scope: any tracked file. Commit nothing; `local/` is private.
3. Relay the outcome in one or two lines: what it does, how often, and that it is installed.

Destructive helpers (anything that deletes) need a dry-run mode, and the jawan shows a dry-run first; install only
after Malik agrees to what it would remove.

## Commands

    bin/toli helper list [--json]              # registry: schedule, enabled, installed, description
    bin/toli helper status [<name>] [--json]   # scheduler state: loaded, running pid, last exit; flags unregistered leftovers
    bin/toli helper install <name> | --all     # write and load the launchd agent / systemd timer / crontab line (re-running is safe)
    bin/toli helper uninstall <name> | --all   # unload and remove it (works even after the entry left helpers.json)
    bin/toli helper run <name>                 # run once now, in the foreground, with its env

Schedulers: launchd user agents `com.toli.helper.<name>` on macOS; systemd user units `toli-helper-<name>.service`
(+ `.timer`) on Linux; crontab lines tagged `# toli helper <name>` when systemd's user session is unavailable.
`TOLI_SCHEDULER=launchd|systemd|crontab` forces one (it also picks the tick's scheduler).

## Changing or removing

- Edit the entry, then `bin/toli helper install <name>` again (it reloads).
- To stop one: `bin/toli helper uninstall <name>`, then delete its entry and script (or set `"enabled": false`).
- `helper status` showing `NOT REGISTERED` means an installed helper has no entry any more: uninstall it.
- A helper `installed, NOT loaded`: reinstall it, then check its log in `logs/helpers/<name>.log`.

## Hooks

`local/hooks/post-init` runs after `bin/toli init`; `pre-tick` and `post-tick` run around every scheduler tick.
Each gets the toli root as `$1`. A hook must be executable; a missing hook is skipped, and a failing one is reported
but never fails toli. Keep tick hooks fast (they run every minute).
