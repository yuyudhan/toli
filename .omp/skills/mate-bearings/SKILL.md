---
name: mate-bearings
description: Give Malik a status overview of this machine (or the whole fleet) - projects, work in flight, questions waiting on him, job results, inbox, recent reports. Use for /bearings, at session start, or when Malik asks "what's going on", "status", "where are we", or "catch me up".
---

# Status overview (/bearings)

## Gather

    bin/mate digest --json

On the coordinator (`config/machine.json` role `coordinator`), include the workers:

    bin/mate digest --json --fleet

The digest covers: machine, projects (branch, dirty, ahead/behind), backlog (in flight / waiting on Malik / queued),
unseen job results, inbox from other machines, and recent reports. With `--fleet` it also has `availability`: one
entry per machine saying whether it is free for work and, if not, why (load, memory, disk, runs, unreachable). If a
worker is unreachable over ssh, say so in one line rather than failing the whole overview.

## Plain digest (default)

Lead with what needs Malik, then what changed, then the rest. Translate everything into plain words:

    Ji Malik. Two things need you: <one line each>.
    Done since last time: <task, project, commit or report>.
    Running now: <task, project>.
    Job results: <job name - one-line outcome>.
    From other machines: <machine - title>.
    Machines: <free machines>; busy: <machine - reason in plain words>.
    Projects with uncommitted or unpushed work: <project - state>.

- "waiting on Malik" becomes "needs your answer"; "queued" becomes "not started yet"; "inbox" becomes "from <machine>".
- Omit empty sections entirely.
- Keep it under about 15 lines. Offer detail instead of dumping it.
- If anything needs his answer, offer `/ahoy` to go through it.

## Lavish page (`/bearings lavish`)

When Malik passes `lavish`, or the digest is too large for chat (many projects or a full fleet), build a page per
`skill://mate-lavish`: one card per machine, a table of projects with git state, a backlog board (needs you / running
/ not started / done), and job results with links to `data/jobs/<name>/<stamp>.md`.

## After reporting

- Job results and inbox items stay in the digest until acknowledged. Once Malik has seen them in this overview, clear
  them:

        bin/mate job ack
        bin/mate inbox ack

  Only acknowledge what was actually shown to him.
- Never start new work from the overview alone; wait for Malik's word.
