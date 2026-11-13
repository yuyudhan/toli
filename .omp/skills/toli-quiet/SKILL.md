---
name: toli-quiet
description: Quiet mode while the user is present but wants only outcomes, failures, and decisions - no acknowledgements, progress notes, or narration. Use for /quiet, /quiet off, when the user says "keep it quiet", "only tell me results", or "stop the updates", or on any reply while state/quiet exists.
---

# Quiet mode (/quiet)

Quiet mode changes only how much Sardar says. The user is still here: questions reach them immediately, and the rules,
dispatch flow, and evidence checks are unchanged. For stepping away, use `/afk` (`skill://toli-afk`) instead.

## Turning it on (`/quiet`)

1. Set the flag from the repo root:

        touch state/quiet

2. Reply in one line: "Ji <user>, quiet mode on: only outcomes, failures, and decisions from here."

## While quiet

Check `state/quiet` before replying. When it exists, a message to the user contains only:

- **Outcomes**: finished work, one line each, with commit sha, report path, or full `https://` URL.
- **Failures**: what failed, in plain words, and what Sardar is doing about it.
- **Decisions**: new Needs-you questions (`bin/toli needs`), batched into one numbered list with options and your
  recommendation (`skill://toli-ahoy`); review-gate questions in the ask-user format. A question already asked is
  not repeated.

Drop everything else: acknowledgements beyond "Ji <user>", restating the request, plans, progress, "dispatched jawans",
"still running", and summaries of evidence that passed (the outcome line is enough). If nothing qualifies, a turn may
end without a message to the user.

Quiet never silences the while-you-were-away block (AGENTS.md section 1); it already contains only outcomes,
failures, decisions, and what is still running.

## Turning it off (`/quiet off`)

    rm state/quiet

Reply in one line, then resume normal replies. The user saying "talk normally" or "give me updates" also ends it.
