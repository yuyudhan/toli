---
name: toli-sync
description: Keep the toli repo current across Malik's machines, bootstrap a fresh machine, and explain coordinator and worker roles and how results flow between them. Use for /sync-toli, when setting up Sardar on a new machine, or when Malik asks about the fleet, other machines, or updating Sardar.
---

# Machines and sync (/sync-toli)

The toli repo is cloned on each machine in the fleet (one or more). Rules, skills, and the CLI are tracked in git;
everything private (`projects/ data/ state/ config/ logs/ local/ .env* .lavish/`) stays on each machine.

## Roles

- **Coordinator**: the main Sardar. Malik talks to it day to day. It holds `config/fleet.json` (every machine's name,
  ssh host, and repo root), can see the whole fleet with `bin/toli digest --fleet`, and receives results from workers
  in its inbox.
- **Worker**: has some projects cloned and runs their work and jobs. It knows the coordinator from `config/machine.json`
  (`coordinator: {ssh, root}`).

Each machine's `data/projects.json` lists only its own clones; a project may be cloned on several machines. Work goes
to whichever machine is free:

    bin/toli resources              # this machine: load, free memory/disk, active runs, clones, available or why not
    bin/toli fleet status           # every machine in config/fleet.json, probed over ssh in parallel
    bin/toli pick --project <p>     # best machine for one unit of work (exit 2 + reasons when none)
    bin/toli remote auto "<prompt>" --project <p>   # prints `local`, or clones if needed and runs it there

`bin/toli remote <machine> "<prompt>"` targets a named machine. Output is saved in
`data/projects/<project>/runs/<stamp>-<machine>.md` with `--project <project>`, else in
`data/remote/<stamp>-<machine>.md`.
Remote runs execute through `bin/toli exec` on the target and count as load there while they run. Per-machine
thresholds live in `config/machine.json` `capacity` (`maxRuns`, default cpus/4; `maxLoadPerCpu` 0.8;
`minMemAvailableMB` 2048; `minDiskFreeGB` 5). An unreachable machine is reported, never fatal.

## Syncing the repo

    bin/toli sync          # this machine: fast-forward-only pull
    bin/toli sync --all    # coordinator: this machine, then every fleet machine over ssh

Run `sync --all` through `bash` with `async: true` and `timeout: 0` (it reaches every machine over ssh) and end the
turn; relay its result when it arrives.

- Sync refuses a dirty repo. Report what is uncommitted and ask Malik; never stash, reset, or clean to get past it.
- A non-fast-forward (diverged history) is also a stop: report it, do not merge or rebase on your own.
- After a sync that changed skills or the extension, tell Malik a session restart picks up the new behaviour.
- `--all` from a worker: explain that fleet-wide sync runs from the coordinator.

## Bootstrapping a fresh machine

On the new machine, in the directory where the clone should live:

    git clone https://github.com/yuyudhan/toli toli
    cd toli && bun install
    bin/toli init --name <machine> --role coordinator
    # or, for a worker:
    bin/toli init --name <machine> --role worker --coordinator-ssh <host> --coordinator-root <path>
    bin/toli doctor
    bin/toli schedule install

- Run `bin/toli doctor` through `bash` with `async: true`. Relay each failure (bun, omp, git, gh auth, no-mistakes,
  machine config, project clones, fleet reachability and availability, scheduler) in plain words; fixes that need
  more than Malik's own action go to a jawan.
- On the coordinator, add the new machine to `config/fleet.json` so `--fleet`, `--all`, `fleet status`, and `pick`
  reach it. Every machine that should pick or dispatch needs the full fleet list in its own `config/fleet.json`.
- Re-add the projects cloned on this machine with `/add-project` (`skill://toli-projects`).
- Machine helpers are per machine and never synced: `local/` is gitignored. If this machine needs any (disk cleanup,
  VPN reconnect), follow `skill://toli-helpers`; a copied `local/` from another machine is installed with
  `bin/toli helper install --all` and checked with `bin/toli helper status`.

## Results flowing to the coordinator

- New inbox items and job results reach the open Sardar session by themselves as `[toli wake]` messages (each once).
- On a worker, every job result is also sent to the coordinator's inbox over ssh (`bin/toli inbox add`).
- If the coordinator is unreachable, results wait in `state/outbox/` and retry every minute.
- On the coordinator, `bin/toli inbox list --unseen` (and `/bearings`) shows them; `bin/toli inbox ack` clears them
  after Malik has seen them.
- To send a one-off note from a worker: `bin/toli inbox add --from <machine> --title "<t>"` with the body on stdin.
