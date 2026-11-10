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

Every 15 seconds the service makes one pass:

1. When an interactive lead session is live on this machine (`state/session.json`, registered by the omp extension,
   or a `lead attach` in progress), the service does nothing: that session takes the wakes itself, as before.
2. Otherwise it takes the new wake items (`bin/toli wake`: inbox items such as delegations, delegated-task results,
   messages from other leads and finished jawans, plus job results) exactly once, and runs one headless turn of the
   lead conversation (`omp -p --resume <the conversation>`) with the wake message, the lead guidance, and the
   headless rules: dispatch only with `bin/toli spawn` (it returns at once; the result comes back as a wake), never
   ask questions (holds go to the Needs-you queue), never wait for jawans.
3. A turn that fails keeps its wake text in `state/lead/pending.md`; the next pass sends it again with any newer
   items. The last turn's output is in `logs/lead.log`.
4. Every `lead.balanceMinutes` (default 30) it compares queues across the fleet (below) and posts an offer or an ask.

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
other: short messages, ssh-delivered, queued in `state/outbox/` and retried by the minute tick while the other
machine is unreachable.

## Delegation

    bin/toli delegate <machine> "<task title>" --brief <file> [--project <p>] [--note "<words>"] [--for T<n>]
                      [--shape ship|scout] [--tier light|standard|deep]

`delegate` hands one task to another machine's lead. Over ssh it runs `bin/toli delegation receive` there with the
title, brief text, project, note, shape, tier and its own name. The receiving machine:

- adds the task to its own backlog as an ordinary task (its own next `T<n>`), owned by it, with
  `delegatedBy: { machine, task?, id, at }`, under the given project or, without `--project`, under `toli`; the brief
  is saved as `data/projects/<p>/briefs/T<n>.md`;
- posts `delegated T<n> from <machine>: <title>` to its own inbox, which wakes its lead;
- answers with the fleet id `<owner>/T<n>`, which `delegate` prints. With `--for T<n>`, this machine's own task
  records it (`delegatedTo`) and counts as active with the fleet id as its jawan, so oversight does not call it stale.

The receiving lead dispatches its own jawans for the task as for any task (`task start`, `spawn --task`). A project
not cloned there is its lead's to clone: the task's notes name `bin/toli project ensure <p> <url>` with the URL the
delegator knows. Each delegation carries an id (`<from>-<timestamp>`); a
repeat of the same id returns the task already created, so a retried delivery never makes two tasks, and so does a
delegation of the same title for the same `--for` task while an earlier one is still open (a copy queued for the tick
that lands after a retry went through). When the target is unreachable, the delegation waits in `state/outbox/` and
the minute tick retries it; when it lands, the fleet id arrives here as a wake.

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
words over ssh to the owner's `task answer`, which releases the task and wakes the owner's lead, who resumes the work
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

    bin/toli fleet queues [--json]       # every machine's queue, shortest first
    bin/toli pick [--project <p>] [--json]

Each machine publishes its queue in `bin/toli resources --json` (`queue`: queued, active and held tasks, and
running and queued jawan runs). The queue depth is queued + active tasks plus queued jawan runs. `pick` and
`fleet queues` rank machines by queue depth, shortest first; on equal depth a machine with the project's clone wins,
then this machine, then name order. CPU load, memory and disk are shown for information and are never a reason to
pass a machine over: a machine busy with builds but with an empty queue gets work first. Only an unreachable machine,
or one without the project's clone when its URL is unknown here, is left out.

Balancing between leads: every `lead.balanceMinutes` the lead service compares queue depths. When this machine's
depth is at least `lead.balanceGap` (default 3) above the shortest queue, it wakes its own lead with an offer
(`delegate queued work to <machine>`); when this machine's queue is empty and another's is at least the gap deep, it
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
