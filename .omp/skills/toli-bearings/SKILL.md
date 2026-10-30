---
name: toli-bearings
description: Give Malik a status overview of this machine (or the whole paltan across the fleet) - projects, work in flight, questions waiting on him, job results, inbox, recent reports. Use for /bearings, at session start, or when Malik asks "what's going on", "status", "where are we", or "catch me up".
---

# Status overview (/bearings)

## Gather

    bin/toli digest --json

This one is fast and runs in Sardar's turn. On the coordinator (`config/machine.json` role `coordinator`), the
workers come from the fleet digest, which reaches every machine over ssh and can take minutes. Run it through `bash`
with `async: true` and `timeout: 0`, give the local overview now, and add the fleet part when its result arrives:

    bin/toli digest --json --fleet

The digest covers: machine, `needs` (the Needs-you queue: held tasks grouped by project, blocking and oldest first,
with question, options, recommendation, and age), projects (branch, fixed branch and any mismatch, dirty,
ahead/behind), backlog (in flight / queued), unseen job results, inbox from other machines, and recent reports. With
`--fleet` it also has `availability`: one entry per machine saying whether it is free for work and, if not, why
(load, memory, disk, runs, unreachable). If a worker is unreachable over ssh, say so in one line rather than
failing the whole overview.

## Plain digest (default)

Lead with what needs Malik, then what changed, then the rest. Translate everything into plain words:

    Ji Malik. Two things need you: <one line each>.
    Done since last time: <task, project, commit or report>.
    Running now: <task, project>.
    Job results: <job name - one-line outcome>.
    From other machines: <machine - title>.
    Machines: <free machines>; busy: <machine - reason in plain words>.
    Projects with uncommitted or unpushed work: <project - state>.
    Off their working branch: <project - on <current>, should be <fixed branch>>.

- The Needs-you queue becomes "needs your answer"; "queued" becomes "not started yet"; "inbox" becomes "from
  <machine>".
- Omit empty sections entirely.
- Keep it under about 15 lines. Offer detail instead of dumping it.
- Use the one-line titles and statuses the digest gives; to summarise a long job result or report, dispatch a
  `sonic` jawan rather than reading it yourself.
- Needs you: one line per held task (id, project, the question, the recommended option). With two or more, offer
  `/ahoy` to answer them together as one numbered list (`skill://toli-ahoy`). A question already raised this session
  and unchanged is counted ("2 questions still open"), not re-asked.
- A project off its fixed branch needs Malik: say how to switch back (or that he may want to change the configured
  branch) and never switch it yourself.
- This layout is also the while-you-were-away block (AGENTS.md section 1): after 30 or more minutes of silence from
  Malik, lead the next reply with its first three lines (needs you, done, running).
- In quiet mode (`state/quiet`), keep only what needs him, what finished, and failures.

## Lavish page (`/bearings lavish`)

When Malik passes `lavish`, or the digest is too large for chat (many projects or a full fleet), dispatch a jawan to
build a display page per `skill://toli-lavish`: one card per machine, a table of projects with git state, a backlog
board (needs you / running / not started / done), and job results with links to `data/jobs/<name>/<stamp>.md`. The
brief tells it to run `bin/toli digest --json --fleet` itself (or `--json` off the coordinator). Tell Malik the page
is coming and end the turn.

## After reporting

- Job results and inbox items stay in the digest until acknowledged. Once Malik has seen them in this overview, clear
  them:

        bin/toli job ack
        bin/toli inbox ack

    Only acknowledge what was actually shown to him.

- Never start new work from the overview alone; wait for Malik's word.
