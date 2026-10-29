---
name: mate-sync
description: Keep the mate repo current across Malik's machines, bootstrap a fresh machine, and explain coordinator and worker roles and how results flow between them. Use for /sync-mate, when setting up mate on a new machine, or when Malik asks about the fleet, other machines, or updating mate.
---

# Machines and sync (/sync-mate)

The yuyudhan-mate repo is cloned on three machines. Rules, skills, and the CLI are tracked in git; everything private
(`projects/ data/ state/ config/ logs/ .env* .lavish/`) stays on each machine.

## Roles

- **Coordinator**: the main mate. Malik talks to it day to day. It holds `config/fleet.json` (every machine's name,
  ssh host, and repo root), can see the whole fleet with `bin/mate digest --fleet`, and receives results from workers
  in its inbox.
- **Worker**: has some projects cloned and runs their work and jobs. It knows the coordinator from `config/machine.json`
  (`coordinator: {ssh, root}`).

Each machine's `data/projects.json` lists only its own clones; a project may be cloned on several machines. Work goes
to whichever machine is free:

    bin/mate resources              # this machine: load, free memory/disk, active runs, clones, available or why not
    bin/mate fleet status           # every machine in config/fleet.json, probed over ssh in parallel
    bin/mate pick --project <p>     # best machine for one unit of work (exit 2 + reasons when none)
    bin/mate remote auto "<prompt>" --project <p>   # prints `local`, or clones if needed and runs it there

`bin/mate remote <machine> "<prompt>"` targets a named machine. Output is saved in `data/remote/<stamp>-<machine>.md`.
Remote runs execute through `bin/mate exec` on the target and count as load there while they run. Per-machine
thresholds live in `config/machine.json` `capacity` (`maxRuns`, default cpus/4; `maxLoadPerCpu` 0.8;
`minMemAvailableMB` 2048; `minDiskFreeGB` 5). An unreachable machine is reported, never fatal.

## Syncing the repo

    bin/mate sync          # this machine: fast-forward-only pull
    bin/mate sync --all    # coordinator: this machine, then every fleet machine over ssh

- Sync refuses a dirty repo. Report what is uncommitted and ask Malik; never stash, reset, or clean to get past it.
- A non-fast-forward (diverged history) is also a stop: report it, do not merge or rebase on your own.
- After a sync that changed skills or the extension, tell Malik a session restart picks up the new behaviour.
- `--all` from a worker: explain that fleet-wide sync runs from the coordinator.

## Bootstrapping a fresh machine

On the new machine, from Malik's home directory:

    git clone <yuyudhan-mate url> ~/code/yuyudhan-mate
    cd ~/code/yuyudhan-mate && bun install
    bin/mate init --name <machine> --role coordinator
    # or, for a worker:
    bin/mate init --name <machine> --role worker --coordinator-ssh <host> --coordinator-root <path>
    bin/mate doctor
    bin/mate schedule install

- Read `bin/mate doctor` output line by line and fix or report each failure (bun, omp, git, gh auth, no-mistakes,
  machine config, project clones, fleet reachability and availability, scheduler).
- On the coordinator, add the new machine to `config/fleet.json` so `--fleet`, `--all`, `fleet status`, and `pick`
  reach it. Every machine that should pick or dispatch needs the full fleet list in its own `config/fleet.json`.
- Re-add the projects cloned on this machine with `/add-project` (`skill://mate-projects`).

## Results flowing to the coordinator

- On a worker, every job result is also sent to the coordinator's inbox over ssh (`bin/mate inbox add`).
- If the coordinator is unreachable, results wait in `state/outbox/` and retry every minute.
- On the coordinator, `bin/mate inbox list --unseen` (and `/bearings`) shows them; `bin/mate inbox ack` clears them
  after Malik has seen them.
- To send a one-off note from a worker: `bin/mate inbox add --from <machine> --title "<t>"` with the body on stdin.
