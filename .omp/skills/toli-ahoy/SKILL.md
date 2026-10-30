---
name: toli-ahoy
description: Walk the user through the Needs-you queue (every held task waiting on their decision), collect the answers, record them verbatim, and dispatch the unblocked work. Use for /ahoy, when the user asks "what do you need from me" or "any questions", at session start when the digest's Needs you section is not empty, or after relaying results that added held tasks.
---

# The Needs-you queue (/ahoy)

Held tasks are the one source of truth for what waits on the user. Nothing else (chat memory, notes, a jawan's
report) counts as a pending question until it is a held task.

## Gather

    bin/toli needs --json

It lists every held task grouped by project, blocking and oldest first, with its question, options (each with what
happens next), the recommendation, what it blocks, its age, and a reply hint (`"T12: 2"`). `bin/toli needs` prints
the same as text. Also include any no-mistakes `ask-user` findings still parked in an active run (`skill://toli-nm`).

Nothing held: tell the user nothing is waiting on them, and stop.

## Fix a weak hold before asking

A hold with no question (the digest flags it as a bug), or a jawan's hold without options or a recommendation when
the answer is a choice, is not ready to ask. Re-hold it with the full format from the jawan's report:

    bin/toli task hold T<n> --question "<one crisp question>" \
        --option "<choice> => <what happens then>" --option "<choice> => <what happens then>" \
        --recommend <n> --blocks "<what waits on it>"

If the report does not say enough, ask its jawan (`write agent://<id>`) or dispatch a `sonic` jawan to draft it;
never read project code yourself.

## Ask, batched

All open questions go out in one message, never one at a time across turns:

    Two things need you:
    1. T7 (billing-api) Retry cap: (1) 3 tries => ships today; (2) back off up to 2 min => one more day. I'd pick 1.
       Blocks: the billing release.
    2. T9 (web) Drop the stale feature flag? (1) yes => removed in this task; (2) no => stays. I'd pick 1.
    Reply like "T7: 1, T9: 2", or in your own words.

- One question: plain chat, same shape.
- Two or more: one numbered list like the above. A lavish `input` page (`skill://toli-lavish`) only when the user
  prefers pages (`data/preferences.md`) or asks for one, or for many questions with options that need weighing.
- A hold marked STALE (unanswered for `needs.staleDays` days, default 7; the digest re-surfaces it once) is asked
  once more with "or drop it" as an option. If it is ignored again, leave it held and do not keep raising it.
- Relay no-mistakes `ask-user` findings verbatim (id, file, full description); never paraphrase them.
- Raise the queue at session start, right after relaying results that added held tasks, and when the user asks. Never
  repeat it every turn; a question already asked stays in the queue until answered.

## Record answers and dispatch at once

For each answer, record the user's words exactly:

    bin/toli task answer T<n> "<the user's words>"

It writes the question, options, and answer to `data/projects/<project>/decisions.md` and prints
`unblocked: dispatch T<n> ...`. Dispatch it in the same turn through `skill://toli-dispatch`: add the answer to the
saved brief (`data/projects/<project>/briefs/T<n>.md`) and re-spawn, or dispatch a gate jawan to respond to the
no-mistakes gate (`skill://toli-nm`). A task the user says to abandon is dropped:

    bin/toli task drop T<n>

A skipped question stays held; say so in the summary.

## Close

One short summary: which tasks are moving again, which stay held, which were dropped.
