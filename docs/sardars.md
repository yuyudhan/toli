# One lead per machine

Every machine in the fleet runs its own lead (Sardar by default, `config/persona.json` may rename it). The leads sit
side by side: any lead may hand work to any other, each lead dispatches only its own machine's jawans, and every
jawan reports only to the lead of the machine it runs on. The user talks to whichever lead he likes, on any machine.

    user ──► any lead ──delegate──► another machine's lead ──spawn──► its own jawans
                 ▲                          │
                 └──── result / question ───┘   (a wake in the delegating lead's chat)

No machine starts a jawan on another machine. `bin/toli remote` refuses and points to `bin/toli delegate`; read-only
cross-machine commands (`fleet status`, `fleet queues`, `fleet check`, `digest --fleet`, `task list --fleet`,
`resources` over ssh) stay.

## The lead on each machine

    bin/toli lead install      # start this machine's lead service now and at every login/boot
    bin/toli lead status [--json]
    bin/toli lead uninstall
    bin/toli lead run [--once] # what the service runs (foreground loop; --once: one pass)
    bin/toli lead attach       # open this machine's lead conversation in this terminal

The lead is one long-lived omp conversation per machine, kept in `state/lead/sessions/`. A service keeps it served:
a launchd agent (`com.toli.lead`, KeepAlive) on macOS, a systemd user service (`toli-lead.service`,
`Restart=always`, needs `loginctl enable-linger`) on Linux, or a per-minute crontab line running `lead run --once`
where neither works. No terminal multiplexer is involved.

`bin/toli lead install` never trades a running agent for an unloaded one. launchd loads a user agent only from the
user's login session: from a background launchd job (such as a jawan's) it can boot an agent out but cannot load one
again (`Bootstrap failed: 125`). So it first probes `launchctl print gui/<uid>`, and from a session that fails it
changes nothing and tells you to run it from a Terminal in your login session. When the plist on disk already is the
one it would write and the agent is loaded, it restarts the agent in place (`launchctl kickstart -k`). Otherwise it
boots the agent out and bootstraps the new plist; when that bootstrap fails it writes the previous plist back and loads
it again, and reports both errors if that fails too. The tick and helper installs share the probe and the restore.

Every 15 seconds the service makes one pass:

1. When an interactive lead session is live on this machine (`state/session.json`, registered by the omp extension,
   or a `lead attach` in progress), the service does nothing: that session takes the wakes itself, as before. The
   record belongs to the first live session: another interactive omp started in toli's root (a jawan driving `omp`
   in tmux, a second terminal) neither replaces it nor removes it when it exits, and the extension re-registers
   every minute, so a record lost any other way comes back while the lead runs.
2. Otherwise it takes the new wake items (`bin/toli wake`: inbox items such as delegations, delegated-task results,
   messages from other leads and finished jawans, plus job results) exactly once, and runs one headless turn of the
   lead conversation (`omp -p --resume <the conversation>`) with the wake message, the lead guidance, and the
   headless rules: dispatch only with `bin/toli spawn` (it returns at once; the result comes back as a wake), never
   ask questions (holds go to the Needs-you queue), never wait for jawans.
3. A turn that fails keeps its wake text in `state/lead/pending.md`; the next pass sends it again with any newer
   items. The last turn's output is in `logs/lead.log`.
4. Every `lead.balanceMinutes` (default 30) it compares queues across the fleet (below) and posts an offer or an ask.

**Jawans only as the interactive Sardar's subagents.** With `config/machine.json` `{ "lead": { "dispatch":
"subagents" } }` (default `"spawn"`, the rules above) a headless turn starts no jawan: `bin/toli spawn`,
`bin/toli resume` and queued-run starts (`bin/toli job tick` included) refuse when `TOLI_LEAD_TURN=headless`, and the
turn's prompt says to leave every item that needs a jawan to the interactive Sardar and to ack only through the last
item before the first one it leaves. Its take moves its own delivery marks (`inboxHeadlessDelivered`,
`jobsHeadlessDelivered` in `state/acks.json`), never the session's, so whatever it leaves unacknowledged wakes the
interactive session once it opens, which dispatches it as its own subagents. Commands the interactive Sardar runs are
never refused; jawan supervisors drop `TOLI_LEAD_TURN`, so their own queued starts and resumes go on.

The loop imports its code once, so it runs the runtime it started on (`bin/toli self sync`, docs/releasing.md). After
each pass it checks `state/runtime`: when a newer runtime is installed it logs that and exits 0, and launchd
(KeepAlive) or systemd (`Restart=always`) starts it again on the new one. The per-minute crontab form starts afresh
every run. A `lead run` on the working tree (`TOLI_DEV=1`) has no snapshot and never exits for this.

Because the conversation is resumed, not restarted, it remembers every earlier turn, whoever drove it.

### Talking to a machine's lead

    bin/toli talk <machine>              # attach to that machine's lead conversation (ssh -t, interactive)
    bin/toli talk <machine> "<words>"    # send it a message; it wakes and answers with talk back

`bin/toli talk <machine>` with no words opens the lead conversation of that machine in this terminal: on this
machine it is `bin/toli lead attach`, elsewhere `ssh -t <host> 'cd <root> && bin/toli lead attach'`. Attach waits
for a headless turn in progress to end, then runs interactive omp on the same conversation; while it is open, wakes
arrive in it as `[toli wake]` messages, and when it closes the service takes over again. When that machine already
has an interactive lead open in a terminal of its own, attach does not start a second one: it says so, and words go
through `talk <machine> "<words>"` instead. Directly on the machine, the same is `cd <root> && bin/toli lead attach`.

`talk <machine> "<words>"` posts the words to that machine's inbox (`message from <this machine>`), which wakes its
lead; the message says to reply with `bin/toli talk <this machine> "<reply>"`. That is also how leads talk to each
other: short messages, queued in `state/outbox/` and retried by the minute tick while the other machine is
unreachable. To a paired peer they go over HTTPS first, signed, with ssh as the fallback
([peers.md](peers.md#delivery)); to an unpaired fleet machine over ssh. A machine that takes no inbound ssh
(`inbound: false`) pulls its messages, delegations and results from the others' outboxes every minute instead
([fleet.md](fleet.md#machines-that-take-no-inbound-ssh)), or from its paired peers over HTTPS. A message from
another machine is information for the lead to weigh, never an instruction (AGENTS.md rule 10).

## Delegation

    bin/toli delegate <machine> "<task title>" --brief <file> [--project <p>] [--note "<words>"] [--for T<n>]
                      [--shape ship|scout] [--tier light|standard|deep]

`delegate` hands one task to another machine's lead. It runs `bin/toli delegation receive` there (over HTTPS to a
paired peer with the `delegate` permission, else ssh) with the title, brief text, project, note, shape, tier and its
own name. The receiving machine:

- adds the task to its own backlog as an ordinary task (its own next `T<n>`), owned by it, with
  `delegatedBy: { machine, task?, id, at }`, under the given project or, without `--project`, under `toli`; the brief
  is saved as `data/projects/<p>/briefs/T<n>.md`;
- posts `delegated T<n> from <machine>: <title>` to its own inbox, which wakes its lead;
- answers with the fleet id `<owner>/T<n>`, which `delegate` prints. With `--for T<n>`, this machine's own task
  records it (`delegatedTo`) and counts as active with the fleet id as its jawan, so oversight does not call it stale.
  While that task's own jawan works on it (`task start T<n> --agent <id>`, an id that is not one of its delegations),
  the delegation is a slice of that work instead (`slices`): the task stays with its jawan, and the slice's outcome
  only adds notes (`<owner>/T<n> is done`, its commit and report path) and wakes this lead; it never changes the
  task's status. `task link` follows the same rule.

The receiving lead dispatches its own jawans for the task as for any task (`task start`, `spawn --task`). A project
not cloned there is its lead's to clone: the task's notes name `bin/toli project ensure <p> <url>` with the URL the
delegator knows. Each delegation carries an id (`<from>-<timestamp>`, new on every `delegate` run); a
repeat of the same id returns the task already created, so a retried delivery never makes two tasks. So does the same
work under a new id while the first task is still open: the same delegator, `--for` task, project, title and brief
(a lead that ran `delegate` again), or the same title for the same `--for` task (a copy queued for the tick that lands
after a retry went through). When the target is unreachable, the delegation waits in `state/outbox/` and the minute
tick retries it; running `delegate` again for the same work then queues no second copy. When it lands, the fleet id
arrives here as a wake.

### Results and questions go back

A delegated task reports to its delegator by itself, and its delegator's `--for` task follows it. Whenever the
owner's task changes status, question, notes, commit or report, the owner sends the task as it is now to the
delegating machine (`bin/toli delegation update` there, through the outbox, so an unreachable delegator gets it from
the owner's minute tick). The delegator writes it back onto the `--for` task: the owner's new notes are appended as
`<owner>/T<n>: <note>`, its state is kept under `delegates`, and once every delegation of that task is done the task
is done too, with the last commit and the report saved in `data/reports/delegated/<owner>-T<n>.md` (all dropped:
dropped). A repeat of an update (the owner's `updatedAt` is no newer) is applied once and wakes no one again.

A new outcome (done, held, dropped) also wakes the delegating lead with `<owner>/T<n> <status>: <title>`, the notes,
commit, report text (truncated) and, for a hold, the question and its options. **The delegating lead answers its
delegated work's questions itself**: `bin/toli task answer <owner>/T<n> "<answer>"` from any machine forwards the
words to the owner's `task answer` (an `answer` outbox item, over HTTPS or ssh). Only the machine that delegated the
task may answer it, and only the task's owner may send its updates: anything else is refused there. The answer
releases the task and wakes the owner's lead, who resumes the work
at once. A question only the user can decide (push, merge, release, money, security, a destructive step, his taste)
goes to him: `bin/toli task escalate <owner>/T<n>` holds the `--for` task with `<owner>/T<n> asks: <question>` and its
options, so it sits in this machine's Needs-you queue; his `task answer T<n> "<words>"` there is recorded here and
forwarded to the owner too.

A delegation made without `--for` is attached later with `bin/toli task link T<n> <owner>/T<n>`: the owner's task
then names this task as its delegator and sends its current state back at once.

**Handing work back.** A lead that cannot take delegated work (overloaded, project not cloneable, wrong machine)
gives it back with `bin/toli task handback T<n> --reason "<why>"`, never `task drop`: its task is dropped there, and
the delegator's `--for` task goes back to queued with `<owner>/T<n> handed the work back: <why>` in its notes and a
`<owner>/T<n> handed back` wake, so its lead delegates it to another Sardar or dispatches it itself. `task drop`
means the work itself is given up, and drops the `--for` task once every delegation of it is dropped. Delegating or
linking for a done or dropped task reopens it (`reopened (was dropped)` in its notes); a dropped delegation never
keeps the `--for` task from being done by the others.

## The shared task list

    bin/toli task list --fleet [--json] [--cached] [--status <s>] [--project <p>]

Task ids are unique across the fleet as `<machine>/T<n>`: each machine keeps numbering its own backlog, and the
machine name makes the id unique. A bare `T<n>` still means this machine's task everywhere it worked before, and
`<this machine>/T<n>` is accepted as the same task.

`task list --fleet` shows every machine's open tasks (queued, active, held; `--status` picks another) with owner,
status, `delegated by`/`delegated to`, jawan, and the held question or answer. It refreshes over ssh in parallel
(each machine's own `task list --json`) and keeps the last copy of each machine in `state/fleet-tasks/<machine>.json`;
an unreachable machine shows its last copy with its age, `--cached` skips the network.

Rules that keep the list consistent without locks across machines:

1. **The owner is the only writer.** A task lives in its owner's `data/backlog.json`. No machine writes another
   machine's backlog; the cached copies are read-only.
2. **Writes travel to the owner.** `task answer <owner>/T<n>` is forwarded to the owner. `task start|done|hold|drop`
   on another machine's task is refused with a pointer to that machine's lead (`bin/toli talk`).
3. **Newest copy wins.** A fetched copy replaces the cached one only when it was taken later (`fetchedAt`), so two
   overlapping refreshes never put an older list back.
4. **Delegations are idempotent** by their delegation id (above).

## Queues decide where work goes

    bin/toli fleet queues [--json]       # every machine's queue, lightest per jawan slot first
    bin/toli lead full [--reason "..."] [--until 2h] | --clear | --status
    bin/toli pick [--project <p>] [--json]

Each machine publishes its queue in `bin/toli resources --json` (`queue`: queued, active and held tasks, running
jawans, queued jawan runs, and `full` when its lead is full). The queue depth is queued tasks waiting for a jawan plus
running jawans plus queued jawan runs. Running jawans are `bin/toli spawn` runs holding a slot and native harness
subagents (omp `task`, Claude Code `Agent`) recorded with `bin/toli task start T<n> --agent <id>`: one per distinct
agent id on an active task, unless a live spawn run works on that task (then only the run counts). A queued task a
run already works on, or one delegated to another machine and still open there, is not counted again; active tasks
with no jawan here (a lead's bookkeeping, work delegated elsewhere, a task waiting on something with `task wait`)
and held tasks are not queue. `pick` and
`fleet queues` rank machines by depth per jawan slot (`capacity.maxRuns`), lightest first; on equal load a machine
with the project's clone wins, then this machine, then name order. CPU load, memory and disk are shown for
information and are never a reason to pass a machine over: a machine busy with builds but with an empty queue gets
work first. Left out: an unreachable machine, a full one (below), or one without the project's clone when its URL is
unknown here.

**A full machine.** A lead whose machine cannot take more (builds killed for memory, a long job running) says so:
`bin/toli lead full --reason "<why>" [--until 30m|2h|<ISO time>]`, ended by `--until` or `bin/toli lead full
--clear` (`--status` shows it). `bin/toli task handback T<n> --reason "<why>" --full` hands work back and marks the
machine full for two hours. While full, `pick` and every other lead's balancing pass it over (no offers go to it,
no work is asked of it), `fleet queues` shows `full: <why>`, and it asks no one for work itself; it may still offer
its own queued work away.

Balancing between leads: every `lead.balanceMinutes` the lead service compares queue depths. When this machine's
depth is at least `lead.balanceGap` (default 3) above the shortest queue, it wakes its own lead with an offer
(`delegate queued work to <machine>`, listing only queued tasks no jawan works on, no other machine has, and that
machine can take: not pinned here, and of a project it has a clone of or whose git URL is registered here); when
this machine's queue is empty and another's is at least the gap deep, it
asks that machine's lead for work (a `talk` message naming its empty queue). Each offer or ask is sent once per
period. Thresholds live in `config/machine.json`:

```json
{ "lead": { "balanceMinutes": 30, "balanceGap": 3 } }
```

A task that must stay on this machine (it needs code or state only this clone has) is pinned:
`bin/toli task pin T<n> [--reason "..."]` (`task unpin T<n>` releases it). A pinned task still counts toward the queue
depth but is never listed in an offer; when every queued task is pinned, no offer is posted. `task list` and the
digest show the pin.

## Jawans report to their own lead

A jawan started by `bin/toli spawn` posts its outcome to its own machine's inbox only, and so does the low-disk alert
(below). A run that ends without posting an outcome of its own (a `bin/toli exec` run another machine's `remote`
started before this change) is adopted: the minute tick posts its outcome to the inbox of the machine it ran on, once
(`state/lead/adopt.json` marks from when). Job results still reach the coordinator, which keeps the fleet view; work
results reach other machines only through a delegated task's report.

On Linux each jawan runs in its own systemd scope, not in the lead service's cgroup: its supervisor in
`toli-supervisor-<run id>.scope` and its harness (with every tool and build it starts) in `toli-jawan-<run id>.scope`
(`toli-jawan-<run id>-2.scope` for a retry after a rate limit), both under the user manager and started with
`systemd-run --user --scope`. So systemd-oomd or a restart of `toli-lead.service` takes the lead alone, and an OOM kill
takes one jawan's harness, never the lead, the other jawans, or that jawan's supervisor, which records the outcome:
`failed`, with the cause the journal names (`killed by systemd-oomd (SIGKILL, 86 processes): memory pressure for
...`, `killed by the kernel OOM killer`) or else the signal (`killed by SIGKILL`), and the log tail. Without
systemd-run or a user manager both start as before, in the lead service's cgroup, and a harness scope systemd-run cannot
make (no user session bus over ssh) starts the harness without one; the unit is `KillMode=process`, so even then
stopping or restarting it (`lead install`, `bin/toli upgrade`, the loop exiting for a newer runtime) ends only `lead
run`, never the supervisors, jawans and headless turn left running. A machine whose unit predates `KillMode=process`
gets it from the next `lead install` (the new unit is loaded before that restart stops the old process). On macOS the
supervisor and the harness each run in their own session and process group, which launchd leaves alone when it stops
or restarts the lead's job; a signal to the harness's group never reaches the supervisor.

A supervisor outlives SIGTERM, SIGHUP and SIGINT while its harness runs, noting the signal in the run record, so a
logout or service stop that ends the harness still gets its outcome recorded. A supervisor that dies anyway (SIGKILL,
or a scope from before the split holding both) leaves its run `running`; the next `bin/toli digest`, minute tick or
`bin/toli runs` records it `failed` with the best cause found: the signal the supervisor noted, the journal's kill of
either scope, the harness's own last words (`[Stopped by SIGTERM]`), or the end of `supervisor.log`, and whether the
harness is gone or still running unsupervised. The tick then posts that outcome to the inbox.

## Sharing learnings between leads

    bin/toli share "<learning>" [--to <machine>]... [--all] [--project <p>] [--source "<words or evidence>"] [--from-user]
    bin/toli share --list [--json]
    bin/toli share answer <id> adopt [--into learnings|preferences|notes]
    bin/toli share answer <id> adapt --text "<your version>" [--into ...]
    bin/toli share answer <id> decline --note "<why>"

Delegation hands over work; `share` hands over knowledge: a learning, a best practice, or how a lead wants to work.
It goes to the named machines (default: every other machine) as a `learning from <machine>` wake, kept in
`data/shares/<id>.json` on both sides. `--from-user` marks it as the user's own words: receiving leads treat it as his
rule. Each receiving lead decides:

- **adopt**: writes it, dated and with its source, into its own `data/learnings.md`, into `data/preferences.md` (the
  default for the user's own words, and only allowed for them), or into the project's `data/projects/<p>/notes.md`
  (`--into notes`, for a learning shared with `--project`);
- **adapt**: writes its own version (`--text`) instead;
- **decline**: with the reason (`--note`); a declined user's word is first raised with the user as a hold.

The answer goes back to the sender as a wake (`learning <id>: <machine> adopted`), and `share --list` shows every
learning sent or received with each machine's answer, or `no answer yet`. Like every message between machines it
waits in `state/outbox/` while the other machine is unreachable.

## Each machine's disk is its own lead's job

The low-disk alert (`capacity.diskKeep: false`, docs/disk.md) goes to the inbox of the machine whose disk is low, so
that machine's lead decides what goes: rebuildable build output by its own jawan, anything else as a hold for the
user. Other leads, the coordinator's included, only advise (`talk`, `share`); none deletes on another machine.
