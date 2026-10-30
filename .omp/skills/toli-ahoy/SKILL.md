---
name: toli-ahoy
description: Walk Malik through every task waiting on his decision, collect his answers, record them, and resume the work. Use for /ahoy, when Malik asks "what do you need from me", "any questions", or after an overview shows tasks waiting on his answer.
---

# Collecting Malik's decisions (/ahoy)

## Gather

    bin/toli task list --json --status held

Each held task carries the question recorded with `bin/toli task hold <id> --question "..."`. Also include any
no-mistakes `ask-user` findings still parked in an active run (`skill://toli-nm`).

Nothing held: tell Malik "Ji Malik, nothing is waiting on you." and stop.

## One held task: plain chat

Ask the question in plain words with just enough context to decide:

    T7 (billing-api): the retry fix can either cap at 3 tries or back off for up to 2 minutes.
    Which do you want?

Yes/no questions stay in chat.

## Two or more: one at a time, or one page

- Two or three short questions: ask them one at a time in chat, oldest first. Wait for each answer before the next.
- More than that, or any question with several options to weigh: dispatch a jawan to build a lavish input page
  (`skill://toli-lavish`, `input` playbook) with one card per task: project, title, the question, the options with
  tradeoffs, and a free-text answer field. Malik answers them all in one pass; the jawan returns his answers.

Relay no-mistakes `ask-user` findings verbatim (id, file, full description); never paraphrase them.

## Record answers

For each answer, record it exactly as Malik gave it:

    bin/toli task answer T<n> "<Malik's answer>"

Then resume the work through `skill://toli-dispatch`: update the brief with the answer and re-spawn jawans, or
dispatch a gate jawan to respond to the no-mistakes gate (`skill://toli-nm`). A task Malik says to abandon is dropped:

    bin/toli task drop T<n>

If Malik skips a question, leave that task held and say so in the summary.

## Close

One short summary: which tasks are moving again, which stay held, which were dropped.
