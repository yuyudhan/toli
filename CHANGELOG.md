# Changelog

Every toli release is an annotated git tag `vX.Y.Z` (semver) with a section here. `just release` writes new sections
from the commits since the previous tag; `bin/toli upgrade` prints the sections between your version and the new
one. See docs/releasing.md.

## v0.5.1 - unreleased

### Fixed

- **Peers: the pairing code no longer looks like a piece of the fingerprint (T1262).** `peer accept` prints it on its
  own `Pairing code: NNNN (tell this to <name>'s requester)` line, and fingerprints print in colon-joined groups of
  eight instead of 4-character groups that Sardars relayed as the code. Display only; the protocol is unchanged.
- The disk keeper never deletes a build folder a running container mounts, at any disk level including the last
  resort: a bind mount's folder, a volume's mountpoint, or the folder a compose stack's volume hangs on inside its
  bind (itlinux3's `apps/backend/target`, deleted 3 times under live dev containers, which broke the backend) (T1256).
- `bin/toli commit --merge` no longer prints an error after a successful commit when the merge deletes a file: the
  post-commit checkout skips a deleted file the `git merge` in progress already removed (T1257).
- A jawan killed by systemd-oomd, the kernel OOM killer or a signal now records an outcome that names the cause
  (`killed by systemd-oomd (SIGKILL, 86 processes): memory pressure ...`, `killed by SIGKILL`) with its log tail. On
  Linux the harness runs in its own `toli-jawan-<run id>.scope` and the supervisor in `toli-supervisor-<run id>.scope`,
  so an OOM kill no longer takes the supervisor with it. A supervisor outlives SIGTERM, SIGHUP and SIGINT while its
  harness runs. A run whose supervisor died anyway is recorded failed by the next digest or tick with the best cause
  found, never just "no outcome" (T1255).

## v0.5.0 - 2026-11-13

Peer messaging over HTTPS: see v0.5.0-rc.1 and v0.5.0-rc.2 below, which this release completes.

### Fixed

- With `peer.sshFallback` off, a paired peer is no longer pulled over ssh either. On a machine without a listener,
  its messages now arrive only by the HTTPS pull (T1249).

## v0.5.0-rc.2 - 2026-11-13

### Fixed

- Upgrading from v0.4.x now gives the machine its peer identity. The older toli's `upgrade` never ran `peer init`,
  so the lead started no listener. `bin/toli migrate`, which every upgrade runs from the new code, now makes the
  identity when it is missing (T1249).
- The peer listener no longer binds container and VM bridges (`docker*`, `br-*`, `veth*`, `virbr*`, `cni*`,
  `podman*`, macOS `bridge*`/`vmnet*`, ...). Every container or VM on the machine could reach those addresses. A
  tunnel (`utun*`, `tun*`, `ppp*`) is bound only for its 100.64/10 VPN address. `peer.interfaces`
  (`bin/toli peer set --interfaces <name,...>`) names any interface to bind anyway (T1249).

## v0.5.0-rc.1 - 2026-11-12

### Added

- **Peers: Sardar-to-Sardar messaging over HTTPS on a private network.** Two toli installations pair once with a
  4-digit code (`bin/toli peer add <host>` on one, `peer accept <request>` on the other, which shows the code: two
  minutes, one use, three tries, never stored; the code is key-bound with CPace on ristretto255 from the audited,
  pinned `@noble/curves`). After that every message (talk, delegate, a delegated task's update and answer, share,
  status questions) is one Ed25519-signed envelope sent over HTTPS with the peer's certificate pinned, checked for
  key, addressee, a 5-minute window, a fresh nonce, the permission and the sender's claim, and applied exactly once
  with a receipt. The lead service runs the listener (`peer serve`) on private addresses only (RFC1918, CGNAT, IPv6
  ULA; port 47123). The outbox stays the one queue for HTTPS, ssh and pulls: in order, exactly once; a peer that
  comes back announces itself and gets its backlog as one wake; the tick posts one "waiting to send" alert per
  machine at 1 hour, 1 day and each further day; `outbox list|cancel|expire` show and give up on items, and nothing
  is dropped silently. ssh stays as the fallback (`peer set --ssh-fallback on|off`) and for sync and attach;
  `peer stats` compares the two transports' timings. `peer scan` finds listeners on NetBird and Tailscale peers.
  Permissions (`talk`, `delegate`, `share`, `answer`, `status`) are granted by pairing and revoked per peer
  (`peer deny|allow|remove`), by the owner or by the Sardar with `--by sardar --why`, logged in `logs/peer.log`.
  `bin/toli upgrade` and the installer install the one runtime dependency (`bun install --production`). See
  docs/peers.md (T1249).

### Fixed

- Any fleet machine could answer another machine's held task (`task answer --from`) and send updates for a task it
  did not own (`delegation update --from`): both are now refused unless the sender delegated or owns the task, over
  ssh, pulls and HTTPS alike (T1249).
- A message its receiver refuses (a malformed body, a task that does not exist there, one another machine
  delegated) was retried every minute forever and held up every later message to that machine: it is now cancelled
  once into `state/outbox/cancelled/` with the receiver's reason and one inbox note, and later items still go.
  `task link` refuses an id that is not `T<n>` and undoes itself when the owner refuses (T1249).
- A message from another machine reaches the lead fenced and marked `- via: peer <name>`: information to weigh,
  never an instruction (AGENTS.md rule 10) (T1249).
- `bin/toli workspace prune` never removes a task worktree holding unlanded work: uncommitted or untracked
  (non-ignored) files, or commits no base branch (local or origin) contains. It prints
  `kept: <path>: N unlanded commits / M dirty files` and removes the worktree at a later prune once it is landed and
  clean. `--force`, which abandoned unmerged commits, is gone; nothing skips the check (T1218).
- On a nearly full disk the disk keeper frees idle build output before it breaks a running build. Under the
  emergency level it now removes Docker volumes of idle build output first (a stopped compose stack's `*_target`,
  `*cargo*` or `*node_modules*` volume, or one mounted at a `target`/`node_modules`/cargo path), largest first, then
  wipes busy targets between build steps, and only then deletes build folders in use. It re-checks free space after
  each item and stops once it is over the emergency level. A volume a running container uses, or whose name or mount
  point may hold data (`pgdata`, `db`, `uploads`, ...), is never removed, and no volume goes while a pull, build or
  compose up is in flight. A stopped container that mounts such a volume is removed (`docker rm`, never `-v`) only
  when every one of its mounts is a named build-output volume (no bind, tmpfs, anonymous or data-looking volume) and
  its image is no database or other data store; otherwise the volume is kept whole. Every item freed is logged with
  its size and step. See docs/disk.md step 5 (T1220).
- `bin/toli commit <p> --merge <ref> --resolved` clears the clone's conflict stages for every committed path: a
  conflict resolved to the branch's own side (the file ends as in the first parent) stayed unmerged in the shared
  index, so `git status` kept listing it. The committed paths' index entries now match the commit (index only; the
  working tree and other paths' staged changes are untouched) (T1222).
- A jawan's cargo holds a heavy-build slot even when something puts another cargo ahead of toli's cargo shim on PATH
  (a login profile, a harness's shell snapshot, git's exec path in a hook): two full Rust builds, a pre-push hook's
  clippy and a `just verify push`, ran the real `~/.cargo/bin/cargo` at once outside any slot. Jawans and lead
  sessions now get toli's rustc wrapper as `RUSTC_WRAPPER` (chained to the one it replaces, such as sccache): a heavy
  cargo outside a slot waits on its first rustc call until a detached holder takes a slot for it, which it holds until
  that cargo exits or is killed; nested cargo (cargo-clippy's `cargo check`) and build scripts reuse it. Live-stack
  projects keep their exemption. See docs/fleet.md "Heavy-build slots" (T1223).
- A heavy build's systemd scope also sets `MemoryHigh` (90% of `capacity.buildMemoryMax`) and `MemorySwapMax=0`:
  with only `MemoryMax`, a build at its cap swapped the rest, filled the machine's swap and systemd-oomd killed the
  whole build (T1223).
- toli notices when a clone's own git hooks are not installed: a fresh clone ran none of its `.husky` hooks, so its
  pre-push check never ran on pushes. `bin/toli project add`, `project ensure` and `project setup <name>` install the
  hooks a repo declares where they can tell how (husky, a hooks directory a recipe or doc sets `core.hooksPath` to)
  and print the command for the rest (`.githooks/`, pre-commit, lefthook); `project setup` and `bin/toli doctor`
  report what is missing; `bin/toli push` refuses while a declared pre-push hook is not installed (`--no-hooks-ok`
  pushes anyway). See docs/projects.md "Git hooks" (T1253).

### Changed

- Gates run once per git tree, not per commit: an amended, rebased or empty commit with the same files reuses the
  pass. A pass is sealed with an HMAC over its project, tree, recipe and end time, keyed by `state/gate-key` (made once
  per installation, mode 0600, never committed; a symlinked, foreign or group/other-readable key is refused). A
  project's pre-push hook skips its own run only when `bin/toli gate check` verifies that proof for an identical clean
  tree; edited, copied or invented records, `TOLI_GATE_*` variables and dirty checkouts never skip it. Records from
  before (keyed by commit, unsealed) are not reused; each gate runs once more. See docs/delivery.md "Gates" (T1241,
  from itlinux10).

## v0.4.5 - 2026-11-12

### Fixed

- The fixed-branch test runs its project and commit steps in process, so it stays well under its time limit on a
  busy machine (T1147).
- A project's push checks (the gate runner and `bin/toli push` with a pre-push hook) hold one heavy-build slot for
  the whole check, with cargo's build and test threads capped to the slot's share, and run inside the slot's
  memory-capped scope on Linux, so one push check no longer takes every core or runs without a memory limit (T1148).
- A `--for` slice of a task that its jawan is still working on never closes the parent task (T1156).
- Delegating the same work again (same sender, `--for` task, project, title and brief) makes no second task while
  the first is open, and a copy already waiting in the outbox is not queued twice (T1158).
- The disk keeper never deletes part of a build target that a running build is using; a busy target is skipped
  whole (T1182).
- The disk keeper never prunes Docker while a Docker pull or build is running (T1186).

## v0.4.4 - 2026-11-12

### Upgrading

- Linux machines that added a temporary `toli-tick.service.d/*killmode.conf` drop-in can remove it after
  `bin/toli schedule install` has rewritten `toli-tick.service` with `KillMode=process`, then run
  `systemctl --user daemon-reload`.
- Machines still on v0.4.2 or older need the first-hop steps from the v0.4.3 notes: after `bin/toli upgrade`, run
  `bin/toli lead install` and `bin/toli schedule install` by hand once (docs/install.md#upgrading).

### Added

- Jawan rules (brief templates, AGENTS.md section 0b, toli-dispatch): never signal omp, claude, tmux, terminals, the
  lead, or any process the jawan did not start; to pause, stop starting new steps (T1126).

- When a `bin/toli spawn` run's harness exits, its supervisor closes the automation browsers the run left open (a
  Chrome, Chromium, Edge, Brave or Firefox started with remote debugging, headless, `--enable-automation`,
  marionette, or a temp-dir `--user-data-dir`). Only the run's own processes count: its tree, sampled while it runs,
  and on Linux the processes that inherited its `TOLI_RUN_ID`. A default-profile browser is never touched. The
  brief templates and the dispatch skill tell browser and screenshot jawans to close their browsers before reporting
  (T1121). Browsers are recognised by their executable (Chrome, Chromium, chrome-headless-shell, Edge, Brave,
  Firefox), so a script, `npx` tool or MCP server whose name or arguments merely mention one is never closed.

### Changed

- Native subagent jawans (active tasks recorded with `task start --agent <id>`) share `capacity.maxRuns` with spawn
  runs: `bin/toli spawn` queues when they fill the slots, and the digest, `bin/toli resources` and
  `bin/toli fleet queues` show `jawans <n>/<slots> (<k> native subagents)`, or
  `jawans at cap N/N (...): queue instead`, which the dispatch skill reads before starting another subagent.
  `resources --json` publishes `queue.subagents` (T1121).

### Fixed

- On macOS, `bin/toli helper status|install|uninstall`, `schedule status|install|uninstall` and
  `lead status|install|uninstall` see a helper, tick or lead installed as a system LaunchDaemon
  (`/Library/LaunchDaemons/com.toli.*.plist`) and keep it there: status reports it installed, in the system domain,
  instead of "not installed"; install rewrites and reloads the daemon as root through `sudo -n` (changing nothing
  without cached credentials) and retires a LaunchAgent of the same label instead of adding a second copy; uninstall
  removes the daemon. Machines without one keep the user agent in `~/Library/LaunchAgents` (docs/helpers.md). When a
  `sudo -n` step fails, install leaves the daemon as it was: a failed write removes the staged plist, and a failed
  bootout puts the previous plist back, still loaded (T1119).
- `bin/toli inbox ack` and `bin/toli job ack` no longer acknowledge results that arrived after the lead was shown its
  wake, which were then never shown to any lead. An ack now covers only what was shown: each `[toli wake]` (and the
  headless lead turn) ends with `bin/toli inbox ack --through <stamp>` / `bin/toli job ack --through <stamp>` for the
  items it showed, the digest's Next block gives the same for the results it lists, and a plain `ack` stops at the
  newest item a wake, `inbox list` or `job results` showed. Newer items stay unread and wake the lead again. Results
  delivered by a toli that predates this wake the lead once more after the upgrade, then ack as usual (T1124).
- On Linux with systemd, the background work the minute tick starts (the disk keeper, the update check and
  `fleet check --wake`) now runs to the end. `toli-tick.service` uses `KillMode=process`; before, systemd killed
  them with the tick's cgroup as soon as `bin/toli job tick` exited, so the disk keeper never freed space. Run
  `bin/toli schedule install` once to rewrite the unit (T1128).

## v0.4.3 - 2026-11-12

### Added

- On Linux with a systemd user manager, each `bin/toli build-slot` build (and so each heavy cargo command through
  the shim) runs in its own `toli-build-<slot>-<pid>.scope` capped at `capacity.buildMemoryMax` MB (default three
  quarters of the RAM split over the build slots; 0: no cap), so an out-of-memory kill takes that build, not the
  session that started it. macOS, hosts without `systemd-run` and `TOLI_BUILD_SCOPE=off` start builds as before;
  where `systemd-run` cannot make the scope (no user session bus over ssh, no lingering) the build runs without it
  after one warning line.

### Changed

- A short install command, first in README.md and docs/install.md:
  `curl -fsSL https://yuyudhan.github.io/toli/install | sh`. That address serves `install.sh` of the latest
  release byte for byte (the site's sync job checks it against GitHub's copy at the release tag); the
  raw.githubusercontent.com URL stays documented as the fallback.

### Fixed

- `bin/toli commit` no longer lands a `git merge` in progress (MERGE_HEAD) as a one-parent commit, which left the
  merged commit out of the history so later merges conflicted again. Such a commit is now refused, naming the merge;
  `--merge <its sha>` (or `--merge MERGE_HEAD`, with `--resolved -- <conflicted paths>` after conflicts) adopts the
  merge from the working tree, records both parents and ends the merge (T1105).
- `bin/toli task list` and `task list --fleet` show a waiting task's `(waiting on: <what>)`, so a task parked with
  `task wait` (active, no jawan) no longer reads as active with no live run in the hourly fleet update. The stale
  check, the tick and `fleet check` already left it out; a held task is parked by its status instead (T1112).
- `bin/toli build-slot` (and so the cargo shim) serves waiters in arrival order: each waiter holds a numbered ticket
  in `state/build-slots/queue/` and only the oldest live one takes a freed slot, so a later build never passes an
  earlier one; a waiter that dies leaves the line.
- Native subagent jawans (omp `task`, Claude Code's Agent tool) build through the heavy-build slots like
  `bin/toli spawn` jawans: a lead session gets toli's cargo shim first on PATH and `CARGO_BUILD_JOBS` (omp's
  extension adopts them when it loads, Claude Code's SessionStart hook writes them to `CLAUDE_ENV_FILE`; new
  `bin/toli hook lead-build-env`), and its subagents inherit them. A build in a live-stack project's checkout skips
  the slots, as that project's jawans do.
- `install.sh` reports an unreachable release repository (offline, a wrong `TOLI_REPO_URL`) in one
  `toli install: cannot list tags at ... (<git's reason>)` line instead of git's own lines followed by its own.
- An answered hold is dispatched once, by the lead that answered it. `bin/toli task answer` run by this machine's
  own lead posts no inbox wake (only an answer forwarded from another machine's lead does), an answered task is not
  stale until `oversight.staleTaskMinutes` after the answer, and a headless lead turn (`TOLI_LEAD_TURN=headless`)
  refuses `bin/toli spawn` and `resume` on a machine marked `lead full`, pointing to `bin/toli delegate`.
- `bin/toli upgrade` no longer ends running jawans. The lead's systemd unit uses `KillMode=process`, so stopping or
  restarting it ends only `lead run`, and an upgrade now ends by running `bin/toli lead install` and
  `bin/toli schedule install` from the new code for the services that are installed (systemd units the shell cannot
  reach are named and left alone). The first upgrade from v0.4.2 or older runs the old code's steps: run both
  commands by hand after it (docs/install.md#upgrading).
- The fleet queue depth (`bin/toli fleet queues`, `bin/toli pick`, lead balancing) counts native subagent jawans
  recorded with `bin/toli task start --agent` (one per agent id, unless a spawn run works on that task) and no longer
  counts held tasks; a balancing offer lists only tasks the other machine can take (not pinned here, a project it has
  a clone of or whose git URL is registered).
- The toli-release skill describes issue-tracker steps without fixed Atlassian MCP tool names, which differ between
  MCP server versions (it discovers the search, transition and edit operations when the server needs it).

## v0.4.2 - 2026-11-11

### Added

- A `task-end` hook: `local/hooks/task-end` runs when a task becomes done or dropped (and again when a jawan run ends
  on an already-closed task), with the task id, its status and its project as arguments, for a machine's own
  leftover cleaners (docs/helpers.md#hooks).

### Fixed

- A machine that pulls its messages gets each reply within about a minute even while fleet machines are down (it took
  up to 7 minutes with four offline). The tick's messaging pass pulls first, from every machine at once with a 5 s
  ConnectTimeout and a 30 s limit per call, so one that is down or stalled never holds up another's items; the outbox
  delivery follows. A host is tried once per pass: after its first failure its other items wait, in order, for the
  next pass. A host the tick cannot reach is backed off across ticks (`state/reach.json`: 30 s, doubling, at most 10
  minutes; a hand-run `outbox pull` still tries it). `fleet export` resolves every ssh name at once instead of one
  after another. Passes never overlap (a lock), and a tick waiting on a long job run moves messages every minute
  meanwhile (launchd and systemd start no tick while one runs) (docs/fleet.md#unreachable-machines). m5's tick with
  three machines down: about 3 minutes before, 7-17 s after.
- An async call (`runAsync`) no longer hangs after its program exits or is killed while something else holds its
  output open, as a shared ssh connection's master does for a client it served on a stalled link: output still open
  2 s after the exit is cut off.
- `bin/toli commit` applies every `--patch` file when the flag repeats, in the order given, instead of just one; a
  file that does not apply is named and nothing is committed.
- The cargo shim marks its environment (`TOLI_CARGO_SHIM_ACTIVE`) for what it runs, so a cargo wrapper placed after
  it on PATH can skip it instead of calling it back in a loop.

## v0.4.1 - 2026-11-10

### Added

- A machine can take no inbound ssh: `"inbound": false` on its entry in the coordinator's `config/fleet.json`. No
  toli call on another machine ssh-es into it; what they would have sent it (job results, `talk`, delegations and
  their updates, share and task answers, queue offers) waits in their outbox, and its minute tick pulls it
  (`bin/toli outbox pull`: `outbox pending` there, apply here, `outbox ack` there), each item applied once and in
  order per sender, nothing lost while either side is offline. The pull carries the fleet list, so workers learn the
  flag without ssh into the coordinator; their `doctor` reports such messages as waiting for the pull, not as an ssh
  problem (docs/fleet.md#machines-that-take-no-inbound-ssh).
- `just release` publishes the GitHub Release after the push: `gh release create vX.Y.Z --verify-tag --latest` with
  the tag's CHANGELOG section as notes (docs/releasing.md).

### Fixed

- The test suite can no longer write into the checkout it runs in: under the `pre-push` hook it inherited the hook's
  `GIT_DIR`, so temp repos' commits and a `v1.2.3` tag landed in the real repository. The preload drops every
  inherited `GIT_*` variable, sets `GIT_CEILING_DIRECTORIES` and a temp `HOME`, and fails the run when the real
  repository gains a test commit or a tag changes (docs/development.md). `just verify`'s install smoke drops them too.

## v0.4.0 - 2026-11-10

### Changed

- toli's ssh calls to fleet machines share one connection per host for ten minutes (`ssh -F state/ssh/config`:
  `ControlMaster auto`, `ControlPath state/ssh/%C`, `ControlPersist 10m`, after your own ssh config, whose `Control*`
  lines win), so a minute of fleet calls is one login instead of many. A control socket whose master no longer
  answers is removed before the call, so it never hangs past its timeout (docs/fleet.md#the-fleet-list).
- Queues rank by queued tasks plus running and waiting jawans per jawan slot (`capacity.maxRuns`); active tasks with
  no jawan here (a lead's bookkeeping, delegated work) are no longer queue, and `fleet queues` shows queued, running,
  active and held separately with the load per slot. `bin/toli lead full [--reason ...] [--until 2h] | --clear |
--status` (or `task handback ... --full`) marks a machine full: `pick`, `fleet queues` and the balancing offers
  pass it over until it clears. `bin/toli task handback <id> --reason "..."` gives delegated work back: the
  delegator's `--for` task is queued again, never dropped, and delegating or linking for a done or dropped task
  reopens it.
- Workers take `config/fleet.json` from the coordinator: `bin/toli self sync` (and `bin/toli fleet sync`) reads the
  coordinator's `bin/toli fleet export` (each machine as `user@host`) and rewrites the list, keeping the worker's own
  ssh names for machines it already lists.
- On Linux each jawan runs in its own systemd scope (`systemd-run --user --scope --unit toli-jawan-<run id>`), so an
  OOM kill of the lead service or of one jawan no longer takes every jawan the lead spawned.
- Queue depth and the balancing offer count only queued tasks waiting for a jawan: a queued task a run already works
  on, or one delegated elsewhere and still open, is neither counted twice nor offered to another lead.
- One lead per machine (docs/sardars.md). Every machine runs its own lead: `bin/toli lead install|uninstall|status|
run|attach` keeps its lead conversation served by a launchd agent, systemd user service or crontab line, taking
  wakes in headless turns whenever no lead session is open. Leads hand each other work with `bin/toli delegate
<machine> "<title>" --brief <file> [--project <p>] [--for T<n>]`: the task lands in that machine's backlog (fleet
  id `<machine>/T<n>`, idempotent, queued in `state/outbox/` while unreachable) and writes every change back onto the
  delegator's `--for` task (notes; done with commit and report in `data/reports/delegated/`; dropped), waking its
  lead for each outcome. The delegating lead answers a delegated question with `bin/toli task answer <machine>/T<n>`
  (forwarded to the owner) or, when only the user can decide, `bin/toli task escalate <machine>/T<n>` puts it in its
  own Needs-you queue; `bin/toli task link T<n> <machine>/T<n>` attaches a delegation made without `--for`. `bin/toli talk
<machine> ["<words>"]` attaches to or messages another machine's lead. `bin/toli task list --fleet [--cached]` is
  the shared list of every machine's tasks. `pick` and the new `bin/toli fleet queues` rank machines by task-queue
  depth, shortest first (ties: the clone, this machine, name); CPU, load and memory are shown but never exclude a
  machine, and the lead service offers or asks for work when queues differ by `lead.balanceGap` (every
  `lead.balanceMinutes`). `bin/toli remote` (`remote auto` included) now refuses with a pointer to `pick` and
  `delegate`, and `bin/toli exec` refuses prompts from another machine; runs started by `remote` earlier still finish
  and report as before. A spawned jawan's outcome and the low-disk alert go only to their own machine's inbox (that
  machine's lead settles its disk); job results still reach the coordinator. `bin/toli share "<learning>" [--to
<machine>|--all] [--from-user] [--source "..."]` sends a learning or best practice to other leads, who adopt it
  (dated, with its source, into their learnings, preferences for the user's own words, or project notes), adapt it or
  decline it with a reason; the answer comes back as a wake and `bin/toli share --list` shows them all.
- `capacity.diskKeep: false` in `config/machine.json` switches off every automatic deletion by the disk keeper
  (before jawan starts, in the tick, the background keeper, the fallback sweep); the default stays `true`. With it
  off toli deletes nothing on its own and, when free disk drops under 10 GB (or the emergency level), posts one inbox
  alert per machine every 6 hours naming the biggest build folders. `bin/toli disk keep` by hand still works and
  says `automatic deletion: off`; the new `bin/toli disk alert` posts the alert at once. See docs/disk.md.
- Jawan runs have no wall-clock limit by default (`bin/toli spawn`, `bin/toli remote`/`exec`, scheduled headless
  jobs): they work until done. `--max-time` stays as an explicit opt-in. A run counts as stuck only when it shows no
  progress for `capacity.stallMinutes` (default 30): no output, no omp session activity (messages, tool calls), no
  file change in its working tree, and under 10 CPU seconds in its process tree. A stalled run is stopped and
  resumed; after `capacity.autoResume` resumes (default 3) the chain stops and the inbox and task notes say why.
- A stopped run is resumed, never restarted: each omp run keeps its session in `<run dir>/session`, and the
  continuation runs `omp --resume <session file>` with a short continue prompt instead of re-reading the whole brief.
  Every resume is recorded on both runs and in the task's notes. Other harnesses still get a fresh run with a
  `## RESUME` section.
- omp's per-subagent request budget is off for toli: `.omp/config.yml` in toli's root sets
  `task.softRequestBudget: 0` (omp's default 200 told long subagent jawans to wrap up and force-stopped them at 300),
  and headless jawans working in project clones get it with `--config`.
- Brief templates say there is no time limit, to commit as you go, and that the session may be resumed.

### Added

- `bin/toli task pin T<n> [--reason "..."]` keeps a queued task on this machine (it needs code or state only this clone
  has): the queue balancer never lists it in an offer, and posts no offer when every queued task is pinned.
  `task unpin T<n>` releases it; `task list` and the digest show the pin.
- Live-stack mode: `bin/toli project set <p> --live-stack yes` lets one machine run many jawans (8-16) on one
  `same-branch` project against its running dev stack, which rebuilds on every save, instead of each jawan building
  on its own. Briefs keep the new `## Live stack` section (docs/brief-template.md): no own full build/test/lint while
  coding, commit only your own paths, fix the compile/runtime errors your change caused in the live logs, then browser
  and scoped tests against the green stack; the full check runs once per machine at integration or push.
  `bin/toli spawn` warns when such a brief lacks the section, and the project's jawans skip the heavy-build slot
  shim. `capacity.maxRuns` sizes the machine for it (docs/projects.md "Live-stack mode").
- `bin/toli task wait T<n> --on "<what>"`: an active task that deliberately waits (a deferred spawn, a push) is
  shown in Next as `waiting on <what>`, never as a re-dispatch, and the tick and `fleet check` leave it out. A task
  whose recorded run, or the latest run of its resume/replace chain, is alive is never reported stale, even when
  the run has no task id; `task start --agent` now records the task on a run spawned without `--task`.
- No idle nights. An active task whose recorded run ended `oversight.staleTaskMinutes` ago (default 15) and that
  nobody re-dispatched (a `bin/toli spawn` run that finished, a `bin/toli remote --task` run whose saved output
  finished, or no jawan at all) now heads the digest's Next block with the run's last report line and whether an
  answer was recorded since, and the tick posts it to the inbox once per ended run. `bin/toli remote --task` records
  `- task: T<n>` in its saved output for this.
- `bin/toli task answer` names every task waiting on the answer (those the hold's `--blocks` names, holds whose
  question names it, and the project's active tasks with no live run), each with its brief, and posts them as one
  inbox wake, so the lead re-dispatches all of them in the same turn.
- `bin/toli fleet check [--json] [--wake] [--local]`: idle machines (no active run) with queued work for a project
  cloned there, and active tasks with no live run, on every reachable machine, in one batched message. The
  coordinator's tick runs `fleet check --wake` every `oversight.fleetCheckMinutes` (default 60), away mode included,
  so no job prompt can silence it; the toli-afk and toli-schedule skills say jobs never skip while the user is away.
  See docs/fleet.md#oversight.
- `bin/toli resume <run> [--note "<text>"] [--max-time <minutes>] [--now]`: the lead continues any finished run in
  its own omp session.
- `bin/toli gate run|check|status <project> --recipe "<command>"`: a long gate (a verify, a push gate) runs once
  per commit. A pass is recorded under `state/gates/` with its sha, recipe and log, and a later run or push of the
  same commit skips it and says why. A gate runs as a detached process that outlives the jawan, hook or ssh session
  that started it; the next caller attaches to it instead of starting another. It has no time limit: it is stopped
  only after making no progress for `capacity.gateStallMinutes` (default 30). `bin/toli push --gate "<recipe>"` runs
  the gate first. toli's own pre-push hook skips a commit that already passed and records a clean-tree run for the
  pushed commit (a checkout that differs from it is checked as before, unrecorded). See docs/delivery.md.
- Heavy-build slots: each machine runs at most `capacity.buildSlots` heavy cargo builds at once (default cores / 6,
  at least 1); the rest wait for a slot instead of compiling together. Jawans get a `cargo` shim first on `PATH`
  that queues build, check, test, clippy, nextest, run, bench, doc and install for a slot
  (`bin/toli build-slot -- <command>`), and `CARGO_BUILD_JOBS` defaults to cores / slots, so the total matches the
  cores. `bin/toli resources` shows busy slots. See docs/fleet.md.

### Fixed

- The lead service runs the runtime `bin/toli self sync` installed after it started: after a pass that sees a newer
  runtime it exits 0 and launchd (KeepAlive) or systemd (`Restart=always`) starts it again on the new code, instead
  of serving the old snapshot until a reboot.
- `bin/toli` puts bun's directory last on `PATH` when it adds it, so the caller's order wins for every jawan it starts
  (rustup's `cargo` before Homebrew's, build wrappers first).
- `bin/toli commit --merge` names a locally modified file whole when it refuses (`CHANGELOG.md`, not `HANGELOG.md`).
- `bin/toli lead install` (and the tick and helper installs) no longer leave a running launchd agent unloaded. From a
  session launchd cannot bootstrap into (a jawan's background launchd session: `launchctl bootout` worked, `bootstrap`
  failed with 125) it now refuses before booting anything out, naming the fix (run it from a Terminal in the login
  session). When a bootstrap still fails after the bootout it puts the previous plist back and loads it again, and
  reports both errors if that fails too. `lead install` restarts a loaded agent whose plist is unchanged in place
  (`launchctl kickstart -k`) instead of booting it out.
- Jawans, lead turns and scheduled jobs started by the lead service, the tick or a helper get the user's login
  environment: before a harness starts, toli runs the login shell once (`$SHELL -i -l -c`) and adds the variables the
  service lacks, so provider keys exported in the shell profile (e.g. `ANTHROPIC_API_KEY`) reach them. Before, a
  launchd agent or systemd service passed PATH alone and every jawan it spawned failed with no API key. Nothing is
  stored: values stay in memory, PATH stays the service's. `bin/toli doctor` warns (names only) about a credential
  variable set in the shell but not by the login profile (docs/harnesses.md "Service environment").
- `bin/toli push` refuses, pushing nothing, when it has no `--word` and the project has no standing push grant on
  this machine (hard rule 1). Before, a push with neither went through and was only logged with `word=null`. The
  message names both ways on: `--word "<the user's word>"`, or `bin/toli project set <p> --standing-push yes`.
- A gate that works silently (cargo linking hundreds of test binaries before any test prints) is no longer stopped
  as stalled. Its stall check now is the jawan one: it counts the gate as stuck only when its log did not grow, its
  checkout did not change and its process tree burned under 10 CPU seconds for the stall minutes. Before, it watched
  the log alone and killed a busy `just verify all` after 30 minutes without output. A real hang is still stopped
  after the same time.
- A stopped gate or jawan run leaves no processes behind. A stall (and a jawan's time limit) sends SIGTERM to the
  run's whole tree, its own process group included, and SIGKILL after the grace (10 s for a gate, 30 s for omp) to
  whatever outlives it; the run is recorded stopped only once all are gone. Before, a gate cleared its SIGKILL as
  soon as its shell died, so a child ignoring SIGTERM ran on; a supervised run did the same, and `bin/toli exec`
  and scheduled jobs signalled omp alone. Only processes descending from the run are signalled: each is known by
  pid and start time, so a pid reused by another process (another jawan's build, the user's apps) is never touched.
- A gate, a commit and a push never take lost git output for an answer. On a loaded machine a git child that
  succeeded has handed back no stdout: a gate then ran at an empty sha and was recorded failed ("HEAD moved"), and an
  empty `git status` could make a dirty checkout look clean. Commit shas are now read with one check (a full sha, read
  once more if not, then refused), and whether a checkout differs from HEAD comes from `git diff --quiet` exit
  statuses, never from reading output.
- A toli lock left by a process killed inside it (a gate caller whose ssh session dropped, a killed jawan) is taken
  over at once: the lock file names its holder's pid. Before, the next caller waited 10 s for a lock that only went
  stale after 30 s, and failed ("timed out waiting for lock"), as a second `bin/toli gate run` did after its first
  caller was killed on a loaded machine.
- The disk keeper deletes build output in use (its last resort) only under an emergency level, max(5 GB, 3% of the
  disk) and never above the floor (`--json`: `emergencyGB`). Before, it did so as soon as free space stayed under the
  floor itself after the normal steps, so a disk a few GB under its floor cost running builds their `target/`;
  between the floor and the emergency level only idle output goes now.
- The disk keeper never deletes forever: its floor is min(`capacity.diskKeepGB`, 15% of the disk), so a setting
  near or above the disk's free space can no longer make it delete build folders on every run; it stops as soon as
  free space reaches the floor (no extra margin) and deletes idle folders oldest first. On Linux without `lsof` it
  reads working directories, open files and cargo processes from `/proc`, so a build folder in use is never deleted
  there either. `capacity.diskBuildTools` names a machine's own build-queue tools that count as using a folder.
- `state/disk-keep.pause` expires by itself after 2 hours without being touched, even if its pid is alive, and the
  keeper logs that cleaning resumed, so a forgotten pause no longer turns cleaning off for good.
- A jawan run whose harness already exited is never stopped as stalled: a supervisor starved by a busy machine
  could probe the finished process before handling its exit and record it stalled (or done, its error counted as a
  report) instead of retrying a rate limit or reporting its failure.
- A harness or API error line (`Error: 429 rate_limit_error`, `API Error: 500 ...`, `usage limit reached`) never
  counts as a jawan's report: a run that printed only such errors ends failed even on exit 0, and one that stalled
  with them is resumed instead of recorded done.
- A killed jawan whose shell harness exits 128 + n (`exit 143`) is recorded as killed by that signal (SIGTERM), as a
  harness that dies by the signal itself is.
- `bin/toli commit toli --merge <ref>` no longer moves the live runtime to the merge: the merged code has not passed
  `just check` yet, so the runtime stays on the previous commit and the commit says to run `just check`, then
  `bin/toli self sync`. Before, a merge put a machine's live session on code whose check had not run. Other commits
  still refresh the runtime themselves.
- The minute tick never waits on the disk keeper: under the floor it only starts the background keeper
  (`bin/toli disk keep`, detached, the same tiers and emergency rule) and goes on, and the tick's queue drain runs no
  keeper of its own. Before, the tick ran the keeper inline, and on an I/O-starved disk one run held the tick up for
  about an hour. Jawan starts still run it inline first.
- The disk keeper never touches a build folder in use while free space is over the emergency level (max(5 GB, 3% of
  the disk)): no wipe between build steps and no sweep of its old artifacts, even under the floor. Before, a sweep of
  artifacts unused for 180 min ran inside a `target/` whose build held cargo's lock, and a 54-minute build was lost.
  Under the emergency level the busy-target wipe, the sweep and the last resort run as before. The fallback sweep
  (free disk unreadable) skips targets in use too. `bin/toli disk keep --wait` is gone: the background keeper no
  longer waits to wipe busy targets, and a jawan start no longer starts one after its inline run.

## v0.3.1 - 2026-11-09

### Fixed

- A full disk means delete the build folders: when free space is still under `capacity.diskKeepGB` after the disk
  keeper's normal steps, it deletes every `target/` in the clones and task worktrees, in use or not, then
  `node_modules/`, `dist/` and Playwright's browser builds, logging each with what it freed (`--json`:
  `lastResort`). It still touches only git-ignored build output, never sources or `.git`. See docs/disk.md step 6.
- The disk keeper frees space while builds never stop: a cargo target whose lock is always held (jawans building
  the same clone back to back) was kept whole every run. It is now swept: artifacts in a profile's `deps`, `build`,
  `.fingerprint` and `incremental` unused for `capacity.diskSweepStaleMinutes` (default 180) go, judged by access
  time where the mount keeps it current (else modification time: `noatime`, Linux `relatime`, macOS without
  `strictatime`), never a cargo lock, anything newer or anything held open. Bytes freed are logged per target.
- `bin/toli disk keep` works on a full disk: it writes nothing before it has freed something (log lines wait in
  memory, an unwritable keeper lock is done without, Bun's transpiler cache is off for `bin/toli disk`), no failed
  write stops it, and when the keeper fails anyway a fallback sweeps stale artifacts and the command exits 1 with the
  reason instead of crashing. See docs/disk.md "On a full disk".
- `bin/toli commit --merge --resolved` checks a staged Cargo.lock with cargo in the staged tree (the private index's
  files), not the working tree, which lacks the crates a merge adds until it is committed (T617).
- `bin/toli commit` runs the project's `commit-msg` hook (`core.hooksPath` honoured) on toli's private index and
  refuses the commit when it rejects the message; a message the hook edits is committed as edited. Commits no longer
  skip message rules such as VelocityFSS's `Quality-change:` line. Pre-commit hooks stay skipped.
- `bin/toli commit --merge` takes a named, regenerated Cargo.lock or bun.lock when the clean merge leaves the lock
  stale (each side's text merged but missed entries both sides need); the named lock still goes through the lock
  checks (T650).
- `bin/toli commit --merge --resolved` accepts a conflict resolved by deletion (e.g. a rename/rename source): such a
  path is left deleted in the private index; any other absent path is refused with a clear message.
- The revert guard counts a pure addition as a revert only when it restores a removed line in the same place; adding
  that line back elsewhere is a new change.

## v0.3.0 - 2026-11-06

### Added

- Model tiers: every jawan runs on `light`, `standard` or `deep`, by default `claude-haiku-5-5`,
  `claude-sonnet-5-5` and `claude-opus-5-5` on omp and Claude Code (shipped in toli's code, so every machine has them
  after upgrade with no config; other harnesses keep their own default). Work picks the tier: `mechanical` light,
  `scout` and `ship` standard, `verify` and `release` deep. Precedence: `--model` > `spawn --tier` > the brief's
  `Tier:` line > the task's tier (`task add --tier`) > the work type (`--work`, new types `mechanical` and `release`,
  else the task's shape) > `harness.models` > the harness default. `harness.tiers` and `harness.workTiers` in
  config/machine.json override the tables (docs/harnesses.md "Model tiers").
- The tiers apply on every path: `bin/toli spawn` (queued starts and auto-resume keep the model), `bin/toli remote` /
  `remote auto` (`--tier` and `--work`, else the task's tier and shape, travel to the target, which resolves them with
  its own config; a `Tier:` line travels in the prompt) and scheduled headless jobs (`job add --tier`, else the
  shape). The toli-dispatch skill tells the lead to pass the tier's model to its own subagents.
- Limit fallback: a run that stops on a rate or usage limit (`429`, `rate_limit_error`, "usage limit") retries once,
  on `harness.fallback[<model>]` (same tier, another account or provider) when configured, else one tier lower but
  never below standard for ship, verify and release work, else on the same model after the reset the error names
  (spawned runs only, up to `harness.limitWaitMinutes`, default 300). The decision is logged and kept on the run as
  `fallback`.
- `bin/toli spawn --dry-run [--work w] [--tier t] [--brief f]` prints the harness, model, tier and what chose it.
- Runs record `tier` and `modelSource` beside `harness` and `model` (`bin/toli runs`, `run status`, inbox outcomes),
  and `usage` (tokens, cost) when the harness prints it. `bin/toli digest` shows "models today" and
  `bin/toli resources --json` carries the same per-model totals as `models`.

### Changed

- `harness.models` now applies only when neither a tier nor a work type picks the model: a spawn with `--work` or a
  task runs on its tier's model.
- `bin/toli exec` refuses a run when this machine's run slots are full or its free memory is under
  `minMemAvailableMB`, so a target named in `bin/toli remote` is not overloaded.
- `bin/toli spawn --task` refuses a second live jawan on the same task; `--replace` supersedes it.

### Fixed

- The disk keeper also never wipes a target while a cargo process runs in its workspace (`cargo test` between two
  test binaries), and a keeper waiting on a busy target re-reads `state/disk-keep.pause` before every try (from
  macminim4, merged with the process scan below).
- The SessionStart hook test clears `TOLI_ROLE` and `NO_MISTAKES_GATE` itself, so it passes when run inside a jawan.
- The disk keeper's process scan fails safe: a process of this user that lsof leaves out (common under load while it
  is exec'ing, such as a test binary cargo just started) is rechecked, read from `ps` (its program path), and otherwise
  counted as using the target, so a busy target is never wiped because the scan missed its user. The keeper tests'
  stand-in test binary is now a copy of bun: macOS launch constraints kill a copied `/bin/sleep`, which made them flaky.
- The disk keeper never wipes a build target a process uses (a test binary, a workspace's cwd, a build tool), beyond
  cargo's own lock.

## v0.2.5 - 2026-11-06

### Added

- Helpers take an optional `maxFiles` key in `helpers.json`: the open-files limit, soft and hard (launchd
  `NumberOfFiles`, systemd `LimitNOFILE`, crontab `ulimit -n`), for helpers that run builds, which outgrow launchd's
  default of 256.
- A long job can pause the disk keeper: it writes its pid (and an optional reason) to `state/disk-keep.pause`, and
  `bin/toli disk keep` deletes nothing while that pid is alive; a dead pid's file is stale and ignored
  (docs/disk.md). Other tools no longer need to hold the keeper's own `state/disk-keep.lock`.
- `bin/toli commit <p> --merge <ref> --resolved -m "..." -- <paths>` commits a merge whose conflicts were resolved in
  the working tree: every conflicted path must be named and free of conflict markers, and the usual checks (secrets,
  lock files, reverts, branch moved meanwhile) run on the result. A resolution keeping the ref's own change is not a
  revert; a hand-made undo of a recent branch commit still is. A conflicted merge without `--resolved` is refused
  with the conflicted paths and how to see them with conflict markers.

### Changed

- The disk keeper logs why it did not run (paused, another keeper busy) once when that starts, instead of a line
  every minute in `logs/disk.log`.
- `just release` refreshes this machine's installed runtime (`bin/toli self sync`) after the release, so the live
  session runs the release commit.
- Setup docs require git 2.38 or newer (`bin/toli commit --merge` uses `git merge-tree --write-tree`).

### Fixed

- `bin/toli commit --merge <ref>` no longer refuses a clean merge because the ref itself undoes a recent branch
  commit (such as upstream deleting a file the branch added); only changes made on top of the merge result count as
  reverts, so `--allow-revert` is needed only for those.
- Headless omp jawans (`bin/toli spawn`, `bin/toli exec`/`remote`, scheduled headless jobs) no longer exit while
  background work they started is still running: omp gets `--wait-async`, so a turn that ends while a `task`
  subagent, background build or poll is live waits for it and continues with its result, bounded by `--max-time`.
  Before, print mode ended at the first yield, cancelled that work and left edits uncommitted.
- `bin/toli` finds bun on its own (PATH, `~/.bun/bin`, `/opt/homebrew/bin`, `/usr/local/bin`), so
  `ssh host bin/toli ...` works from a non-login shell without bun on PATH.

## v0.2.4 - 2026-11-05

### Changed

- A `bin/toli remote` run now shows up on the machine it runs on: there it is recorded as a jawan run (task, project,
  log), so that machine's `bin/toli runs`, digest and jawan slots count it, it ends `done` or `failed` with the run,
  and `bin/toli run kill <id>` there stops it. The run id is printed in the saved output on the machine that sent it.

## v0.2.3 - 2026-11-05

### Added

- Time-limited jawan runs resume by themselves: a run stopped by its time limit without a report is recorded
  `time-limit` and continued with the same task, cwd, harness, model and limit, the brief plus a `RESUME (auto, N)`
  section, up to `capacity.autoResume` (default 3) times per chain; then an inbox item says the chain stopped. Every
  brief gains a Deadline section asking for the report 10 minutes before the limit.
- `bin/toli spawn` queues runs while `capacity.maxRuns` jawans run; queued runs start oldest first as runs finish and
  from the minute tick (`--now` bypasses the queue).
- The disk keeper: below `capacity.diskKeepGB` (default 60) `bin/toli disk keep`, run before every jawan start and
  tick, frees build output (idle checkouts' ignored `target/`, then `node_modules`/`dist`, docker prune, sccache over
  its cap, busy targets between build steps) until 20 GB above the floor. Low disk never stops work any more
  (`minDiskFreeGB` is gone). See docs/disk.md.
- `bin/toli remote ... --max-time <minutes>` (default 180, was a fixed hour).

### Changed

- Workers follow release tags: on a release install (detached at a `vX.Y.Z` tag) `bin/toli sync` runs
  `bin/toli upgrade` to the latest tag instead of `git pull`, so `bin/toli sync --all` after a release moves every
  worker to it. The coordinator, where toli is developed, stays on `develop` (docs/fleet.md).
- On macOS, task worktrees are excluded from Spotlight and Time Machine.

### Fixed

- The scheduled tick's PATH includes cargo, just and node, so jawans it starts from the queue can build.

## v0.2.2 - 2026-11-02

### Added

- `bin/toli commit <p> --merge <ref> -m "..."` writes a two-parent merge commit from the clean merge of `<ref>` into
  the branch tip (`git merge-tree`), with the usual checks (secrets, lock files, reverts, branch moved meanwhile). It
  refuses a conflicted merge, a ref already merged, local changes to the files the merge changes, and named paths
  the merge also changes; on success the merged files are checked out in the index and working tree.
- A push log: `bin/toli push` records every push that moves origin's branch in the pushing machine's
  `data/pushes.jsonl` (time, project, branch, old..new sha, issuing machine, task, the owner's quoted word via
  `--by`/`--for`/`--word`), and `bin/toli digest` lists the last week's under "recent pushes". A push run on one
  machine for another (over ssh, or through `bin/toli remote ... --task <id>`, whose `exec` hands the issuing machine
  and task to the run) no longer looks unexplained there. `bin/toli push-log add` records a raw `git push`;
  `bin/toli push-log list` shows the log. The toli-deliver skill and brief templates say how to use it.

### Fixed

- `bin/toli pr create` on GitLab passes `--head` to `glab mr create`, so the source project is looked up on the
  forge host (`forgeHost`, glab config) instead of the git remote's ssh host (`gitlab-ssh.*`).
- `bin/toli commit -m a -m b` keeps every `-m`, joined as paragraphs like `git commit`, instead of only the last.
- CI's coverage step passes again (it failed on v0.2.1 while every test passed): the jawan environment builder moved
  to `src/jawans/env.ts`, so its tests no longer load the outcome delivery code in-process.

## v0.2.1 - 2026-11-02

### Added

- `bin/toli doctor` on a worker reports results waiting in `state/outbox/` for the coordinator (count and age of the
  oldest), so a worker whose results stopped reaching the coordinator shows a warning instead of staying silent.

### Changed

- One code folder, one build folder (AGENTS.md hard rule 5): every jawan builds and tests in the checkout it works
  in, into its normal build folder; no private `CARGO_TARGET_DIR`, `/tmp` target, or scratch copy of the code. The
  brief and verify-brief templates and the dispatch skill say so, and `bin/toli spawn` starts jawans without an
  inherited `CARGO_TARGET_DIR`.
- Build jobs have one cap per machine, `capacity.cargoJobs` in `config/machine.json` (default half the cores):
  `bin/toli spawn` sets every jawan's `CARGO_BUILD_JOBS` to it (replacing any inherited value), `bin/toli doctor`
  warns when `~/.cargo/config.toml` `[build] jobs` differs, and the brief templates tell jawans never to pass `-j`,
  extra `RUSTFLAGS`, a profile or features in a shared build folder.

### Fixed

- The test suite removes the temporary directories its tests create once the run ends, instead of leaving them in
  the system temp folder.

## v0.2.0 - 2026-10-30

### Added

- Linux and WSL2 support: `bin/toli resources` reads load and memory from `/proc`; the minute tick and helpers run
  under systemd user timers when `systemctl --user` works, crontab otherwise (a leftover v0.1.0 crontab tick is
  removed and flagged); `just setup` gives apt/dnf hints. Supported: macOS, Debian/Ubuntu, Fedora, WSL2; native
  Windows is not.
- CI on `ubuntu-latest` and `macos-latest` running `just verify` (the gate plus smoke checks, with `install.sh`
  checked under dash and shellcheck) on every push and pull request to `main` and `develop`.
- A 3-day update check: toli compares its version with the latest release tag in the background (never blocking,
  silent offline), tells you once per version with its changelog, and upgrades only when you say so
  (`bin/toli update status|check|snooze <vX.Y.Z>|off|on`).
- `bin/toli project set <p> --branch <b>` switches a clean clone to the branch, or leaves it and prints the exact
  `git switch` command.
- Lint fails on an `await` of a non-promise (TS80007) and on a Mermaid block GitHub cannot parse.
- `bin/toli commit` is safe with many jawans in one clone (R23): it builds a private index from the branch tip,
  commits only the named paths and `--patch` hunks, moves the branch only if it has not moved (one retry from the new
  tip), and refuses a secret (gitleaks), a `Cargo.lock`/`bun.lock` that does not parse, a path that was not named, or
  an exact revert of one of the last 20 commits (`--allow-revert <sha>`). No worktrees or tree copies.
- The live session runs an installed runtime: `bin/toli self sync` snapshots HEAD under `~/.toli/runtime/`, proves
  it loads, and points `bin/toli` at it, so half-edited files in the checkout no longer break Sardar or the minute
  tick. `commit toli`, `sync` and `upgrade` refresh it; `self status` and `doctor` report it; `TOLI_DEV=1` runs the
  working tree.

### Changed

- Branch model: toli's own work lands on `develop`; `main` moves only at a release, when `just release` merges
  `develop` into it, tags it, and asks before pushing `main`, `develop` and the tag. A CHANGELOG section drafted on
  `develop` is kept and dated.
- Jawans edit toli in place on `develop` and land with `bin/toli commit toli`; no worktrees anywhere in toli's own
  flow, including temporary ones (AGENTS.md rule 4). `worktree-per-task` stays an opt-in project strategy.
- The digest's Next block names the remaining setup steps on a fresh install (a quiet line once setup is snoozed).
- The lead's guidance puts the 1-3 line reply rule first.

### Removed

- `bin/toli self prepare|list|land` and toli's self worktrees (`projects/.worktrees/toli/`).

### Fixed

- `migrate` moves `data/briefs/T<n>.md` to its task's project, as it does reports.
- The installer prints the resolved absolute install path.
- `tests/bitbucket.test.ts` awaited a non-promise (TS80007).
- `schedule install` and `helper install` run from toli's root no longer write bun's `bun-node-*` temp dir (gone
  after a reboot) into the tick's or a helper's bun path and PATH; `schedule status`, doctor and the setup checklist
  warn when the bun an installed tick runs no longer exists.

## v0.1.0 - 2026-10-30

### Added

- A lead agent ("Sardar" by default) that runs in the toli checkout, takes requests in chat, records each one as a
  task, and dispatches background worker agents ("jawans") to do the work; it never does project work itself.
- `bin/toli`: projects (`project add|list|set|setup|drop`), tasks, commits that stage only named paths and strip AI
  trailers, fixed working branches, forge delivery for GitHub, GitLab and Bitbucket (`push`, `pr create|status|merge`).
- Per-project data under `data/projects/<project>/` (notes, briefs, reports, runs, decisions) and a setup interview
  for each new project.
- Scheduled jobs (`job add|list|run-due|tick`, `schedule install`) that run headless and push results back into the
  chat through the inbox.
- Multi-machine fleets: `init`, `sync`, `resources`, `fleet status`, `pick`, `remote` dispatch to the least-busy
  machine.
- Any harness for the lead and jawans: omp, Claude Code, Codex, Cursor, Grok and pi (`spawn --harness`,
  `harness sync|status`, per-turn guidance).
- Memory with a token budget, dated entries, staleness checks and archive (`memory`, `prune`), plus `migrate` for
  older layouts.
- Private per-machine helpers in `local/` (`helper install|run|status`) that are never committed.
- Persona names from `config/persona.json` (defaults Malik, Sardar, jawan).
- `doctor`, `digest`, `wake`, `inbox` and `runs` for status at a glance.
- Repo quality: Biome, Prettier, Taplo, shfmt, shellcheck, actionlint, guards, git hooks, gitleaks and CI.
- `install.sh` one-line installer, `bin/toli version|upgrade`, and `just release` for tagged releases.
- Self-hosting: `bin/toli self prepare|list|land` develop toli in worktrees (`projects/.worktrees/toli/<T-id>`) and
  land them by fast-forward only after `just check` passes there, so the live checkout never holds half-edited code;
  the extension reports a failing CLI once per distinct error and points to `bin/toli doctor`.
- Needs-you queue: `task hold` takes 2-4 `--option "<choice> => <then>"`, `--recommend` and `--blocks`;
  `bin/toli needs [--json]` lists held tasks by project, blocking and oldest first, with reply hints; the digest
  opens with it, flags holds without a question, and re-surfaces stale holds once (`needs.staleDays`, default 7);
  `task answer` records options and the verbatim reply in `decisions.md` and prints `unblocked: dispatch T<n>`.
- Goal contracts: briefs carry a `## Goal` (Objective, Constraints, Validate, Stop when, Record, and a rule against
  weakening checks; a short form for scouts), verifiers check Stop when independently, and `spawn` warns on a ship
  brief without one.
- Lead guard compares symlink-resolved real paths and treats every project's real checkout (linked ones included) as
  project code, for reads and writes; `doctor` and `schedule status` warn when the machine's tick runs another toli
  checkout.
