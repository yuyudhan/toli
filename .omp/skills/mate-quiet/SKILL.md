---
name: mate-quiet
description: Quiet mode while Malik is present but wants only outcomes, failures, and decisions - no acknowledgements, progress notes, or narration. Use for /quiet, /quiet off, when Malik says "keep it quiet", "only tell me results", or "stop the updates", or on any reply while state/quiet exists.
---

# Quiet mode (/quiet)

Quiet mode changes only how much mate says. Malik is still here: questions reach him immediately, and the rules,
dispatch flow, and evidence checks are unchanged. For stepping away, use `/afk` (`skill://mate-afk`) instead.

## Turning it on (`/quiet`)

1. Set the flag from the repo root:

        touch state/quiet

2. Reply in one line: "Ji Malik, quiet mode on: only outcomes, failures, and decisions from here."

## While quiet

Check `state/quiet` before replying. When it exists, a message to Malik contains only:

- **Outcomes**: finished work, one line each, with commit sha, report path, or full `https://` URL.
- **Failures**: what failed, in plain words, and what mate is doing about it.
- **Decisions**: a question that needs his answer, in the ask-user format when it comes from a review gate.

Drop everything else: acknowledgements beyond "Ji Malik", restating the request, plans, progress, "dispatched crew",
"still running", and summaries of evidence that passed (the outcome line is enough). If nothing qualifies, a turn may
end without a message to Malik.

Quiet never silences the while-you-were-away block (AGENTS.md section 1); it already contains only outcomes,
failures, decisions, and what is still running.

## Turning it off (`/quiet off`)

    rm state/quiet

Reply in one line, then resume normal replies. Malik saying "talk normally" or "give me updates" also ends it.
