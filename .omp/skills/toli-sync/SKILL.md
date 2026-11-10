---
name: toli-sync
description: Keep the toli repo current across Malik's machines, bootstrap a fresh machine, and explain the per-machine Sardars, the coordinator, and how work and results flow between machines. Use for /sync-toli, when setting up Sardar on a new machine, when the digest says a new toli release is out, or when Malik asks about the fleet, other machines, or updating Sardar.
---

# Machines and sync (/sync-toli)

The toli repo is cloned on each machine in the fleet (one or more). Rules, skills, and the CLI are tracked in git;
everything private (`projects/ data/ state/ config/ logs/ local/ .env* .lavish/`) stays on each machine.

## Roles

- **Every machine has its own Sardar** (docs/sardars.md): a lead service (`bin/toli lead install`) keeps its lead
  conversation served when no terminal session is open. Each Sardar dispatches only its own machine's jawans, and
  every jawan reports only to the Sardar of the machine it runs on. Malik may talk to any of them.
- **Coordinator**: the Sardar Malik talks to day to day, and the one that keeps the fleet view. It holds
  `config/fleet.json` (every machine's name, ssh host, and repo root), sees the whole fleet with
  `bin/toli digest --fleet`, and receives job results and toli alerts from the other machines in its inbox.
- **Worker**: any other machine. It knows the coordinator from `config/machine.json` (`coordinator: {ssh, root}`).

Each machine's `data/projects.json` lists only its own clones; a project may be cloned on several machines.

## Working across machines

    bin/toli lead install|status        # this machine's lead service (start now and at every login/boot)
    bin/toli talk <machine>             # attach to that machine's Sardar conversation
    bin/toli talk <machine> "<words>"   # send that Sardar a message; it answers with talk back
    bin/toli delegate <machine> "<title>" --brief <file> [--project <p>] [--for T<n>]
    bin/toli task list --fleet          # every machine's open tasks (fleet ids <machine>/T<n>)
    bin/toli fleet queues               # every machine's queue depth, shortest first
    bin/toli pick --project <p>         # the shortest queue for one unit of work (exit 2 only when none qualifies)
    bin/toli resources                  # this machine: queue, load, free memory/disk, runs, clones
    bin/toli fleet status               # every machine in config/fleet.json, probed over ssh in parallel

Work for another machine goes to its Sardar with `delegate`: the task lands in that machine's backlog, its Sardar
dispatches its own jawans, and the result or question comes back here as a wake (`skill://toli-dispatch`, step 3).
Machines are ranked by queue depth, never by CPU, load or memory; those are shown for information. No machine starts
a jawan on another: `bin/toli remote` refuses and points to `pick` and `delegate`, and `bin/toli exec` refuses a
prompt from another machine. Spawn slots (`capacity.maxRuns` in `config/machine.json`, default cpus/4) still cap
jawans per machine. Free disk is never a threshold: below `capacity.diskKeepGB` (60) the disk keeper frees build
output before work starts (`bin/toli disk keep`, docs/disk.md); a full disk means delete every `target/`, in use or
not, without asking. An unreachable machine is reported, never fatal.

## Syncing the repo

    bin/toli sync          # this machine: fast-forward-only pull
    bin/toli sync --all    # coordinator: this machine, then every fleet machine over ssh

Run `sync --all` through `bash` with `async: true` and `timeout: 0` (it reaches every machine over ssh) and end the
turn; relay its result when it arrives.

- Sync refuses a dirty repo. Report what is uncommitted and ask Malik; never stash, reset, or clean to get past it.
- A non-fast-forward (diverged history) is also a stop: report it, do not merge or rebase on your own.
- After a sync that changed skills or the extension, tell Malik a session restart picks up the new behaviour.
- `--all` from a worker: explain that fleet-wide sync runs from the coordinator.
- Sync pulls the branch a development clone is on; a release install (detached at a `vX.Y.Z` tag) upgrades to the
  latest tag instead. Workers run release tags; the coordinator (where toli is developed) runs `develop`, where
  `main` moves only at a release. `sync --all` after a release therefore moves every worker to the new tag. Putting
  a worker on releases (`git checkout --detach vX.Y.Z` there, then `bin/toli self sync`) needs Malik's word, a clean
  tree and no active runs (docs/fleet.md#keeping-machines-in-sync).

## New toli releases

Every 3 days the tick checks for a newer toli release in the background (`bin/toli update status`); the next
digest shows it once as `Update: toli vX.Y.Z is out ...` with its CHANGELOG sections.

- Tell Malik once, in plain words: the new version, the few changes that matter to him, and that it updates only on
  his word. Never raise the same version again; the digest will not either.
- He confirms: dispatch a jawan (start a task first) whose brief quotes his word and runs `bin/toli upgrade`, which
  checks out the release and runs `bin/toli migrate` and `bin/toli harness sync`, then `bin/toli lead install` so
  this machine's lead service runs (each machine's Sardar does the same on its own machine); it reports the output,
  and any refusal (local edits to tracked files) verbatim. Relay the result and that a session restart loads the new
  contract and skills.
- On a development clone (the notice says `development clone on branch <b>`) `upgrade` refuses: the jawan updates
  it with git instead (fetch the tag, fast-forward or merge into `<b>`), stopping on any conflict.
- He says "not now" or "skip this one": `bin/toli update snooze vX.Y.Z`. "Stop checking": `bin/toli update off`
  (no network checks at all; `bin/toli update on` resumes). Never upgrade without his word.

## Bootstrapping a fresh machine

On the new machine, in the directory where the clone should live:

    git clone https://github.com/yuyudhan/toli toli
    cd toli && bun install
    bin/toli init --name <machine> --role coordinator
    # or, for a worker:
    bin/toli init --name <machine> --role worker --coordinator-ssh <host> --coordinator-root <path>
    bin/toli doctor
    bin/toli schedule install
    bin/toli lead install

- Run `bin/toli doctor` through `bash` with `async: true`. Relay each failure (bun, omp, git, gh auth, no-mistakes,
  machine config, project clones, fleet reachability and availability, scheduler) in plain words; fixes that need
  more than Malik's own action go to a jawan.
- On the coordinator, add the new machine to `config/fleet.json` so `--fleet`, `--all`, `fleet status`,
  `fleet queues`, `pick`, `delegate` and `talk` reach it. Every machine that should pick, delegate or talk needs the
  full fleet list in its own `config/fleet.json`.
- Re-add the projects cloned on this machine with `/add-project` (`skill://toli-projects`).
- Machine helpers are per machine and never synced: `local/` is gitignored. If this machine needs any (disk cleanup,
  VPN reconnect), follow `skill://toli-helpers`; a copied `local/` from another machine is installed with
  `bin/toli helper install --all` and checked with `bin/toli helper status`.

## Results flowing between machines

- New inbox items and job results reach the open Sardar session by themselves as `[toli wake]` messages (each once);
  with no session open, the lead service takes them in a headless turn.
- A jawan's outcome goes only to its own machine's inbox. A delegated task reports done, held or dropped to the
  delegating machine's inbox by itself.
- On a worker, every job result and toli alert is also sent to the coordinator's inbox over ssh
  (`bin/toli inbox add`).
- Everything sent to another machine (job results, alerts, delegations, delegated-task reports, `talk` messages)
  waits in `state/outbox/` while that machine is unreachable and retries every minute.
- `bin/toli inbox list --unseen` (and `/bearings`) shows them; `bin/toli inbox ack` clears them after Malik has seen
  them.
- To send a one-off note to another machine's Sardar: `bin/toli talk <machine> "<words>"`.
