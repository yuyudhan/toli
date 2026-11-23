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

1. One claim on the inbox at a time, so two Sardars never act on the same items: a headless turn in progress (its
   pid in `state/lead/state.json`), else the live interactive lead session (`state/session.json`, registered by the
   omp extension), else a `lead attach` in progress. Each counts only while its pid is alive, and whichever starts
   first holds it. A turn's pid counts only while it can still be the process the record named: one ps does not list
   (on Linux a thread's id answers a liveness probe) or that started after `state/lead/state.json` was last written
   (a reboot gave the pid to another program) is gone. The next pass clears such a record, with a line in
   `logs/lead.log` (`lead turn record named pid ..., which no longer runs: cleared`); until then it holds nothing, so
   neither the session's `toli wake` nor a headless turn waits on it. While a session or attach holds it the service
   does nothing: that session takes the wakes itself, as before. The record belongs to the first live session:
   another interactive omp started in toli's root (a jawan driving `omp` in tmux, a second terminal) neither replaces
   it nor removes it when it exits, and takes no wakes (`toli wake --pid`), and the extension re-registers every
   minute, so a record lost any other way comes back while the lead runs. A session opened while a headless turn runs
   takes no wake until that turn ends. A live session holds the inbox however long it leaves its wakes unread (an omp
   left open for days, one sitting at a permission prompt): no headless turn ever runs beside it. Once an inbox item
   or job result has stayed unacknowledged for `lead.idleSessionMinutes` (default 60) after it arrived and after the
   session registered, the digest (`idle session: ...`) and doctor (`lead-session`) flag it until the session
   acknowledges its wakes or closes, and the tick (`bin/toli job tick`) runs due jobs headless instead of leaving them
   to it. It is the user's session: toli never stops it.
   A session whose extension has not even taken a wake (inbox items and job results above its delivered marks in
   `state/acks.json`) for `lead.silentSessionMinutes` (default 20) after the oldest arrived is silent: not busy with a
   long turn but deaf to its inbox. `lead status` shows it on a `silent:` line (its pid, the minutes without a take,
   how many wait and since when; `silent` in `--json`), and on a worker the minute tick sends the coordinator one
   inbox item per episode, `Sardar on <machine> silent N min, M wakes pending`; on the coordinator it is logged in
   `logs/tick.log`. The episode ends when the session takes a wake or closes; the next silence alerts again. Wakes
   reach the session by polling (the extension runs `toli wake` on its tick), never by a file watch, so a lost
   inotify watch cannot silence it.
2. Otherwise it takes the new wake items (`bin/toli wake`: inbox items such as delegations, delegated-task results,
   messages from other leads and finished jawans, plus job results) exactly once, and runs one headless turn of the
   lead conversation (`omp -p --resume <the conversation>`) with the wake message, the lead guidance, and the
   headless rules: dispatch only with `bin/toli spawn` (it returns at once; the result comes back as a wake), never
   ask questions (holds go to the Needs-you queue), never wait for jawans.
3. A turn that fails keeps its wake text in `state/lead/pending.md`; the next pass sends it again with any newer
   items. The last turn's output is in `logs/lead.log`. When omp cannot resume the conversation because the model it
   is pinned to is gone (`SessionModelRestoreError: Could not restore model ...`), the conversation file moves to
   `state/lead/sessions/retired/` and the same wake runs at once in a fresh conversation on the configured omp model
   (`harness.models.omp`, else omp's default), with a line in `logs/lead.log` saying so.
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

### A Sardar session that grows too big

An interactive session left open for days keeps its whole conversation in memory, and a machine that runs out ends
it in the out-of-memory killer (the kernel's or earlyoom), which takes other processes with it. The minute tick reads
the live session's resident memory (`/proc/<pid>/status` on Linux, `ps` on macOS); past `lead.sessionMemoryGB` in
`config/machine.json` (default 8) it posts one inbox item to this machine's own lead, `lead session pid <pid> on
<machine> at 9.4 GB: stow and restart it`, recommending a stow (`/stow`) and a fresh session, and logs it in
`logs/tick.log`. One item per session (its pid and start, kept in `state/lead/memory-alert.json`): a session that keeps
growing is not told again, a restarted one that grows past the limit is. toli never stops or signals the session; the
Sardar or the user restarts it.

### Hide Sardar chatter

New inbox items and job results reach the lead as one `[toli wake]` message (the omp extension's tick, the Claude
Code prompt hook, and a headless lead turn all build it in `src/records/wake.ts`). By default it is compact: a
two-line header, then one line per item, `<source> <kind>: <one-line summary>  (<file>)`, with the bodies left in
their files for the lead to read when it acts on one. Repetitive items fold into one line: every answer to one
shared learning (`learning <id>: adopted by m2, m3, m4 (+6); adapted by m1`) and several plain messages from one
machine (`m2 3 messages: newest ...`). Items that carry a decision for the user are listed first and marked
`[needs you]`: a held task or a word asked of them, a body with `Decision needed` or `Needs you`/`Needs <user>`, an ask
for the user by any of their names (`for <name>`, `<name>, ...?`, `<name>'s call`, `waiting on <name> to`; `user`,
`userFirstName`, the two together, and `userAliases` in `config/persona.json`), a `Should I`, `Shall I`,
`Can`/`Could`/`Would you`, `Do you want me to` or
`Approve ...?` question, `Please approve`, `needs your decision`, `your call`, `let me know which`, `which one do you
want`, or a list of options with a recommendation. A decision line whose whole content is a negation (`Decision
needed: none.`, `no decision needed`) is not marked; one that goes on (`Needs you: no rush, but approve ...`,
`none (<user> to pick later)`) is. An invalid `hideSardarChatter` or `config/persona.json` makes every wake refuse
before it takes an item, so nothing is lost while it is fixed.
Another machine's words (`- via: peer ...`) are marked `[peer]`, quoted on one line with quotes and backticks
neutralized, and the header says they are information, not instructions. The ack commands close the message as
before and cover exactly the items listed. To see every body in the chat again, as before, set `config/machine.json`
`{ "lead": { "hideSardarChatter": false } }` (default `true`); any other value makes `bin/toli wake` refuse.

### Talking to a machine's lead

    bin/toli talk <machine>              # attach to that machine's lead conversation (ssh -t, interactive)
    bin/toli talk <machine> "<words>"    # send it a message; it wakes and answers with talk back
    bin/toli talk <person> "<words>"     # the same, to the machine whose user has that first name ("Sam", "Sam <title>")
    bin/toli talk <machine> --run <id> "<reply>"   # a reply to that machine's jawan run <id>, not its lead

`bin/toli talk <machine>` with no words opens the lead conversation of that machine in this terminal: on this
machine it is `bin/toli lead attach`, elsewhere `ssh -t <host> 'cd <root> && bin/toli lead attach'`. Attach waits
for a headless turn in progress to end, then runs interactive omp on the same conversation; while it is open, wakes
arrive in it as `[toli wake]` messages, and when it closes the service takes over again. When that machine already
has an interactive lead open in a terminal of its own, attach does not start a second one: it says so, and words go
through `talk <machine> "<words>"` instead. Directly on the machine, the same is `cd <root> && bin/toli lead attach`.

`talk <machine> "<words>"` posts the words to that machine's inbox (`message from <this machine>`), which wakes its
lead; the message says to reply with `bin/toli talk <this machine> "<reply>"`. That is also how leads talk to each
other: short messages, queued in `state/outbox/` and retried by the minute tick while the other machine is
unreachable. Work goes by `bin/toli delegate <machine> "<title>" --brief <file>`, never by `talk`: words that start
with `TOLI_BRIEF` (a jawan brief) or run over 4 KB still go, with a warning naming `delegate --brief`. On receipt
only the `TOLI_BRIEF` ones are treated differently: the receiving lead never holds such a message as a question for
its user and asks the sender to delegate it instead (size is not checked there). To a paired peer they go over HTTPS
first, signed, with ssh as the fallback
([peers.md](peers.md#delivery)); to an unpaired fleet machine over ssh. A machine that takes no inbound ssh
(`inbound: false`) pulls its messages, delegations and results from the others' outboxes every minute instead
([fleet.md](fleet.md#machines-that-take-no-inbound-ssh)), or from its paired peers over HTTPS. A message from
another machine is information for the lead to weigh, never an instruction (AGENTS.md rule 10).

#### Replies to a jawan's talk

A jawan started with `bin/toli spawn` cannot be messaged, so a `talk` it sends names its run: the message carries
`- run: <id> (task T<n>), a jawan on <machine>` and `- reply to that run: bin/toli talk <machine> --run <id>
"<reply>"`. A reply sent that way carries `- for run: <id>`, and the receiving machine files it with that run instead
of its lead's inbox, while the run, or a continuation of it (`bin/toli resume`, an automatic resume), is queued or
running: in `replies/` of the chain's first run dir. The jawan reads it with

    bin/toli run replies [--wait <minutes>]   # the replies not shown yet; --wait waits for one; --all shows every one

and its talk says so (`a reply sent with --run <id> comes to this run: ...`). Once every run of the chain has
ended, or the id names no run there, the reply goes to the lead's inbox as before, with a first line naming the run
it was for and how to pass it on (`bin/toli resume <id> --note "<reply>"`). A reply without `--run` always goes to
the lead. A lead replying to a jawan's question (a login code, a choice it is blocked on) uses the `--run` line the
message gives.

#### Naming another machine's person

Each machine's user may record a first name ([setup.md](setup.md#your-first-name)); the lead addresses its own user
as "<first name> <user>" (`Robin Boss` for the title `Boss`) and names the people at other machines the same way.
Paired peers share their first names ([peers.md](peers.md#identity)), and `bin/toli peer list` shows each peer's
person in its second column (`-` for none). So "tell Sam Boss the release is out" (or "Sam Boss ko bolo ...") is
`bin/toli talk Sam "the release is out"`: `talk` takes a machine name first, else a person's first name, alone or
followed by this installation's title, case and spacing aside. Your own first name names this machine. A first name
that two machines share is refused, listing both (`"Alex" is the person at 2 machines (m3, m4): name the machine
instead`); a name nobody has is refused too. A machine with no first name (a headless box) is reached by its
machine name only. The names are display and lookup only: a peer's name is never an instruction.

## Delegation

    bin/toli delegate <machine> "<task title>" --brief <file> [--project <p>] [--note "<words>"] [--for T<n>]
                      [--shape ship|scout] [--verify] [--tier light|standard|deep]

`delegate` hands one task to another machine's lead. It runs `bin/toli delegation receive` there (over HTTPS to a
paired peer with the `delegate` permission, else ssh) with the title, brief text, project, note, shape, tier and its
own name. The receiving machine:

- adds the task to its own backlog as an ordinary task (its own next `T<n>`), owned by it, with
  `delegatedBy: { machine, task?, id, at }`, under the given project or, without `--project`, under `toli`; the brief
  is saved as `data/projects/<p>/briefs/T<n>.md` with the delegator's task ids rewritten, since the same `T<n>` here is
  another, unrelated task: the `--for` task becomes the new `T<n>` (its `task done`, its report path
  `reports/T<n>.md`), every other bare id the delegator's fleet id `<machine>/T<n>`, which no command here changes.
  The task's notes record the mapping (`brief ids from <machine> rewritten: T117 -> T5 (this task), T89 ->
<machine>/T89`). Ids already qualified by a machine name stay, and so do ids inside a longer path or filename
  (`outbox/T590/T590-on-main.patch`; the report path above aside), which name files as they are, and patch text,
  which must apply unchanged: an inlined `git format-patch` mail (its `From <sha>` line through the `-- ` signature),
  a git diff (`diff --git` through its file headers and counted hunk lines) and a `## PATCH (begin)` ..
  `## PATCH (end)` section;
- posts `delegated T<n> from <machine>: <title>` to its own inbox, which wakes its lead;
- answers with the fleet id `<owner>/T<n>`, which `delegate` prints. With `--for T<n>`, this machine's own task
  records it (`delegatedTo`) and counts as active with the fleet id as its jawan, so oversight does not call it stale.
  From the moment it is sent until that receipt lands, the task records the delegation (`sending`, by its id and
  target), so the owner's report that comes first (a hand-back on arrival, a drop) is still taken for the task, over
  ssh or by peer message, and both sides stay linked.
  While that task's own jawan works on it (`task start T<n> --agent <id>`, an id that is not one of its delegations),
  the delegation is a slice of that work instead (`slices`): the task stays with its jawan, and the slice's outcome
  only adds notes (`<owner>/T<n> is done`, its commit and report path) and wakes this lead; it never changes the
  task's status. `task link` follows the same rule.
- with `--verify` (verify work, ship shape), takes it even for a project it marked verify-only (below).

The receiving lead dispatches its own jawans for the task as for any task (`task start`, `spawn --task`). A project
not cloned there is its lead's to clone: the task's notes name `bin/toli project ensure <p> <url>` with the URL the
delegator knows. Each delegation carries an id (`<from>-<timestamp>`, new on every `delegate` run); a
repeat of the same id returns the task already created, so a retried delivery never makes two tasks. So does the same
work under a new id while the first task is still open: the same delegator, `--for` task, project, title and brief
(a lead that ran `delegate` again), or the same title for the same `--for` task (a copy queued for the tick that lands
after a retry went through). When the target is unreachable, the delegation waits in `state/outbox/` and the minute
tick retries it; running `delegate` again for the same work then queues no second copy. When it lands, the fleet id
arrives here as a wake. A title over 191 characters or a delegation over 256 KiB (the receiver's limits,
[peers.md](peers.md)) fails here before anything is sent or queued. A refusal by the receiver is final: `delegate`
prints only `not sent: <machine> refused it: <reason>`, keeps the item in `state/outbox/cancelled/` and exits
non-zero; nothing waits for the tick.

### Results and questions go back

A delegated task reports to its delegator by itself, and its delegator's `--for` task follows it. Whenever the
owner's task changes status, question, notes, commit or report, the owner sends the task as it is now to the
delegating machine (`bin/toli delegation update` there, through the outbox, so an unreachable delegator gets it from
the owner's minute tick). Each update carries the whole task, so a new one replaces the one still queued for that
machine: however long the delegator is away, one update per task waits for it. The delegator writes it back onto the
`--for` task: the owner's new notes are appended as `<owner>/T<n>: <note>`, its state is kept under `delegates`, and
once a delegation finishes with every other one not dropped done too, the task is done, with that commit and the
report saved in `data/reports/delegated/<owner>-T<n>.md` (all dropped: dropped). A dropped delegation never marks the
task done: with the rest done, the task stays as it is for its lead. A repeat of an update (the owner's `updatedAt` is
no newer) is applied once and wakes no one again.

A new outcome (done, held, dropped) also wakes the delegating lead with `<owner>/T<n> <status>: <title>`, the notes,
commit, report text (truncated) and, for a hold, the question and its options. **The delegating lead answers its
delegated work's questions itself**: `bin/toli task answer <owner>/T<n> "<answer>"` from any machine forwards the
words to the owner's `task answer` (an `answer` outbox item, over HTTPS or ssh). Only the machine that delegated the
task (or one above it, for work forwarded on) may answer it, and only the task's owner may send its updates: anything
else is refused there. The answer releases the task and wakes the owner's lead, who resumes the work at once. An
answer that reaches the owner after it took the hold up again itself (the task is no longer held) is never refused or
dropped: it becomes a note on the task and an inbox item (`answer from <machine> for T<n> (<status>)`) that wakes the
owner's lead, which passes it to the jawan. An answer reaches the owner once: its item carries its id, and the owner
drops a copy it already applied (a delivery retried after its exit or receipt was lost; an owner on an older toli
refuses the id, so the answer goes to it the old way, without that guard). The delegator sends one
answer per question: a second `task answer` before the owner reports again is refused, as is any answer to a task the
owner reported done or dropped, and an answer still queued when that report lands is cancelled
(`state/outbox/cancelled/`). An answer that never arrives (refused by the owner, `outbox cancel`, `outbox expire`)
leaves its question open for a new one. A task the owner takes up again reports a new state, so its new question
takes a new answer. A question only the user can decide (push, merge, release, money, security, a destructive step,
his taste) goes to him: `bin/toli task escalate <owner>/T<n>` holds the `--for` task with `<owner>/T<n> asks:
<question>` and its options, so it sits in this machine's Needs-you queue; his `task answer T<n> "<words>"` there is
recorded here and forwarded to the owner too, unless the owner already reported the task done or dropped.

### Questions for the user

A question that asks for the user's word never waits in the inbox alone: the receiving lead's toli puts it in its
Needs-you queue (`bin/toli needs`) on arrival. It asks for his word when it says so (`<name>'s word`, `question for
<name>`, `needs his word`, `word needed`, `Reply <option>` with a quoted option, a number or yes/no), or, in a peer
message, when it is in toli's own hold format (a `## Question` section, a `task hold ... --question` line), unless
it only quotes the hold template: no real option of any kind, and its question itself a placeholder
(`task hold <T-id> --question "<plain words>" --option "<choice> => <what happens then>"`, instructions quoted from
a brief). Placeholder options are never options, and a quoted template line is cut from a held question's text. A
peer message that starts with `TOLI_BRIEF` (after a part marker such as `1/3`) is a jawan brief and never asks. In
a peer message a phrase asks only in a paragraph that is a question (has a `?`), a quoted `Reply '<x>'` asks only
when the message offers 2-4 options (`Reply 2`, `Reply yes`, `Reply no` still ask), and a phrase citing his word as
authority never asks: `on <name>'s word`, `act on <name>'s word`, `<name>'s word (2026-11-18): '...'` quoting him,
`questions for <name> go to <machine>`. A lead relaying his instructions or the fleet's rules asks him nothing, and a
peer's rule or FYI that asks only for an acknowledgement (`Reply 'ack camera' after your next jawan run has it`) is
the receiving Sardar's to record, apply and acknowledge with `talk`, never a Needs-you hold. Once this machine knows
its user's names (a first name or aliases in config/persona.json), a peer message addressed `question for <name>` to
someone else (a cc of another machine's question) is information and never held, and `<name>'s word` (`<name>'s word
needed` too) for someone else asks nothing; `question for <his name>` still holds. With no first name or alias set,
any capitalized name still counts as his.

- A delegated task's held question that asks for his word is escalated at once, as `task escalate` would: the `--for`
  task is held with `<owner>/T<n> asks: <question>` and its options. When there is no `--for` task (or it is done,
  dropped, or held for something else), a new held task in its project (else the owner's, see below) carries the
  question; either way his `task answer` goes to the owner too. A task that only carries the question is done once he
  answers it, and closes by itself (done, or dropped with the owner's task) once the owner's task no longer asks it.
- A peer message (`talk`, any message another machine sends to the inbox) becomes a new held task in the sender's
  project: the first registered project the words name (four characters or more), else the project of the newest
  task here delegated to or by that machine, else the only project here. The question is the message's words (its
  `## Question` section when it has one); options are parsed when present (`--option "a => b"`, `1. a => b` lines,
  `(1) ... (2) ...`, `Reply X to Y`, `yes/no`), with the sender's pick (`Recommended: x`, `my pick`) and what it
  blocks (`Blocks: x`, `(blocks x)`, `blocking x`). After his answer, reply with `bin/toli talk <sender> "<answer>"`
  (the task's note says so). With no project to put it in, the message stays in the inbox and the delivery says so.

Each sender's question is held once (`state/word-holds.json`, kept 60 days): a reminder repeating it, or the same
question after his `task answer`, holds nothing new. The minute tick also reads the `message from <machine>` items
that arrived since it first looked (state/word-holds.json `since`, at most a day back), are not acknowledged
(`inbox ack`) and it has not read yet, and holds those that ask for his word, except one this machine already
answered with a `talk` reply to that machine quoting it (the first 60 characters of its question; sent talks are
kept in `state/talk-sent.jsonl`). What was already in the inbox at its first look (an upgrade) is never held.

A delegation made without `--for` is attached later with `bin/toli task link T<n> <owner>/T<n>`: the owner's task
then names this task as its delegator and sends its current state back at once. The owner refuses a link from any
machine other than the one that delegated its task (`T<n> was delegated by <machine>, not <sender>`).

**Handing work back.** A lead that cannot take delegated work (overloaded, project not cloneable, wrong machine)
gives it back with `bin/toli task handback T<n> --reason "<why>"`, never `task drop`: its task is dropped there, and
the delegator's `--for` task goes back to queued with `<owner>/T<n> handed the work back: <why>` in its notes and a
`<owner>/T<n> handed back` wake, so its lead delegates it to another Sardar or dispatches it itself. This holds for
work forwarded on too: when the live owner hands it back, the originator's task is queued again, not dropped by the
forwarder's earlier drop. `task drop` means the work itself is given up, and drops the `--for` task once every
delegation of it is dropped. Delegating or linking for a done or dropped task reopens it (`reopened (was dropped)` in
its notes); a dropped delegation never keeps the `--for` task from being done by the others.

**Forwarding work on.** A lead that hands delegated work on to a third Sardar, rather than giving it back, delegates
it with `--for` its own task (or links it with `task link`): `bin/toli delegate <machine> "<title>" --brief <file>
--for T<n>`. The delegation then carries the chain above it (`upstream`, origin first), and the new task reports to
every machine in that chain, not only to the lead that forwarded it: each `--for` task up the chain records the new
owner (`<forwarder>/T<n> forwarded the work to <owner>/T<n>` in its notes, which become its `delegatedTo` and its
jawan) and follows its done, held and handed-back reports, and any machine in the chain may answer its question.
The forwarding lead may then drop its own copy: while a delegation it made is live, that drop reads
`<forwarder>/T<n> forwarded to <owner>/T<n>` above it, never "dropped", and the originator's task stays active with
the new owner. A delegation made while the task's own jawan works on it is a slice and carries no chain. A slice
says so (`slice` on the new task's `delegatedBy`), and work it forwards on carries no chain either: the slice's
delegator follows the slice's task, never the machine it forwarded to. A machine in the chain that records no
delegation to the new task refuses its report (`no delegation of T<n> to <owner>/T<n> is recorded here`); the first
such refusal stops that task's reports to it (`refusedBy`, and a note `... no longer reports to <machine>`) with one
"not sent" inbox item, and later status changes send it nothing.

### Holds on a worker reach the coordinator

A held task is a question for the user, and he talks to the coordinator, not to every worker. Each minute tick on a
worker sends its own held tasks (none delegated to it) to the coordinator, through the outbox like a delegated task's
update: there each is held once as `<worker>/T<n> asks: <question>`, with its options, in the worker's project, so it
is in the coordinator's Needs-you queue within a tick (and a pull, for a coordinator that takes no inbound ssh). His
`task answer T<n>` there is done at once and goes to the worker's task, as does `task answer <worker>/T<n>`; the
worker takes an answer from its coordinator for its own tasks as from a delegator. Once the worker's task is no
longer held with that question (answered on either machine, dropped, re-held with another), its next tick sends the
task as it is and the coordinator's copy closes: done, or dropped with it. What was sent is kept in
`state/raised-holds.json`.

A delegated task is never sent: its hold goes to its delegator, as above. A delegator that is a worker sends on its
own held `--for` task (or the task holding the question) the same way, so the user sees the question once, at the
coordinator, and his answer goes down the chain. A hold whose question came from the coordinator itself (`heldFrom` a
coordinator task) is not sent back to it, and a delegated task's question for its delegating Sardar, not for the user,
never reaches him.

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
    bin/toli lead decline [<project> [--clear]] [--json]
    bin/toli pick [--project <p>] [--shape ship|scout] [--json]

Each machine publishes its queue in `bin/toli resources --json` (`queue`: queued, active and held tasks, `slotWaits`,
running jawans, queued jawan runs, and `full` when its lead is full). The queue depth is queued tasks waiting for a
jawan plus tasks parked with `task wait` for a free slot here (`slotWaits`: the `--on` grammar in
[fleet.md](fleet.md#oversight), "Waits on a free slot are queue") plus
running jawans plus queued jawan runs. Running jawans are `bin/toli spawn` runs holding a slot and native harness
subagents (omp `task`, Claude Code `Agent`) recorded with `bin/toli task start T<n> --agent <id>` that are running now
(they report running, docs/harnesses.md "Jawan slots"): one per distinct agent id on an active task, unless a live
spawn run works on that task (then only the run counts). A queued task a
run already works on, or one delegated to another machine and still open there, is not counted again; active tasks
with no jawan here (a lead's bookkeeping, work delegated elsewhere, a task waiting with `task wait` on anything but a
free slot here) and held tasks are not queue. A machine on an older toli publishes no `slotWaits`; its depth stands as
it reported it. `pick` and
`fleet queues` rank machines by depth per jawan slot (`capacity.maxRuns`), lightest first; on equal load a machine
with the project's clone wins, then this machine, then name order. CPU load, memory and disk are shown for
information and are never a reason to pass a machine over: a machine busy with builds but with an empty queue gets
work first. Left out: an unreachable machine, a full one (below), one that declines the project (below), one without
the project's clone when its URL is unknown here, or, for ship work, one that marked the project verify-only (below).

**A full machine.** A lead whose machine cannot take more (builds killed for memory, a long job running) says so:
`bin/toli lead full --reason "<why>" [--until 30m|2h|<ISO time>]`, ended by `--until` or `bin/toli lead full
--clear` (`--status` shows it). `bin/toli task handback T<n> --reason "<why>" --full` hands work back and marks the
machine full for two hours. While full, `pick` and every other lead's balancing pass it over (no offers go to it,
no work is asked of it), `fleet queues` shows `full: <why>`, and it asks no one for work itself; it may still offer
its own queued work away.

**A verify-only machine.** A lead whose machine only reviews a project's work, and no longer builds or ships it, marks
that project there: `bin/toli project set <p> --role verify-only` (`--role full` undoes it). Each lead sets its own
machine's roles; the setting travels with its resources. `pick --project <p>`, `fleet queues` and the balancing
offers then pass it over for ship work of that project (scout and verify work still go to it), `delegate` refuses
ship work of it there naming the next machine by queue (`--force` sends it anyway), and so does a lead forwarding a
delegated task on. Verify work goes with `--verify` (`bin/toli delegate <machine> "Verify ..." --brief <file>
--project <p> --for T<n> --verify`): a title alone never marks it. A ship delegation that reaches it anyway is handed
back on arrival with the reason, and the originator's task is queued again. Details:
[projects.md](projects.md#verify-only-machines).

**A machine that declines a project.** A lead whose machine takes no work of a project at all (the user keeps it for
other work, such as a release rail, whether or not it has the clone) says so on that machine: `bin/toli lead decline
<p>` (`bin/toli lead decline <p> --clear` undoes it; `bin/toli lead decline` lists them). Each lead sets only its own
machine's list, kept as `lead.declines` in its `config/machine.json` and published with its queue (`queue.declines`
in `resources --json`, beside `full`). `pick --project <p>` then passes it over for every shape (ship, scout and
verify work alike), the other leads' balancing offers never list a task of that project for it (an offer goes to
the next machine that takes it, or none is posted), `fleet queues` shows `declines <p>`, and its own ask for work
names the projects it declines. Unlike verify-only, this needs no registered project there.

Balancing between leads: every `lead.balanceMinutes` the lead service compares queue depths. When this machine's
depth is at least `lead.balanceGap` (default 3) above the shortest queue, it wakes its own lead with an offer
(`delegate queued work to <machine>`, listing only queued tasks and slot waits no jawan works on, no other machine
has, and that
machine can take: not delegated here by another machine (the balancer never bounces work or delegates it on, so
verify work that machine delegated never goes back to it), not pinned here, not of a project that machine declines
(above), and of a project that machine has a
clone of: the `projects` its `resources --json` publishes, so a machine that registered only some projects is only
offered those (`pick` and `delegate` still accept a project whose git URL is registered here). Each listed command
ends in `--for T<n>`, so taking it marks the local task delegated away: it leaves this machine's queue and its
`fleet check` waiting work. The offer goes to the
first machine, lightest queue first, still at least the gap below this one that can take some queued task; a full
one never gets it (above). When no queued task can move, no offer is posted. An offer is posted once per change:
the same task set offered to the same machine as last time is not posted again (`offered` in
`state/lead/balance.json`), so a declined offer does not come back every period; a task added, picked up or pinned
changes the set. When this machine's queue is empty and another's is at least the gap deep, it
asks that machine's lead for work (a `talk` message naming its empty queue), once per period. Thresholds live in
`config/machine.json`:

```json
{ "lead": { "balanceMinutes": 30, "balanceGap": 3 } }
```

A task that must stay on this machine (it needs code or state only this clone has, or works on this machine's own
branch, such as merging main into it or pushing it) is pinned: `bin/toli task pin T<n> [--reason "..."]` (`task unpin
T<n>` releases it). A pinned or delegated-in task still counts toward the queue depth but is never listed in an offer;
when no queued task is left to offer, no offer is posted. `task list` and the
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
...`, `killed by the kernel OOM killer`) or else the signal (`killed by SIGKILL`), and the log tail. `bin/toli spawn`
returns only once systemd-run has moved the supervisor into its scope, so a caller that is itself a systemd unit (a
helper's oneshot, a scheduled job) can exit right away without systemd killing the supervisor with its cgroup; a
supervisor scope systemd-run cannot make fails the spawn and the run is recorded failed. Without
systemd-run or a user manager both start as before, in the lead service's cgroup, and a harness scope systemd-run cannot
make (no user session bus over ssh) starts the harness without one. The unit is `KillMode=control-group`: stopping it
(`systemctl --user stop toli-lead.service`, `lead uninstall`) ends `lead run` and everything left in its cgroup (a
headless turn's omp and what it started, the peer listener), so a stopped lead never wakes again to start work.
A restart (`lead install`, the loop exiting for a newer runtime) ends the same; a turn it ends leaves its wake in
`state/lead/pending.md` for the next pass. `lead install` run inside a headless turn (`bin/toli upgrade` from the
lead) only reloads the unit and never restarts its own service; the loop exits after that turn on the newer runtime,
and systemd starts it on the new unit. On macOS the
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
